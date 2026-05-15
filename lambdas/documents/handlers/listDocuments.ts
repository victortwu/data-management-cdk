import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { APIGatewayProxyHandlerV2 } from 'aws-lambda'
import { DOCUMENT_TABLE } from '../constants'
import { respond } from '../../shared/utils/respond'
import { dateRangeExpr, dateRangeValues } from '../utils/dateRange'

export const listDocuments = async (
  event: Parameters<APIGatewayProxyHandlerV2>[0],
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
      KeyConditionExpression: '#s = :s' + dateRangeExpr(qs, 'uploadedAt'),
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': qs.status, ...dateRangeValues(qs) },
    }
  } else if (qs.documentType) {
    params = {
      TableName: DOCUMENT_TABLE,
      IndexName: 'ByType',
      Limit: limit,
      ExclusiveStartKey: nextToken,
      KeyConditionExpression: 'documentType = :dt' + dateRangeExpr(qs, 'documentDate'),
      ExpressionAttributeValues: { ':dt': qs.documentType, ...dateRangeValues(qs) },
    }
  } else if (qs.vendorName) {
    params = {
      TableName: DOCUMENT_TABLE,
      IndexName: 'ByVendor',
      Limit: limit,
      ExclusiveStartKey: nextToken,
      KeyConditionExpression: 'vendorName = :vn' + dateRangeExpr(qs, 'documentDate'),
      ExpressionAttributeValues: { ':vn': qs.vendorName, ...dateRangeValues(qs) },
    }
  } else {
    params = { TableName: DOCUMENT_TABLE, Limit: limit, ExclusiveStartKey: nextToken }
    const result = await ddb.send(new ScanCommand(params as any))
    return respond(200, {
      documents: result.Items ?? [],
      nextToken: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url')
        : null,
      count: result.Items?.length ?? 0,
    })
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
