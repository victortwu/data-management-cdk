import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CLASSIFICATION_TABLE = process.env.CLASSIFICATION_TABLE!;

const respond = (statusCode: number, body?: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : '',
});

const listClassifications = async () => {
  const result = await ddb.send(new ScanCommand({ TableName: CLASSIFICATION_TABLE }));
  return respond(200, { classifications: result.Items ?? [] });
};

const putClassification = async (documentType: string, event: Parameters<APIGatewayProxyHandlerV2>[0]) => {
  const body = JSON.parse(event.body ?? '{}');
  const { keywords, description } = body;

  if (!Array.isArray(keywords) || keywords.length === 0) {
    return respond(400, { error: 'VALIDATION_ERROR', message: 'keywords must be a non-empty array' });
  }

  const item = { documentType, keywords, description: description ?? '' };
  await ddb.send(new PutCommand({ TableName: CLASSIFICATION_TABLE, Item: item }));
  return respond(200, item);
};

const deleteClassification = async (documentType: string) => {
  const existing = await ddb.send(new GetCommand({ TableName: CLASSIFICATION_TABLE, Key: { documentType } }));
  if (!existing.Item) return respond(404, { error: 'NOT_FOUND', message: 'Classification type not found' });

  await ddb.send(new DeleteCommand({ TableName: CLASSIFICATION_TABLE, Key: { documentType } }));
  return respond(204);
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  const documentType = event.pathParameters?.documentType;

  if (method === 'GET' && !documentType) return listClassifications();
  if (method === 'PUT' && documentType) return putClassification(documentType, event);
  if (method === 'DELETE' && documentType) return deleteClassification(documentType);

  return respond(400, { error: 'VALIDATION_ERROR', message: 'Invalid request' });
};
