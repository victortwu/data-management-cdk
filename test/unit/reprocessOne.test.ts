/**
 * Handler unit test — single-doc reprocess (Parsely #2).
 * ────────────────────────────────────────────────────────────────────────────
 * Mocks DynamoDB + EventBridge. Asserts:
 *   - emit-only (default) → doc loaded tenant-scoped, exactly ONE PutEvents whose
 *     detail / Source / DetailType are IDENTICAL to emitDocumentProcessedEvent
 *     (the reused emitter is the single source of truth → schema is BC-safe).
 *   - 404 when the document is absent (covers unknown id AND other-tenant, since
 *     the Key is { tenantId, documentId } → another tenant's doc is simply absent).
 *   - reclassify → 501 NOT_IMPLEMENTED (gated by Parsely #3), and NO event emitted.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { mockClient } from 'aws-sdk-client-mock'

import { reprocessOne } from '../../lambdas/documents/handlers/reprocessOne'
import type { DocumentRecord } from '../../lambdas/processing/types'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ebMock = mockClient(EventBridgeClient)

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

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

beforeEach(() => {
  ddbMock.reset()
  ebMock.reset()
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

    // assert — exactly one PutEvents
    const ebCalls = ebMock.commandCalls(PutEventsCommand)
    expect(ebCalls).toHaveLength(1)
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

describe('reprocessOne — reclassify (gated by Parsely #3)', () => {
  it('returns 501 NOT_IMPLEMENTED and emits NO event', async () => {
    // arrange — doc exists; reclassify must still be refused.
    ddbMock.on(GetCommand).resolves({ Item: storedDoc as any })

    // act
    const res = await reprocessOne(TENANT, DOC_ID, makeEvent({ mode: 'reclassify' }), ddb)

    // assert
    expect(res.statusCode).toBe(501)
    expect(JSON.parse(res.body).error).toBe('NOT_IMPLEMENTED')
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0)
  })
})
