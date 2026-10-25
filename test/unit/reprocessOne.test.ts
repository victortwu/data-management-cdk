/**
 * Handler unit test — single-doc reprocess (Parsely #2 + #3).
 * ────────────────────────────────────────────────────────────────────────────
 * Mocks DynamoDB + EventBridge + S3 + Bedrock. Asserts:
 *   - emit-only (default) → doc loaded tenant-scoped, exactly ONE PutEvents whose
 *     detail / Source / DetailType are IDENTICAL to emitDocumentProcessedEvent
 *     (the reused emitter is the single source of truth → schema is BC-safe).
 *   - 404 when the document is absent (covers unknown id AND other-tenant, since
 *     the Key is { tenantId, documentId } → another tenant's doc is simply absent).
 *   - reclassify (Parsely #3) → fetches stored extracted text, re-runs the shared
 *     Bedrock classifier, PATCHES metadata (with re-derived GSI keys), and emits the
 *     fresh DocumentProcessed via the UNCHANGED emitter. emit-only stays untouched.
 *   - reclassify on a missing doc → 404 (no S3/Bedrock/PutEvents/Put).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { mockClient } from 'aws-sdk-client-mock'

import { reprocessOne } from '../../lambdas/documents/handlers/reprocessOne'
import type { DocumentRecord } from '../../lambdas/processing/types'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ebMock = mockClient(EventBridgeClient)
const s3Mock = mockClient(S3Client)
const bedrockMock = mockClient(BedrockRuntimeClient)

const TENANT = 'bdk'
const OTHER_TENANT = 'acme'
const DOC_ID = '01J8XZQK3P0000000000000001'

const storedDoc: DocumentRecord = {
  documentId: DOC_ID,
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

// Minimal event factory — only the fields reprocessOne reads (body).
const makeEvent = (body?: Record<string, unknown>) =>
  ({ body: body ? JSON.stringify(body) : undefined }) as any

// Encode a Bedrock Nova response body (Uint8Array) carrying the given analysis JSON.
const bedrockBody = (analysis: Record<string, unknown>) =>
  new TextEncoder().encode(
    JSON.stringify({ output: { message: { content: [{ text: JSON.stringify(analysis) }] } } }),
  )

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

beforeEach(() => {
  ddbMock.reset()
  ebMock.reset()
  s3Mock.reset()
  bedrockMock.reset()
  ebMock.on(PutEventsCommand).resolves({})
})

describe('reprocessOne — emit-only (default)', () => {
  it('loads the doc tenant-scoped and emits exactly one DocumentProcessed event', async () => {
    // arrange
    ddbMock.on(GetCommand).resolves({ Item: storedDoc as any })

    // act
    const res = await reprocessOne(TENANT, DOC_ID, makeEvent(), ddb)

    // assert — response
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ documentId: DOC_ID, mode: 'emit-only', emitted: true })

    // assert — doc loaded tenant-scoped
    const getCalls = ddbMock.commandCalls(GetCommand)
    expect(getCalls).toHaveLength(1)
    expect(getCalls[0].args[0].input.Key).toEqual({ tenantId: TENANT, documentId: DOC_ID })

    // assert — exactly one PutEvents; NO classification side effects (no S3, Bedrock, Put)
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1)
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0)
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0)
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0)
  })

  it('emits detail/Source/DetailType IDENTICAL to emitDocumentProcessedEvent', async () => {
    // arrange
    ddbMock.on(GetCommand).resolves({ Item: storedDoc as any })

    // act
    await reprocessOne(TENANT, DOC_ID, makeEvent({ mode: 'emit-only' }), ddb)

    // assert — reconstruct the exact entry the shared emitter would have produced
    const entry = ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
    expect(entry.Source).toBe('parsely.processing')
    expect(entry.DetailType).toBe('DocumentProcessed')

    const expectedDetail = {
      tenantId: TENANT,
      documentId: storedDoc.documentId,
      documentType: storedDoc.documentType,
      subType: storedDoc.subType,
      vendorName: storedDoc.vendorName,
      vendorDisplay: storedDoc.vendorDisplay,
      documentDate: storedDoc.documentDate,
      amounts: storedDoc.amounts,
      description: storedDoc.description,
      confidence: storedDoc.confidence,
      source: storedDoc.source,
      extractedTextUri: storedDoc.extractedTextUri,
      originalUri: storedDoc.originalUri,
    }
    // Byte-compatible: parsing the emitted Detail yields exactly the emitter's shape.
    expect(JSON.parse(entry.Detail!)).toEqual(expectedDetail)
  })
})

describe('reprocessOne — not found / tenant isolation', () => {
  it('returns 404 when the document is absent (unknown id)', async () => {
    // arrange
    ddbMock.on(GetCommand).resolves({})

    // act
    const res = await reprocessOne(TENANT, 'does-not-exist', makeEvent(), ddb)

    // assert
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toBe('NOT_FOUND')
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0)
  })

  it('returns 404 for another tenant (key is {tenantId, documentId} → not found)', async () => {
    // arrange — querying as OTHER_TENANT for a doc that only exists under TENANT.
    // The composite Key means DDB returns no Item → 404. Assert the query used the
    // caller's tenantId (never the doc's) so cross-tenant reprocess is impossible.
    ddbMock.on(GetCommand).resolves({})

    // act
    const res = await reprocessOne(OTHER_TENANT, DOC_ID, makeEvent(), ddb)

    // assert
    expect(res.statusCode).toBe(404)
    const getCalls = ddbMock.commandCalls(GetCommand)
    expect(getCalls[0].args[0].input.Key).toEqual({ tenantId: OTHER_TENANT, documentId: DOC_ID })
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0)
  })
})

describe('reprocessOne — reclassify (Parsely #3)', () => {
  it('fetches stored text, re-runs Bedrock, patches metadata, and emits the fresh event', async () => {
    // arrange — doc exists; buildBedrockPrompt Query → config; S3 → stored text;
    // Bedrock → a DIFFERENT classification than what is stored (tax, not financial).
    ddbMock.on(GetCommand).resolves({ Item: storedDoc as any })
    ddbMock.on(QueryCommand).resolves({ Items: [] }) // no tenant config → prompt uses defaults
    ddbMock.on(PutCommand).resolves({})
    s3Mock
      .on(GetObjectCommand)
      .resolves({ Body: { transformToString: async () => 'FRANZ BAKERY INVOICE ...' } } as any)
    bedrockMock.on(InvokeModelCommand).resolves({
      body: bedrockBody({
        documentType: 'tax',
        subType: 'notice',
        vendorName: 'irs',
        documentDate: '2026-08-01',
        amounts: ['$1,000.00'],
        description: 'IRS notice after reclassification.',
        confidence: 'high',
      }),
    } as any)

    // act
    const res = await reprocessOne(TENANT, DOC_ID, makeEvent({ mode: 'reclassify' }), ddb)

    // assert — response reflects the fresh classification
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      documentId: DOC_ID,
      mode: 'reclassify',
      reclassified: true,
      documentType: 'tax',
      subType: 'notice',
      vendorName: 'irs',
      confidence: 'high',
      status: 'processed',
    })

    // assert — stored text fetched (key derived from the s3:// URI), Bedrock invoked once
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1)
    expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input.Key).toBe(
      'documents/bdk/01J8XZQK3P0000000000000001/extracted.txt',
    )
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(1)

    // assert — metadata PATCHED: fresh classification fields + re-derived GSI keys,
    // identity/storage fields preserved.
    const putCalls = ddbMock.commandCalls(PutCommand)
    expect(putCalls).toHaveLength(1)
    const item = putCalls[0].args[0].input.Item as any
    expect(item.tenantId).toBe(TENANT)
    expect(item.documentId).toBe(DOC_ID)
    expect(item.documentType).toBe('tax')
    expect(item.subType).toBe('notice')
    expect(item.vendorName).toBe('irs')
    expect(item.amounts).toEqual(['$1,000.00'])
    expect(item.status).toBe('processed')
    // preserved identity/storage fields
    expect(item.uploadedAt).toBe(storedDoc.uploadedAt)
    expect(item.originalUri).toBe(storedDoc.originalUri)
    expect(item.extractedTextUri).toBe(storedDoc.extractedTextUri)
    expect(item.source).toBe('upload')
    // re-derived GSI composite keys (saveMetadata)
    expect(item.typeDate).toBe('tax#2026-08-01')
    expect(item.vendorDate).toBe('irs#2026-08-01')
    expect(item.statusDate).toBe(`processed#${storedDoc.uploadedAt}`)

    // assert — emitted DocumentProcessed carries the FRESH classification (schema unchanged)
    const ebCalls = ebMock.commandCalls(PutEventsCommand)
    expect(ebCalls).toHaveLength(1)
    const entry = ebCalls[0].args[0].input.Entries![0]
    expect(entry.Source).toBe('parsely.processing')
    expect(entry.DetailType).toBe('DocumentProcessed')
    const detail = JSON.parse(entry.Detail!)
    expect(detail.documentType).toBe('tax')
    expect(detail.vendorName).toBe('irs')
    expect(detail.tenantId).toBe(TENANT)
    expect(detail.documentId).toBe(DOC_ID)
  })

  it('derives needs_review status when the model is low-confidence', async () => {
    // arrange
    ddbMock.on(GetCommand).resolves({ Item: storedDoc as any })
    ddbMock.on(QueryCommand).resolves({ Items: [] })
    ddbMock.on(PutCommand).resolves({})
    s3Mock
      .on(GetObjectCommand)
      .resolves({ Body: { transformToString: async () => 'ambiguous text' } } as any)
    bedrockMock.on(InvokeModelCommand).resolves({
      body: bedrockBody({
        documentType: 'unknown',
        confidence: 'low',
        flagReason: 'could not determine type',
      }),
    } as any)

    // act
    const res = await reprocessOne(TENANT, DOC_ID, makeEvent({ mode: 'reclassify' }), ddb)

    // assert
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('needs_review')
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as any
    expect(item.status).toBe('needs_review')
    expect(item.reviewReason).toBe('could not determine type')
  })

  it('returns 404 for a missing doc WITHOUT touching S3 / Bedrock / emitter', async () => {
    // arrange
    ddbMock.on(GetCommand).resolves({})

    // act
    const res = await reprocessOne(TENANT, 'nope', makeEvent({ mode: 'reclassify' }), ddb)

    // assert
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toBe('NOT_FOUND')
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0)
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0)
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0)
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0)
  })

  it('returns 409 when the doc has no stored extracted text', async () => {
    // arrange — a doc missing extractedTextUri cannot be reclassified.
    const noText = { ...storedDoc, extractedTextUri: undefined }
    ddbMock.on(GetCommand).resolves({ Item: noText as any })

    // act
    const res = await reprocessOne(TENANT, DOC_ID, makeEvent({ mode: 'reclassify' }), ddb)

    // assert
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('NO_EXTRACTED_TEXT')
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0)
    expect(bedrockMock.commandCalls(InvokeModelCommand)).toHaveLength(0)
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0)
  })
})
