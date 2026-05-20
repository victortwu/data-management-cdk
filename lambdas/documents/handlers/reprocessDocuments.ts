import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DOCUMENT_TABLE, PROCESSED_BUCKET, CONFIG_TABLE } from '../constants'
import { respond } from '../../shared/utils/respond'

const s3 = new S3Client({})

export const reprocessDocuments = async (tenantId: string, ddb: DynamoDBDocumentClient) => {
  // Load tenant config
  const configResult = await ddb.send(
    new QueryCommand({
      TableName: CONFIG_TABLE,
      KeyConditionExpression: 'tenantId = :tid',
      ExpressionAttributeValues: { ':tid': tenantId },
    }),
  )
  const configItems = configResult.Items ?? []
  const configs = configItems.filter((i) => (i.sk as string).startsWith('TYPE#'))
  const vendors = configItems.filter((i) => (i.sk as string).startsWith('VENDOR#'))

  let processed = 0
  let failed = 0
  let lastKey: Record<string, any> | undefined

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: DOCUMENT_TABLE,
        KeyConditionExpression: 'tenantId = :tid',
        ExpressionAttributeValues: { ':tid': tenantId },
        ProjectionExpression: 'tenantId, documentId, extractedTextUri',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    )

    for (const doc of result.Items ?? []) {
      try {
        const textUri = doc.extractedTextUri as string | undefined
        if (!textUri) { failed++; continue }

        const textKey = textUri.replace(/^s3:\/\/[^/]+\//, '')
        const resp = await s3.send(new GetObjectCommand({ Bucket: PROCESSED_BUCKET, Key: textKey }))
        const text = await resp.Body!.transformToString()
        const lowerText = text.toLowerCase()

        let bestType = 'unknown', bestSubType: string | undefined, bestScore = 0
        for (const item of configs) {
          const subTypes = (item.subTypes as Record<string, string[]>) ?? {}
          const allKeywords = Object.values(subTypes).flat()
          if (allKeywords.length === 0) continue
          const matched = allKeywords.filter((kw) => lowerText.includes(kw.toLowerCase()))
          if (matched.length === 0) continue
          const score = matched.length / allKeywords.length
          if (score > bestScore) {
            bestScore = score
            bestType = (item.sk as string).replace('TYPE#', '')
            bestSubType = undefined
            let bestSubScore = 0
            for (const [name, subKws] of Object.entries(subTypes)) {
              const subMatched = subKws.filter((kw) => lowerText.includes(kw.toLowerCase()))
              const subScore = subMatched.length / subKws.length
              if (subScore > bestSubScore) { bestSubScore = subScore; bestSubType = name }
            }
          }
        }

        let vendorName: string | undefined
        for (const vendor of vendors) {
          const aliases = (vendor.aliases as string[]) ?? []
          if (aliases.some((alias) => lowerText.includes(alias.toLowerCase()))) {
            vendorName = (vendor.sk as string).replace('VENDOR#', '')
            break
          }
        }

        await ddb.send(
          new UpdateCommand({
            TableName: DOCUMENT_TABLE,
            Key: { tenantId, documentId: doc.documentId },
            UpdateExpression:
              'SET documentType = :dt, subType = :st, vendorName = :vn, #s = :status, tags = :tags, typeDate = :td, vendorDate = :vd, statusDate = :sd REMOVE reviewReason',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':dt': bestType,
              ':st': bestSubType ?? null,
              ':vn': vendorName ?? null,
              ':status': bestType === 'unknown' ? 'needs_review' : 'processed',
              ':tags': [bestType, bestSubType, vendorName].filter(Boolean),
              ':td': bestType !== 'unknown' ? `${bestType}#` : null,
              ':vd': vendorName ? `${vendorName}#` : null,
              ':sd': `${bestType === 'unknown' ? 'needs_review' : 'processed'}#${new Date().toISOString()}`,
            },
          }),
        )
        processed++
      } catch {
        failed++
      }
    }
    lastKey = result.LastEvaluatedKey
  } while (lastKey)

  return respond(200, { message: 'Reprocessing complete', processed, failed })
}
