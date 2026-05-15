import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime'
import { BEDROCK_MODEL_ID } from '../constants'
import type { BedrockAnalysisResult } from '../types'

const bedrock = new BedrockRuntimeClient({})

export const analyzeWithBedrock = async (
  text: string,
  systemPrompt: string,
): Promise<BedrockAnalysisResult> => {
  const truncated = text.slice(0, 12000)

  const payload = {
    system: [{ text: systemPrompt }],
    messages: [
      {
        role: 'user',
        content: [{ text: `Analyze this document and return a JSON object:\n\n${truncated}` }],
      },
    ],
    inferenceConfig: {
      maxTokens: 512,
      temperature: 0,
    },
  }

  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    }),
  )

  const responseBody = JSON.parse(new TextDecoder().decode(response.body))
  const content = responseBody.output?.message?.content?.[0]?.text ?? '{}'

  // Extract JSON from response (handle markdown code blocks)
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
    confidence: parsed.confidence ?? 'medium',
    flagReason: parsed.flagReason,
  }
}
