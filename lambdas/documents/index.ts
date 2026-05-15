import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const DOCUMENT_TABLE = process.env.DOCUMENT_TABLE!;
const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET!;
const CLASSIFICATION_TABLE = process.env.CLASSIFICATION_TABLE!;
const VENDOR_TABLE = process.env.VENDOR_TABLE!;
const URL_EXPIRY_SECONDS = 900;

const respond = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const presignInline = async (uri: string): Promise<string> => {
  const key = uri.replace(/^s3:\/\/[^/]+\//, '');
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: PROCESSED_BUCKET, Key: key, ResponseContentDisposition: 'inline', ResponseContentType: 'application/pdf' }), { expiresIn: URL_EXPIRY_SECONDS });
};

const presignDownload = async (uri: string): Promise<string> => {
  const key = uri.replace(/^s3:\/\/[^/]+\//, '');
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: PROCESSED_BUCKET, Key: key, ResponseContentDisposition: 'attachment' }), { expiresIn: URL_EXPIRY_SECONDS });
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
  const previewUrls = {
    original: doc.originalUri ? await presignInline(doc.originalUri) : null,
    convertedPdf: doc.convertedPdfUri ? await presignInline(doc.convertedPdfUri) : null,
  };
  const downloadUrls = {
    original: doc.originalUri ? await presignDownload(doc.originalUri) : null,
    convertedPdf: doc.convertedPdfUri ? await presignDownload(doc.convertedPdfUri) : null,
    extractedText: doc.extractedTextUri ? await presignDownload(doc.extractedTextUri) : null,
  };

  return respond(200, { ...doc, previewUrls, downloadUrls });
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
  return respond(200, result.Attributes as Record<string, unknown>);
};

const getClassificationStats = async () => {
  const byType: Record<string, { count: number; subTypes: Record<string, number> }> = {};
  let unclassified = 0;
  const byVendor: Record<string, number> = {};
  let unmatchedVendors = 0;

  let lastKey: Record<string, any> | undefined;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: DOCUMENT_TABLE,
      ProjectionExpression: 'documentType, subType, vendorName',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const item of result.Items ?? []) {
      const docType = item.documentType as string | undefined;
      if (!docType || docType === 'unknown') {
        unclassified++;
      } else {
        if (!byType[docType]) byType[docType] = { count: 0, subTypes: {} };
        byType[docType].count++;
        const sub = item.subType as string | undefined;
        if (sub) byType[docType].subTypes[sub] = (byType[docType].subTypes[sub] ?? 0) + 1;
      }
      const vendor = item.vendorName as string | undefined;
      if (vendor) byVendor[vendor] = (byVendor[vendor] ?? 0) + 1;
      else unmatchedVendors++;
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return respond(200, {
    byType: Object.entries(byType).map(([type, data]) => ({ type, ...data })),
    unclassified,
    byVendor: Object.entries(byVendor)
      .map(([vendor, count]) => ({ vendor, count }))
      .sort((a, b) => b.count - a.count),
    unmatchedVendors,
  });
};

const reprocessDocuments = async () => {
  const configItems = await ddb.send(new ScanCommand({ TableName: CLASSIFICATION_TABLE }));
  const vendorItems = await ddb.send(new ScanCommand({ TableName: VENDOR_TABLE }));
  const configs = configItems.Items ?? [];
  const vendors = vendorItems.Items ?? [];

  let processed = 0;
  let failed = 0;
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(new ScanCommand({
      TableName: DOCUMENT_TABLE,
      ProjectionExpression: 'documentId, extractedTextUri, detectedOrganizations',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));

    for (const doc of result.Items ?? []) {
      try {
        const textUri = doc.extractedTextUri as string | undefined;
        if (!textUri) { failed++; continue; }

        const textKey = textUri.replace(/^s3:\/\/[^/]+\//, '');
        const resp = await s3.send(new GetObjectCommand({ Bucket: PROCESSED_BUCKET, Key: textKey }));
        const text = await resp.Body!.transformToString();
        const lowerText = text.toLowerCase();

        // Classify
        let bestType = 'unknown', bestSubType: string | undefined, bestKeywords: string[] = [], bestScore = 0;
        for (const item of configs) {
          const keywords = (item.keywords as string[]) ?? [];
          const matched = keywords.filter((kw) => lowerText.includes(kw.toLowerCase()));
          if (matched.length === 0) continue;
          const score = matched.length / keywords.length;
          if (score > bestScore) {
            bestScore = score;
            bestType = item.documentType as string;
            bestKeywords = matched;
            const subTypes = (item.subTypes as Record<string, string[]>) ?? {};
            let bestSubScore = 0;
            bestSubType = undefined;
            for (const [name, subKws] of Object.entries(subTypes)) {
              const subMatched = subKws.filter((kw) => lowerText.includes(kw.toLowerCase()));
              const subScore = subMatched.length / subKws.length;
              if (subScore > bestSubScore) { bestSubScore = subScore; bestSubType = name; }
            }
          }
        }

        // Normalize vendor
        const orgs = (doc.detectedOrganizations as string[]) ?? [];
        const lowerOrgs = orgs.map((o) => o.toLowerCase());
        let vendorName: string | undefined, vendorDisplay: string | undefined;
        for (const vendor of vendors) {
          const aliases = (vendor.aliases as string[]) ?? [];
          if (aliases.some((alias) => lowerOrgs.some((org) => org.includes(alias.toLowerCase())))) {
            vendorName = vendor.vendorId as string;
            vendorDisplay = vendor.displayName as string;
            break;
          }
        }

        await ddb.send(new UpdateCommand({
          TableName: DOCUMENT_TABLE,
          Key: { documentId: doc.documentId },
          UpdateExpression: 'SET documentType = :dt, subType = :st, matchedKeywords = :mk, matchedScore = :ms, vendorName = :vn, vendorDisplay = :vd, #s = :status, tags = :tags REMOVE reviewReason',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':dt': bestType,
            ':st': bestSubType ?? null,
            ':mk': bestKeywords,
            ':ms': bestScore,
            ':vn': vendorName ?? orgs[0] ?? null,
            ':vd': vendorDisplay ?? null,
            ':status': bestType === 'unknown' ? 'needs_review' : 'processed',
            ':tags': [bestType, bestSubType, vendorName].filter(Boolean),
          },
        }));
        processed++;
      } catch {
        failed++;
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return respond(200, { message: 'Reprocessing complete', processed, failed });
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;
  const path = event.rawPath;

  if (method === 'GET' && path.endsWith('/classifications/stats')) return getClassificationStats();
  if (method === 'POST' && path.endsWith('/documents/reprocess')) return reprocessDocuments();
  if (method === 'GET' && !id) return listDocuments(event);
  if (method === 'GET' && id) return getDocument(id);
  if (method === 'PATCH' && id) return patchDocument(id, event);

  return respond(400, { error: 'VALIDATION_ERROR', message: 'Invalid request' });
};
