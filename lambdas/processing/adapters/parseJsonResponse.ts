import type { BedrockAnalysisResult } from '../types'

export const parseJsonResponse = (content: string): BedrockAnalysisResult => {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { documentType: 'unknown', confidence: 'low', flagReason: 'Failed to parse response' }
  }

  const parsed = JSON.parse(jsonMatch[0])
  return {
    documentType: parsed.documentType ?? 'unknown',
    subType: parsed.subType,
    vendorName: parsed.vendorName,
    documentDate: parsed.documentDate,
    contactName: parsed.contactName,
    amounts: parsed.amounts,
    description: parsed.description,
    confidence: parsed.confidence ?? 'medium',
    flagReason: parsed.flagReason,
  }
}
