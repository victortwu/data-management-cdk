import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyHandlerV2 } from 'aws-lambda'

import { respond } from '../shared/utils/respond'
import { listDocuments } from './handlers/listDocuments'
import { getDocument } from './handlers/getDocument'
import { patchDocument } from './handlers/patchDocument'
import { getClassificationStats } from './handlers/getClassificationStats'
import { reprocessDocuments } from './handlers/reprocessDocuments'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method
  const id = event.pathParameters?.id
  const path = event.rawPath

  if (method === 'GET' && path.endsWith('/classifications/stats'))
    return getClassificationStats(ddb)
  if (method === 'POST' && path.endsWith('/documents/reprocess')) return reprocessDocuments(ddb)
  if (method === 'GET' && !id) return listDocuments(event, ddb)
  if (method === 'GET' && id) return getDocument(id, ddb)
  if (method === 'PATCH' && id) return patchDocument(id, event, ddb)

  return respond(400, { error: 'VALIDATION_ERROR', message: 'Invalid request' })
}
