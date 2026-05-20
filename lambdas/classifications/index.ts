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

const listClassifications = async (tenantId: string) => {
  const result = await ddb.send(
    new QueryCommand({
      TableName: CONFIG_TABLE,
      KeyConditionExpression: 'tenantId = :tid AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':tid': tenantId, ':prefix': 'TYPE#' },
    }),
  )
  return respond(200, { classifications: result.Items ?? [] })
}

const putClassification = async (
  tenantId: string,
  documentType: string,
  event: Parameters<APIGatewayProxyHandlerV2WithJWTAuthorizer>[0],
) => {
  const body = JSON.parse(event.body ?? '{}')
  const { label, subTypes } = body

  if (!label) {
    return respond(400, { error: 'VALIDATION_ERROR', message: 'label is required' })
  }

  const item = { tenantId, sk: `TYPE#${documentType}`, label, subTypes: subTypes ?? {} }
  await ddb.send(new PutCommand({ TableName: CONFIG_TABLE, Item: item }))
  return respond(200, item)
}

const deleteClassification = async (tenantId: string, documentType: string) => {
  const sk = `TYPE#${documentType}`
  const existing = await ddb.send(
    new GetCommand({ TableName: CONFIG_TABLE, Key: { tenantId, sk } }),
  )
  if (!existing.Item)
    return respond(404, { error: 'NOT_FOUND', message: 'Classification type not found' })

  await ddb.send(new DeleteCommand({ TableName: CONFIG_TABLE, Key: { tenantId, sk } }))
  return respond(204)
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { tenantId } = extractTenantContext(event)
  const method = event.requestContext.http.method
  const documentType = event.pathParameters?.documentType

  if (method === 'GET' && !documentType) return listClassifications(tenantId)
  if (method === 'PUT' && documentType) return putClassification(tenantId, documentType, event)
  if (method === 'DELETE' && documentType) return deleteClassification(tenantId, documentType)

  return respond(400, { error: 'VALIDATION_ERROR', message: 'Invalid request' })
}
