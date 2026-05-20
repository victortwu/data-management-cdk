import type { BedrockAnalysisResult } from '../types'

export interface LlmAdapter {
  analyze(text: string, systemPrompt: string): Promise<BedrockAnalysisResult>
}
