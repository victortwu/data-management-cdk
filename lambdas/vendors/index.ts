import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const VENDOR_TABLE = process.env.VENDOR_TABLE!;

const respond = (statusCode: number, body?: Record<string, unknown>) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : '',
});

const listVendors = async () => {
  const result = await ddb.send(new ScanCommand({ TableName: VENDOR_TABLE }));
  return respond(200, { vendors: result.Items ?? [] });
};

const putVendor = async (vendorId: string, event: Parameters<APIGatewayProxyHandlerV2>[0]) => {
  const body = JSON.parse(event.body ?? '{}');
  const { displayName, aliases } = body;

  if (!displayName || !Array.isArray(aliases) || aliases.length === 0) {
    return respond(400, { error: 'VALIDATION_ERROR', message: 'displayName and non-empty aliases array are required' });
  }

  const item = { vendorId, displayName, aliases };
  await ddb.send(new PutCommand({ TableName: VENDOR_TABLE, Item: item }));
  return respond(200, item);
};

const deleteVendor = async (vendorId: string) => {
  const existing = await ddb.send(new GetCommand({ TableName: VENDOR_TABLE, Key: { vendorId } }));
  if (!existing.Item) return respond(404, { error: 'NOT_FOUND', message: 'Vendor not found' });

  await ddb.send(new DeleteCommand({ TableName: VENDOR_TABLE, Key: { vendorId } }));
  return respond(204);
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  const vendorId = event.pathParameters?.vendorId;

  if (method === 'GET' && !vendorId) return listVendors();
  if (method === 'PUT' && vendorId) return putVendor(vendorId, event);
  if (method === 'DELETE' && vendorId) return deleteVendor(vendorId);

  return respond(400, { error: 'VALIDATION_ERROR', message: 'Invalid request' });
};
