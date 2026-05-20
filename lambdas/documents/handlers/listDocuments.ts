import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import { DOCUMENT_TABLE } from '../constants'
import { respond } from '../../shared/utils/respond'

export const listDocuments = async (
  tenantId: string,
  event: Parameters<APIGatewayProxyHandlerV2WithJWTAuthorizer>[0],
  ddb: DynamoDBDocumentClient,
) => {
  const qs = event.queryStringParameters ?? {}
  const limit = Math.min(Number(qs.limit) || 25, 100)
  const nextToken = qs.nextToken
    ? JSON.parse(Buffer.from(qs.nextToken, 'base64url').toString())
    : undefined

  const filterCount = [qs.status, qs.documentType, qs.vendorName].filter(Boolean).length
  if (filterCount > 1) {
    return respond(400, {
      error: 'VALIDATION_ERROR',
      message: 'Provide at most one of: status, documentType, vendorName',
    })
  }

  let params: Record<string, unknown>

  if (qs.status) {
    params = {
      TableName: DOCUMENT_TABLE,
      IndexName: 'ByStatus',
      Limit: limit,
      ExclusiveStartKey: nextToken,
      KeyConditionExpression: 'tenantId = :tid AND begins_with(statusDate, :prefix)',
      ExpressionAttributeValues: { ':tid': tenantId, ':prefix': `${qs.status}#` },
    }
  } else if (qs.documentType) {
    params = {
      TableName: DOCUMENT_TABLE,
      IndexName: 'ByType',
      Limit: limit,
      ExclusiveStartKey: nextToken,
      KeyConditionExpression: 'tenantId = :tid AND begins_with(typeDate, :prefix)',
      ExpressionAttributeValues: { ':tid': tenantId, ':prefix': `${qs.documentType}#` },
    }
  } else if (qs.vendorName) {
    params = {
      TableName: DOCUMENT_TABLE,
      IndexName: 'ByVendor',
      Limit: limit,
      ExclusiveStartKey: nextToken,
      KeyConditionExpression: 'tenantId = :tid AND begins_with(vendorDate, :prefix)',
      ExpressionAttributeValues: { ':tid': tenantId, ':prefix': `${qs.vendorName}#` },
    }
  } else {
    // Default: query by tenantId on base table (no scan)
    params = {
      TableName: DOCUMENT_TABLE,
      Limit: limit,
      ExclusiveStartKey: nextToken,
      KeyConditionExpression: 'tenantId = :tid',
      ExpressionAttributeValues: { ':tid': tenantId },
      ScanIndexForward: false,
    }
  }

  const result = await ddb.send(new QueryCommand(params as any))
  return respond(200, {
    documents: result.Items ?? [],
    nextToken: result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url')
      : null,
    count: result.Items?.length ?? 0,
  })
}
