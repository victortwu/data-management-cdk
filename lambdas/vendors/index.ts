import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  DeleteCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyHandlerV2 } from 'aws-lambda'
import { respond } from '../shared/utils/respond'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const CONFIG_TABLE = process.env.CONFIG_TABLE!

const listVendors = async () => {
  const result = await ddb.send(new ScanCommand({ TableName: CONFIG_TABLE }))
  const vendors = (result.Items ?? []).filter((i) => (i.pk as string).startsWith('VENDOR#'))
  return respond(200, { vendors })
}

const putVendor = async (vendorId: string, event: Parameters<APIGatewayProxyHandlerV2>[0]) => {
  const body = JSON.parse(event.body ?? '{}')
  const { displayName, aliases } = body

  if (!displayName) {
    return respond(400, { error: 'VALIDATION_ERROR', message: 'displayName is required' })
  }

  const item = { pk: `VENDOR#${vendorId}`, label: displayName, aliases: aliases ?? [] }
  await ddb.send(new PutCommand({ TableName: CONFIG_TABLE, Item: item }))
  return respond(200, item)
}

const deleteVendor = async (vendorId: string) => {
  const pk = `VENDOR#${vendorId}`
  const existing = await ddb.send(new GetCommand({ TableName: CONFIG_TABLE, Key: { pk } }))
  if (!existing.Item) return respond(404, { error: 'NOT_FOUND', message: 'Vendor not found' })

  await ddb.send(new DeleteCommand({ TableName: CONFIG_TABLE, Key: { pk } }))
  return respond(204)
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method
  const vendorId = event.pathParameters?.vendorId

  if (method === 'GET' && !vendorId) return listVendors()
  if (method === 'PUT' && vendorId) return putVendor(vendorId, event)
  if (method === 'DELETE' && vendorId) return deleteVendor(vendorId)

  return respond(400, { error: 'VALIDATION_ERROR', message: 'Invalid request' })
}
