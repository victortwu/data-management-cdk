import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { CONFIG_TABLE } from '../constants'
import type { ConfigItem } from '../types'
import { DEFAULT_CONFIG } from '../../post-confirmation/constants/defaultConfig'

export const buildBedrockPrompt = async (tenantId: string, ddb: DynamoDBDocumentClient): Promise<string> => {
  const result = await ddb.send(
    new QueryCommand({
      TableName: CONFIG_TABLE,
      KeyConditionExpression: 'tenantId = :tid',
      ExpressionAttributeValues: { ':tid': tenantId },
    }),
  )
  const items = (result.Items ?? []) as ConfigItem[]

  // Fallback to defaults if tenant has no TYPE# config
  const typeItems = items.filter((i) => i.sk.startsWith('TYPE#'))
  const effectiveTypes = typeItems.length > 0
    ? typeItems
    : (DEFAULT_CONFIG as unknown as ConfigItem[])

  const types = effectiveTypes
    .filter((i) => i.sk.startsWith('TYPE#'))
    .map((i) => {
      const name = i.sk.replace('TYPE#', '')
      const subs = i.subTypes
        ? Object.entries(i.subTypes)
            .map(([sub, keywords]) => `${sub} [hints: ${keywords.join(', ')}]`)
            .join('; ')
        : 'none'
      return `- ${name} (subTypes: ${subs})`
    })
    .join('\n')

  const vendors = items
    .filter((i) => i.sk.startsWith('VENDOR#'))
    .map((i) => {
      const id = i.sk.replace('VENDOR#', '')
      return `- ${id}: "${i.label}" (aliases: ${i.aliases?.join(', ') ?? 'none'})`
    })
    .join('\n')

  return `You are a document classification and metadata extraction system. Analyze the provided document text and return a JSON object with the following fields:

- documentType: one of the known types below, or "unknown" if none fit
- subType: a subtype from the matched type. Use the hint keywords to guide your choice — if the vendor/sender matches a subType hint, prefer that subType.
- vendorName: the vendor ID from the known vendors list if the document is from/about one of them, otherwise the organization name
- documentDate: the primary date of the document in ISO 8601 format (YYYY-MM-DD). This is typically the date the document was issued, not dates mentioned in the body.
- contactName: the primary person's name associated with the document
- amounts: array of monetary amounts found (e.g., ["$1,234.56"])
- description: a single sentence summarizing what this document is and its purpose
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
- For subType, prioritize matching the vendor/sender against subType hint keywords over generic terms found in the document body
- Normalize amounts to USD format with dollar sign`
}
