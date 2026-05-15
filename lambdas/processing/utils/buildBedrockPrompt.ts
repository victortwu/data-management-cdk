import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { CONFIG_TABLE } from '../constants'
import type { ConfigItem } from '../types'

export const buildBedrockPrompt = async (ddb: DynamoDBDocumentClient): Promise<string> => {
  const result = await ddb.send(new ScanCommand({ TableName: CONFIG_TABLE }))
  const items = (result.Items ?? []) as ConfigItem[]

  const types = items
    .filter((i) => i.pk.startsWith('TYPE#'))
    .map((i) => {
      const name = i.pk.replace('TYPE#', '')
      const subs = i.subTypes ? Object.keys(i.subTypes).join(', ') : 'none'
      return `- ${name} (subTypes: ${subs})`
    })
    .join('\n')

  const vendors = items
    .filter((i) => i.pk.startsWith('VENDOR#'))
    .map((i) => {
      const id = i.pk.replace('VENDOR#', '')
      return `- ${id}: "${i.label}" (aliases: ${i.aliases?.join(', ') ?? 'none'})`
    })
    .join('\n')

  return `You are a document classification and metadata extraction system. Analyze the provided document text and return a JSON object with the following fields:

- documentType: one of the known types below, or "unknown" if none fit
- subType: a subtype if applicable
- vendorName: the vendor ID from the known vendors list if the document is from/about one of them, otherwise the organization name
- documentDate: the primary date of the document in ISO 8601 format (YYYY-MM-DD). This is typically the date the document was issued, not dates mentioned in the body.
- contactName: the primary person's name associated with the document
- amounts: array of monetary amounts found (e.g., ["$1,234.56"])
- confidence: "high" if you are certain about documentType and vendorName, "medium" if somewhat certain, "low" if guessing
- flagReason: if confidence is "low" or "medium", briefly explain why

Known document types:
${types}

Known vendors:
${vendors}

Rules:
- Return ONLY valid JSON, no explanation
- For documentDate, prefer dates near the top of the document (letterhead area)
- For vendorName, identify who SENT or ISSUED the document, not who it was sent to
- If the document doesn't clearly match a known vendor, use the organization name as-is
- Normalize amounts to USD format with dollar sign`
}
