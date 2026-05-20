import type { LlmAdapter } from './types'
import { parseJsonResponse } from './parseJsonResponse'

export const createOpenAiAdapter = (endpoint: string, apiKey: string, model: string): LlmAdapter => ({
  analyze: async (text, systemPrompt) => {
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 512,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this document and return a JSON object:\n\n${text.slice(0, 12000)}` },
        ],
      }),
    })

    const data = await response.json()
    return parseJsonResponse(data.choices?.[0]?.message?.content ?? '{}')
  },
})
