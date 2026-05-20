import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import type { LlmAdapter } from './types'
import { parseJsonResponse } from './parseJsonResponse'

export const createBedrockAdapter = (modelId: string): LlmAdapter => {
  const client = new BedrockRuntimeClient({})

  return {
    analyze: async (text, systemPrompt) => {
      const payload = {
        system: [{ text: systemPrompt }],
        messages: [{ role: 'user', content: [{ text: `Analyze this document and return a JSON object:\n\n${text.slice(0, 12000)}` }] }],
        inferenceConfig: { maxTokens: 512, temperature: 0 },
      }

      const response = await client.send(
        new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(payload),
        }),
      )

      const responseBody = JSON.parse(new TextDecoder().decode(response.body))
      const content = responseBody.output?.message?.content?.[0]?.text ?? '{}'
      return parseJsonResponse(content)
    },
  }
}
