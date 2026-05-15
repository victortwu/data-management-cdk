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

const listClassifications = async () => {
  const result = await ddb.send(new ScanCommand({ TableName: CONFIG_TABLE }))
  const types = (result.Items ?? []).filter((i) => (i.pk as string).startsWith('TYPE#'))
  return respond(200, { classifications: types })
}

const putClassification = async (
  documentType: string,
  event: Parameters<APIGatewayProxyHandlerV2>[0],
) => {
  const body = JSON.parse(event.body ?? '{}')
  const { label, subTypes } = body

  if (!label) {
    return respond(400, { error: 'VALIDATION_ERROR', message: 'label is required' })
  }

  const item = { pk: `TYPE#${documentType}`, label, subTypes: subTypes ?? {} }
  await ddb.send(new PutCommand({ TableName: CONFIG_TABLE, Item: item }))
  return respond(200, item)
}

const deleteClassification = async (documentType: string) => {
  const pk = `TYPE#${documentType}`
  const existing = await ddb.send(new GetCommand({ TableName: CONFIG_TABLE, Key: { pk } }))
  if (!existing.Item)
    return respond(404, { error: 'NOT_FOUND', message: 'Classification type not found' })

  await ddb.send(new DeleteCommand({ TableName: CONFIG_TABLE, Key: { pk } }))
  return respond(204)
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method
  const documentType = event.pathParameters?.documentType

  if (method === 'GET' && !documentType) return listClassifications()
  if (method === 'PUT' && documentType) return putClassification(documentType, event)
  if (method === 'DELETE' && documentType) return deleteClassification(documentType)

  return respond(400, { error: 'VALIDATION_ERROR', message: 'Invalid request' })
}
