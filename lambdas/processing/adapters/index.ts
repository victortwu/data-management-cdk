import type { LlmAdapter } from './types'
import { createBedrockAdapter } from './bedrock'
import { createOllamaAdapter } from './ollama'
import { createOpenAiAdapter } from './openai'
import { createNoneAdapter } from './none'

export const createLlmAdapter = (): LlmAdapter => {
  const provider = process.env.LLM_PROVIDER ?? 'bedrock'
  switch (provider) {
    case 'bedrock':
      return createBedrockAdapter(process.env.LLM_MODEL_ID ?? 'us.amazon.nova-lite-v1:0')
    case 'ollama':
      return createOllamaAdapter(process.env.LLM_ENDPOINT!, process.env.LLM_MODEL_ID!)
    case 'openai':
      return createOpenAiAdapter(process.env.LLM_ENDPOINT!, process.env.LLM_API_KEY!, process.env.LLM_MODEL_ID!)
    case 'none':
      return createNoneAdapter()
    default:
      return createBedrockAdapter('us.amazon.nova-lite-v1:0')
  }
}

export type { LlmAdapter } from './types'
