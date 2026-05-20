import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'

import { respond } from '../shared/utils/respond'
import { extractTenantContext } from '../shared/utils/tenantContext'
import { logger } from '../shared/utils/logger'
import { listDocuments } from './handlers/listDocuments'
import { getDocument } from './handlers/getDocument'
import { patchDocument } from './handlers/patchDocument'
import { getClassificationStats } from './handlers/getClassificationStats'
import { reprocessDocuments } from './handlers/reprocessDocuments'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { tenantId } = extractTenantContext(event)
  const method = event.requestContext.http.method
  const id = event.pathParameters?.id
  const path = event.rawPath

  logger.appendKeys({ tenantId, route: `${method} ${path}` })

  if (method === 'GET' && path.endsWith('/classifications/stats'))
    return getClassificationStats(tenantId, ddb)
  if (method === 'POST' && path.endsWith('/documents/reprocess'))
    return reprocessDocuments(tenantId, ddb)
  if (method === 'GET' && !id) return listDocuments(tenantId, event, ddb)
  if (method === 'GET' && id) return getDocument(tenantId, id, ddb)
  if (method === 'PATCH' && id) return patchDocument(tenantId, id, event, ddb)

  return respond(400, { error: 'VALIDATION_ERROR', message: 'Invalid request' })
}
