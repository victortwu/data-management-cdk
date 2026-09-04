/**
 * EXPENSE-VENDOR CLASSIFICATION INTEGRATION TEST (real Bedrock)
 * ────────────────────────────────────────────────────────────────────────────
 * Proves the "correct docs make it through" boundary: for each REAL BDK expense
 * vendor, the Bedrock classifier must produce `documentType === 'financial'` so
 * the document passes the expense pipeline's EventBridge entry gate (which admits
 * ONLY financial — see bdk-expense-processor entry-gate intent contract).
 *
 * This is the counterpart to the structural gate test. The gate test proves the
 * filter admits `financial`; THIS test proves our actual vendors' documents
 * ACTUALLY classify as `financial` (and with a sane subType + vendor). Together
 * they close the "garbage-in / nothing-in" gap at the Parsely→Expense seam.
 *
 * Requirements:
 * - AWS credentials with bedrock:InvokeModel permission
 * - Network access to Bedrock (us-west-2)
 * Cost: ~pennies per run (one Nova Lite call per vendor fixture).
 *
 * Run: npm run test:integration
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { parseJsonResponse } from '../../lambdas/processing/adapters/parseJsonResponse'
import {
  EXPENSE_VENDOR_FIXTURES,
  BDK_FULL_TYPES,
  BDK_EXPENSE_VENDORS,
} from './fixtures/expenseVendorClassification'

const client = new BedrockRuntimeClient({ region: 'us-west-2' })

const BASE_PROMPT = `You are a document classification and metadata extraction system. Analyze the provided document text and return a JSON object with the following fields:

- documentType: one of the known types below, or "unknown" if none fit
- subType: a subtype from the matched type. Use the hint keywords to guide your choice — if the vendor/sender matches a subType hint, prefer that subType.
- vendorName: the vendor ID from the known vendors list if the document is from/about one of them, otherwise the organization name
- documentDate: the primary date of the document in ISO 8601 format (YYYY-MM-DD). This is typically the date the document was issued, not dates mentioned in the body.
- contactName: the primary person's name associated with the document
- amounts: array of monetary amounts found (e.g., ["$1,234.56"])
- description: a single sentence summarizing what this document is and its purpose
- confidence: "high" if you are certain about documentType and vendorName, "medium" if somewhat certain, "low" if guessing
- flagReason: if confidence is "low" or "medium", briefly explain why

Rules:
- Return ONLY valid JSON, no explanation
- For documentDate, prefer dates near the top of the document (letterhead area)
- For vendorName, identify who SENT or ISSUED the document, not who it was sent to
- If the document doesn't clearly match a known vendor, use the organization name as-is
- For subType, prioritize matching the vendor/sender against subType hint keywords over generic terms found in the document body
- Normalize amounts to USD format with dollar sign

Classification priority (apply in order):
- If the document relates to government tax obligations, assessments, refunds, or penalties (IRS, state tax agencies) → classify as "tax" even if dollar amounts are present
- If the document represents a bill, payment, or charge for goods/services consumed by the business (utilities, insurance premiums, vendor purchases, subscriptions, rent, service fees) → classify as "financial" even if it uses words like "notice" or "notification"
- Classify as "correspondence" ONLY when no money is being exchanged, billed, or owed — purely informational communications`

const buildPrompt = () =>
  `${BASE_PROMPT}\n\nKnown document types:\n${BDK_FULL_TYPES}\n\nKnown vendors:\n${BDK_EXPENSE_VENDORS}`

const callBedrock = async (text: string, systemPrompt: string) => {
  const payload = {
    system: [{ text: systemPrompt }],
    messages: [
      { role: 'user', content: [{ text: `Analyze this document and return a JSON object:\n\n${text}` }] },
    ],
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

describe('Expense vendors classify as financial (entry-gate accuracy)', () => {
  const prompt = buildPrompt()

  it.each(EXPENSE_VENDOR_FIXTURES.map((f) => [f.label, f] as const))(
    'classifies %s as financial and passes the expense entry gate',
    async (_label, fixture) => {
      // arrange
      // (prompt + fixture text)

      // act
      const result = await callBedrock(fixture.text, prompt)

      // assert — THE critical gate: financial or the doc is silently dropped
      expect(result.documentType).toBe(fixture.expectedDocumentType)
    },
  )

  it.each(EXPENSE_VENDOR_FIXTURES.map((f) => [f.label, f] as const))(
    'extracts a resolvable vendorName for %s (needed for QBO vendor matching)',
    async (_label, fixture) => {
      // act
      const result = await callBedrock(fixture.text, prompt)

      // assert — expense processor keys vendor rules off this; a wrong/blank
      // vendorName means fuzzy resolve fails → needs_input instead of auto-submit
      expect(result.vendorName).toBeTruthy()
      expect(result.vendorName).toMatch(fixture.vendorNameMatch)
    },
  )

  it.each(EXPENSE_VENDOR_FIXTURES.map((f) => [f.label, f] as const))(
    'assigns the expected financial subType for %s',
    async (_label, fixture) => {
      // act
      const result = await callBedrock(fixture.text, prompt)

      // assert — subType is advisory (the gate does not filter on it), so this is
      // a softer expectation: log drift rather than over-constrain the LLM.
      if (result.subType !== fixture.expectedSubType) {
        // eslint-disable-next-line no-console
        console.warn(
          `subType drift for ${fixture.vendorSlug}: expected "${fixture.expectedSubType}", got "${result.subType}"`,
        )
      }
      // Still assert it is a recognized financial subType (not empty/unknown).
      expect(['invoice', 'receipt', 'notification']).toContain(result.subType)
    },
  )
})
