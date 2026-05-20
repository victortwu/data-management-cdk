import type { LlmAdapter } from './types'
import { parseJsonResponse } from './parseJsonResponse'

export const createOllamaAdapter = (endpoint: string, model: string): LlmAdapter => ({
  analyze: async (text, systemPrompt) => {
    const response = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this document and return a JSON object:\n\n${text.slice(0, 12000)}` },
        ],
      }),
    })

    const data = await response.json()
    return parseJsonResponse(data.message?.content ?? '{}')
  },
})
