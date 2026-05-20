import type { LlmAdapter } from './types'

export const createNoneAdapter = (): LlmAdapter => ({
  analyze: async () => ({
    documentType: 'unknown',
    confidence: 'low' as const,
    flagReason: 'manual_entry',
  }),
})
