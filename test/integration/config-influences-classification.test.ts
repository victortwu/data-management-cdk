/**
 * Narrow Bedrock Integration Test
 *
 * Proves that config table content (surfaced as system prompt) directly influences
 * the LLM's classification output. Same document text, different prompts → different results.
 *
 * Requirements:
 * - AWS credentials with bedrock:InvokeModel permission
 * - Network access to Bedrock (us-west-2)
 *
 * Run: npm run test:integration
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { parseJsonResponse } from '../../lambdas/processing/adapters/parseJsonResponse'

const client = new BedrockRuntimeClient({ region: 'us-west-2' })

const callBedrock = async (text: string, systemPrompt: string) => {
  const payload = {
    system: [{ text: systemPrompt }],
    messages: [{ role: 'user', content: [{ text: `Analyze this document and return a JSON object:\n\n${text}` }] }],
    inferenceConfig: { maxTokens: 512, temperature: 0 },
  }

  const response = await client.send(
    new InvokeModelCommand({
      modelId: 'us.amazon.nova-lite-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    }),
  )

  const responseBody = JSON.parse(new TextDecoder().decode(response.body))
  const content = responseBody.output?.message?.content?.[0]?.text ?? '{}'
  return parseJsonResponse(content)
}

const BASE_PROMPT = `You are a document classification and metadata extraction system. Analyze the provided document text and return a JSON object with the following fields:

- documentType: one of the known types below, or "unknown" if none fit
- subType: a subtype from the matched type
- vendorName: the vendor ID from the known vendors list if the document is from/about one of them, otherwise the organization name
- documentDate: the primary date of the document in ISO 8601 format (YYYY-MM-DD)
- contactName: the primary person's name associated with the document
- amounts: array of monetary amounts found
- description: a single sentence summarizing what this document is and its purpose
- confidence: "high" if you are certain about documentType and vendorName, "medium" if somewhat certain, "low" if guessing
- flagReason: if confidence is "low" or "medium", briefly explain why

Rules:
- Return ONLY valid JSON, no explanation
- For documentDate, prefer dates near the top of the document
- For vendorName, identify who SENT or ISSUED the document, not who it was sent to
- If the document doesn't clearly match a known vendor, use the organization name as-is
- For subType, prioritize matching the vendor/sender against subType hint keywords over generic terms found in the document body
- Normalize amounts to USD format with dollar sign`

const IRS_LETTER = `Department of the Treasury
Internal Revenue Service
Kansas City, MO 64999-0010

Date: March 15, 2025
Notice: CP2000

Taxpayer: John Smith
SSN: XXX-XX-1234

Dear Taxpayer,

We received information that is different from what you reported on your tax return.
This notice proposes changes to your 2024 Form 1040 tax return.

Proposed amount due: $2,847.00
Tax year: 2024

Please review the enclosed information and respond within 30 days.

Sincerely,
Internal Revenue Service`

const buildPrompt = (types: string, vendors: string) =>
  `${BASE_PROMPT}\n\nKnown document types:\n${types}\n\nKnown vendors:\n${vendors}`

describe('Config table influences Bedrock classification', () => {
  it('returns normalized vendor ID when vendor config includes matching aliases', async () => {
    const prompt = buildPrompt(
      '- tax (subTypes: notice [hints: cp2000, balance due]; return [hints: 1040, w2])',
      '- irs: "Internal Revenue Service" (aliases: irs, internal revenue service)',
    )

    const result = await callBedrock(IRS_LETTER, prompt)

    expect(result.vendorName).toBe('irs')
  })

  it('returns raw organization name when no vendor config exists', async () => {
    const prompt = buildPrompt(
      '- tax (subTypes: notice [hints: cp2000, balance due]; return [hints: 1040, w2])',
      '(none configured)',
    )

    const result = await callBedrock(IRS_LETTER, prompt)

    expect(result.vendorName).not.toBe('irs')
    expect(result.vendorName?.toLowerCase()).toContain('internal revenue')
  })

  it('classifies document type based on available TYPE# config', async () => {
    const prompt = buildPrompt(
      '- tax (subTypes: notice [hints: cp2000, balance due]; return [hints: 1040, w2])\n- financial (subTypes: invoice [hints: net 30]; receipt [hints: payment received])',
      '- irs: "Internal Revenue Service" (aliases: irs, internal revenue service)',
    )

    const result = await callBedrock(IRS_LETTER, prompt)

    expect(result.documentType).toBe('tax')
    expect(result.subType).toBe('notice')
  })

  it('does not classify as a configured type when none match the document', async () => {
    const prompt = buildPrompt(
      '- culinary (subTypes: recipe [hints: ingredients, preheat]; menu [hints: appetizer, entree])',
      '(none configured)',
    )

    const result = await callBedrock(IRS_LETTER, prompt)

    // The LLM should NOT pick "culinary" for an IRS letter
    expect(result.documentType).not.toBe('culinary')
  })
})
