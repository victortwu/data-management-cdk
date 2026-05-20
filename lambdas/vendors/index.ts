import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  DeleteCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import { respond } from '../shared/utils/respond'
import { extractTenantContext } from '../shared/utils/tenantContext'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const CONFIG_TABLE = process.env.CONFIG_TABLE!

const listVendors = async (tenantId: string) => {
  const result = await ddb.send(
    new QueryCommand({
      TableName: CONFIG_TABLE,
      KeyConditionExpression: 'tenantId = :tid AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':tid': tenantId, ':prefix': 'VENDOR#' },
    }),
  )
  return respond(200, { vendors: result.Items ?? [] })
}

const putVendor = async (
  tenantId: string,
  vendorId: string,
  event: Parameters<APIGatewayProxyHandlerV2WithJWTAuthorizer>[0],
) => {
  const body = JSON.parse(event.body ?? '{}')
  const { displayName, aliases } = body

  if (!displayName) {
    return respond(400, { error: 'VALIDATION_ERROR', message: 'displayName is required' })
  }

  const item = { tenantId, sk: `VENDOR#${vendorId}`, label: displayName, aliases: aliases ?? [] }
  await ddb.send(new PutCommand({ TableName: CONFIG_TABLE, Item: item }))
  return respond(200, item)
}

const deleteVendor = async (tenantId: string, vendorId: string) => {
  const sk = `VENDOR#${vendorId}`
  const existing = await ddb.send(
    new GetCommand({ TableName: CONFIG_TABLE, Key: { tenantId, sk } }),
  )
  if (!existing.Item) return respond(404, { error: 'NOT_FOUND', message: 'Vendor not found' })

  await ddb.send(new DeleteCommand({ TableName: CONFIG_TABLE, Key: { tenantId, sk } }))
  return respond(204)
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { tenantId } = extractTenantContext(event)
  const method = event.requestContext.http.method
  const vendorId = event.pathParameters?.vendorId

  if (method === 'GET' && !vendorId) return listVendors(tenantId)
  if (method === 'PUT' && vendorId) return putVendor(tenantId, vendorId, event)
  if (method === 'DELETE' && vendorId) return deleteVendor(tenantId, vendorId)

  return respond(400, { error: 'VALIDATION_ERROR', message: 'Invalid request' })
}
