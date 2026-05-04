import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const DOCUMENT_TABLE = process.env.DOCUMENT_TABLE!;
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET!;
const URL_EXPIRY_SECONDS = 900;

const respond = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const presignDownload = async (uri: string): Promise<string> => {
  const key = uri.replace(/^s3:\/\/[^/]+\//, '');
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: PROCESSED_BUCKET, Key: key }), { expiresIn: URL_EXPIRY_SECONDS });
};

const listDocuments = async (event: Parameters<APIGatewayProxyHandlerV2>[0]) => {
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(Number(qs.limit) || 25, 100);
  const nextToken = qs.nextToken ? JSON.parse(Buffer.from(qs.nextToken, 'base64url').toString()) : undefined;

  const filterCount = [qs.status, qs.documentType, qs.vendorName].filter(Boolean).length;
  if (filterCount > 1) {
    return respond(400, { error: 'VALIDATION_ERROR', message: 'Provide at most one of: status, documentType, vendorName' });
  }

  let params: Record<string, unknown>;

  if (qs.status) {
    params = {
      TableName: DOCUMENT_TABLE, IndexName: 'ByStatus', Limit: limit, ExclusiveStartKey: nextToken,
      KeyConditionExpression: '#s = :s' + dateRangeExpr(qs, 'uploadedAt'),
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': qs.status, ...dateRangeValues(qs) },
    };
  } else if (qs.documentType) {
    params = {
      TableName: DOCUMENT_TABLE, IndexName: 'ByType', Limit: limit, ExclusiveStartKey: nextToken,
      KeyConditionExpression: 'documentType = :dt' + dateRangeExpr(qs, 'documentDate'),
      ExpressionAttributeValues: { ':dt': qs.documentType, ...dateRangeValues(qs) },
    };
  } else if (qs.vendorName) {
    params = {
      TableName: DOCUMENT_TABLE, IndexName: 'ByVendor', Limit: limit, ExclusiveStartKey: nextToken,
      KeyConditionExpression: 'vendorName = :vn' + dateRangeExpr(qs, 'documentDate'),
      ExpressionAttributeValues: { ':vn': qs.vendorName, ...dateRangeValues(qs) },
    };
  } else {
    params = { TableName: DOCUMENT_TABLE, Limit: limit, ExclusiveStartKey: nextToken };
    const result = await ddb.send(new ScanCommand(params as any));
    return respond(200, {
      documents: result.Items ?? [],
      nextToken: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : null,
      count: result.Items?.length ?? 0,
    });
  }

  const result = await ddb.send(new QueryCommand(params as any));
  return respond(200, {
    documents: result.Items ?? [],
    nextToken: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : null,
    count: result.Items?.length ?? 0,
  });
};

const dateRangeExpr = (qs: Record<string, string | undefined>, sortKey: string): string => {
  if (qs.startDate && qs.endDate) return ` AND ${sortKey} BETWEEN :start AND :end`;
  if (qs.startDate) return ` AND ${sortKey} >= :start`;
  if (qs.endDate) return ` AND ${sortKey} <= :end`;
  return '';
};

const dateRangeValues = (qs: Record<string, string | undefined>): Record<string, string> => {
  const vals: Record<string, string> = {};
  if (qs.startDate) vals[':start'] = qs.startDate;
  if (qs.endDate) vals[':end'] = qs.endDate;
  return vals;
};

const getDocument = async (id: string) => {
  const result = await ddb.send(new GetCommand({ TableName: DOCUMENT_TABLE, Key: { documentId: id } }));
  if (!result.Item) return respond(404, { error: 'NOT_FOUND', message: 'Document not found' });

  const doc = result.Item;
  const downloadUrls = {
    original: doc.originalUri ? await presignDownload(doc.originalUri) : null,
    convertedPdf: doc.convertedPdfUri ? await presignDownload(doc.convertedPdfUri) : null,
    extractedText: doc.extractedTextUri ? await presignDownload(doc.extractedTextUri) : null,
  };

  return respond(200, { ...doc, downloadUrls });
};

const patchDocument = async (id: string, event: Parameters<APIGatewayProxyHandlerV2>[0]) => {
  const body = JSON.parse(event.body ?? '{}');
  const { status, documentType, reviewNotes } = body;

  if (!status && !documentType && reviewNotes === undefined) {
    return respond(400, { error: 'VALIDATION_ERROR', message: 'Provide at least one of: status, documentType, reviewNotes' });
  }

  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const parts: string[] = [];

  if (status) { names['#s'] = 'status'; values[':s'] = status; parts.push('#s = :s'); }
  if (documentType) { names['#dt'] = 'documentType'; values[':dt'] = documentType; parts.push('#dt = :dt'); }
  if (reviewNotes !== undefined) { names['#rn'] = 'reviewNotes'; values[':rn'] = reviewNotes; parts.push('#rn = :rn'); }

  const result = await ddb.send(new UpdateCommand({
    TableName: DOCUMENT_TABLE,
    Key: { documentId: id },
    UpdateExpression: `SET ${parts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ConditionExpression: 'attribute_exists(documentId)',
    ReturnValues: 'ALL_NEW',
  })).catch((err) => {
    if (err.name === 'ConditionalCheckFailedException') return null;
    throw err;
  });

  if (!result) return respond(404, { error: 'NOT_FOUND', message: 'Document not found' });
  return respond(200, result.Attributes);
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  if (method === 'GET' && !id) return listDocuments(event);
  if (method === 'GET' && id) return getDocument(id);
  if (method === 'PATCH' && id) return patchDocument(id, event);

  return respond(400, { error: 'VALIDATION_ERROR', message: 'Invalid request' });
};
