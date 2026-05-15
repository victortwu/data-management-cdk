import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DOCUMENT_TABLE, PROCESSED_BUCKET, CONFIG_TABLE } from '../constants'
import { respond } from '../../shared/utils/respond'

const s3 = new S3Client({})

export const reprocessDocuments = async (ddb: DynamoDBDocumentClient) => {
  // Load config
  const configResult = await ddb.send(new ScanCommand({ TableName: CONFIG_TABLE }))
  const configItems = configResult.Items ?? []
  const configs = configItems.filter((i) => (i.pk as string).startsWith('TYPE#'))
  const vendors = configItems.filter((i) => (i.pk as string).startsWith('VENDOR#'))

  let processed = 0
  let failed = 0
  let lastKey: Record<string, any> | undefined

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: DOCUMENT_TABLE,
        ProjectionExpression: 'documentId, extractedTextUri',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    )

    for (const doc of result.Items ?? []) {
      try {
        const textUri = doc.extractedTextUri as string | undefined
        if (!textUri) {
          failed++
          continue
        }

        const textKey = textUri.replace(/^s3:\/\/[^/]+\//, '')
        const resp = await s3.send(new GetObjectCommand({ Bucket: PROCESSED_BUCKET, Key: textKey }))
        const text = await resp.Body!.transformToString()
        const lowerText = text.toLowerCase()

        // Classify using TYPE# config items
        let bestType = 'unknown',
          bestSubType: string | undefined,
          bestScore = 0
        for (const item of configs) {
          const subTypes = (item.subTypes as Record<string, string[]>) ?? {}
          const allKeywords = Object.values(subTypes).flat()
          if (allKeywords.length === 0) continue
          const matched = allKeywords.filter((kw) => lowerText.includes(kw.toLowerCase()))
          if (matched.length === 0) continue
          const score = matched.length / allKeywords.length
          if (score > bestScore) {
            bestScore = score
            bestType = (item.pk as string).replace('TYPE#', '')
            bestSubType = undefined
            let bestSubScore = 0
            for (const [name, subKws] of Object.entries(subTypes)) {
              const subMatched = subKws.filter((kw) => lowerText.includes(kw.toLowerCase()))
              const subScore = subMatched.length / subKws.length
              if (subScore > bestSubScore) {
                bestSubScore = subScore
                bestSubType = name
              }
            }
          }
        }

        // Normalize vendor using VENDOR# config items
        let vendorName: string | undefined, vendorDisplay: string | undefined
        const textLower = lowerText
        for (const vendor of vendors) {
          const aliases = (vendor.aliases as string[]) ?? []
          if (aliases.some((alias) => textLower.includes(alias.toLowerCase()))) {
            vendorName = (vendor.pk as string).replace('VENDOR#', '')
            vendorDisplay = vendor.label as string
            break
          }
        }

        await ddb.send(
          new UpdateCommand({
            TableName: DOCUMENT_TABLE,
            Key: { documentId: doc.documentId },
            UpdateExpression:
              'SET documentType = :dt, subType = :st, vendorName = :vn, vendorDisplay = :vd, #s = :status, tags = :tags REMOVE reviewReason',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':dt': bestType,
              ':st': bestSubType ?? null,
              ':vn': vendorName ?? null,
              ':vd': vendorDisplay ?? null,
              ':status': bestType === 'unknown' ? 'needs_review' : 'processed',
              ':tags': [bestType, bestSubType, vendorName].filter(Boolean),
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
