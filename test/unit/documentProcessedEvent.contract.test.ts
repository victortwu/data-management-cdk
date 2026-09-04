/**
 * PRODUCER-SIDE EVENT CONTRACT TEST
 * ────────────────────────────────────────────────────────────────────────────
 * Pins the `detail` shape that Parsely emits on the `DocumentProcessed`
 * EventBridge event. The BDK Expense Processor consumes this exact shape off SQS
 * (see bdk-expense-processor/test/fixtures/documentProcessedEvent.contract.ts).
 *
 * The two repos are separate and can drift silently. If this test and the
 * consumer fixture disagree, the pipeline breaks in a way no unit test on either
 * side alone would catch. The CANONICAL_DETAIL_KEYS list below MUST match the
 * consumer fixture's CANONICAL_DETAIL_KEYS.
 *
 * Producer truths this test locks in:
 *   - `amounts` is emitted as-is from DocumentRecord (string[], dollar-formatted).
 *   - Optional fields absent on the record are omitted from the emitted detail
 *     (JSON.stringify drops `undefined`), so consumers must tolerate absence.
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { mockClient } from 'aws-sdk-client-mock'

import { emitDocumentProcessedEvent } from '../../lambdas/processing/utils/emitDocumentProcessedEvent'
import type { DocumentRecord } from '../../lambdas/processing/types'

const ebMock = mockClient(EventBridgeClient)

// Must match bdk-expense-processor consumer fixture CANONICAL_DETAIL_KEYS.
const CANONICAL_DETAIL_KEYS = [
  'tenantId',
  'documentId',
  'documentType',
  'subType',
  'vendorName',
  'vendorDisplay',
  'documentDate',
  'amounts',
  'description',
  'confidence',
  'source',
  'extractedTextUri',
  'originalUri',
]

const fullRecord: DocumentRecord = {
  documentId: '01J8XZQK3P0000000000000001',
  status: 'processed',
  fileType: 'pdf',
  source: 'upload',
  uploadedAt: '2026-07-25T10:00:00.000Z',
  originalUri: 's3://parsely-processed-beta/documents/bdk/01J8XZQK3P0000000000000001/original.pdf',
  extractedTextUri:
    's3://parsely-processed-beta/documents/bdk/01J8XZQK3P0000000000000001/extracted.txt',
  documentDate: '2026-07-25',
  documentType: 'financial',
  subType: 'receipt',
  vendorName: 'franz-bakery',
  vendorDisplay: 'Franz Bakery',
  amounts: ['$475.65'],
  description: 'Franz Bakery delivery receipt for bread products.',
  confidence: 'high',
}

const parseEmittedDetail = () => {
  // arrange helper: pull the single PutEvents call and parse its Detail JSON
  const calls = ebMock.commandCalls(PutEventsCommand)
  expect(calls).toHaveLength(1)
  const entry = calls[0].args[0].input.Entries![0]
  return { entry, detail: JSON.parse(entry.Detail!) as Record<string, unknown> }
}

beforeEach(() => {
  ebMock.reset()
  ebMock.on(PutEventsCommand).resolves({})
})

describe('emitDocumentProcessedEvent — event contract', () => {
  it('emits with the canonical source and detail-type the consumer rule matches', async () => {
    // arrange / act
    await emitDocumentProcessedEvent('bdk', fullRecord)

    // assert — these are the exact values the ExpenseEventStack EventBridge rule filters on
    const { entry } = parseEmittedDetail()
    expect(entry.Source).toBe('parsely.processing')
    expect(entry.DetailType).toBe('DocumentProcessed')
  })

  it('emits detail with EXACTLY the canonical key set (no added/removed fields)', async () => {
    // arrange / act
    await emitDocumentProcessedEvent('bdk', fullRecord)

    // assert — key-set drift on either side breaks the cross-repo contract
    const { detail } = parseEmittedDetail()
    expect(Object.keys(detail).sort()).toEqual([...CANONICAL_DETAIL_KEYS].sort())
  })

  it('emits amounts as dollar-formatted string[] (NOT number[]) — producer truth', async () => {
    // arrange / act
    await emitDocumentProcessedEvent('bdk', fullRecord)

    // assert — the consumer type declares number[]; the wire truth is string[].
    // This test defends the real shape so the mismatch cannot be "fixed" silently
    // on the producer side without a conscious, tested change.
    const { detail } = parseEmittedDetail()
    expect(detail.amounts).toEqual(['$475.65'])
  })

  it('carries tenantId and the S3 URIs the expense processor depends on', async () => {
    // arrange / act
    await emitDocumentProcessedEvent('bdk', fullRecord)

    // assert — expense processor needs these to resolve vendor + fetch text + attach PDF
    const { detail } = parseEmittedDetail()
    expect(detail.tenantId).toBe('bdk')
    expect(detail.extractedTextUri).toBe(fullRecord.extractedTextUri)
    expect(detail.originalUri).toBe(fullRecord.originalUri)
  })

  it('omits optional fields that are undefined on the record (consumers must tolerate absence)', async () => {
    // arrange — a low-confidence doc where Bedrock could not resolve vendor/subType/date
    const minimalRecord: DocumentRecord = {
      documentId: '01J8XZQK3P0000000000000002',
      status: 'needs_review',
      fileType: 'pdf',
      source: 'email',
      uploadedAt: '2026-07-25T10:00:00.000Z',
      originalUri: 's3://parsely-processed-beta/documents/bdk/01J8XZQK3P0000000000000002/original.pdf',
      extractedTextUri:
        's3://parsely-processed-beta/documents/bdk/01J8XZQK3P0000000000000002/extracted.txt',
      documentType: 'financial',
      amounts: ['$12.00'],
    }

    // act
    await emitDocumentProcessedEvent('bdk', minimalRecord)

    // assert — undefined fields are dropped by JSON.stringify, not emitted as null
    const { detail } = parseEmittedDetail()
    expect(detail).not.toHaveProperty('vendorName')
    expect(detail).not.toHaveProperty('subType')
    expect(detail).not.toHaveProperty('documentDate')
    expect(detail.documentType).toBe('financial')
    expect(detail.amounts).toEqual(['$12.00'])
  })
})
