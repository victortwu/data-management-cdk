import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { DOCUMENT_TABLE } from '../constants'
import { respond } from '../../shared/utils/respond'

export const getClassificationStats = async (tenantId: string, ddb: DynamoDBDocumentClient) => {
  const byType: Record<string, { count: number; subTypes: Record<string, number> }> = {}
  let unclassified = 0
  const byVendor: Record<string, number> = {}
  let unmatchedVendors = 0

  let lastKey: Record<string, any> | undefined
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: DOCUMENT_TABLE,
        KeyConditionExpression: 'tenantId = :tid',
        ExpressionAttributeValues: { ':tid': tenantId },
        ProjectionExpression: 'documentType, subType, vendorName',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    )
    for (const item of result.Items ?? []) {
      const docType = item.documentType as string | undefined
      if (!docType || docType === 'unknown') {
        unclassified++
      } else {
        if (!byType[docType]) byType[docType] = { count: 0, subTypes: {} }
        byType[docType].count++
        const sub = item.subType as string | undefined
        if (sub) byType[docType].subTypes[sub] = (byType[docType].subTypes[sub] ?? 0) + 1
      }
      const vendor = item.vendorName as string | undefined
      if (vendor) byVendor[vendor] = (byVendor[vendor] ?? 0) + 1
      else unmatchedVendors++
    }
    lastKey = result.LastEvaluatedKey
  } while (lastKey)

  return respond(200, {
    byType: Object.entries(byType).map(([type, data]) => ({ type, ...data })),
    unclassified,
    byVendor: Object.entries(byVendor)
      .map(([vendor, count]) => ({ vendor, count }))
      .sort((a, b) => b.count - a.count),
    unmatchedVendors,
  })
}
