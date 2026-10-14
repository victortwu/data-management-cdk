/**
 * Router regression test — documents Lambda (Parsely #2).
 * ────────────────────────────────────────────────────────────────────────────
 * The single-doc route `POST /documents/{id}/reprocess` must NOT shadow the
 * EXISTING bulk route `POST /documents/reprocess`. The router distinguishes them
 * by `id` presence (event.pathParameters?.id). This test mocks both handlers and
 * asserts dispatch is correct in BOTH directions:
 *   - bulk  (no id)       → reprocessDocuments   (BACKWARDS-COMPAT GATE)
 *   - single (id present) → reprocessOne
 */
import { respond } from '../../lambdas/shared/utils/respond'

// Mock the two reprocess handlers so we can observe which one the router calls.
jest.mock('../../lambdas/documents/handlers/reprocessDocuments', () => ({
  reprocessDocuments: jest.fn(async () => respond(200, { message: 'bulk' })),
}))
jest.mock('../../lambdas/documents/handlers/reprocessOne', () => ({
  reprocessOne: jest.fn(async () => respond(200, { message: 'single' })),
}))

import { handler } from '../../lambdas/documents/index'
import { reprocessDocuments } from '../../lambdas/documents/handlers/reprocessDocuments'
import { reprocessOne } from '../../lambdas/documents/handlers/reprocessOne'

const makeEvent = (opts: { method: string; rawPath: string; id?: string; body?: string }) =>
  ({
    rawPath: opts.rawPath,
    body: opts.body,
    pathParameters: opts.id ? { id: opts.id } : undefined,
    requestContext: {
      http: { method: opts.method },
      authorizer: { jwt: { claims: { 'custom:tenantId': 'bdk', sub: 'user-1' } } },
    },
  }) as any

beforeEach(() => {
  jest.clearAllMocks()
})

describe('documents router — reprocess dispatch', () => {
  it('POST /documents/reprocess (no id) still routes to reprocessDocuments (bulk)', async () => {
    // act
    const res = await handler(
      makeEvent({ method: 'POST', rawPath: '/documents/reprocess' }),
      {} as any,
      {} as any,
    )

    // assert — bulk handler hit, single-doc handler NOT
    expect(reprocessDocuments).toHaveBeenCalledTimes(1)
    expect(reprocessOne).not.toHaveBeenCalled()
    expect(JSON.parse((res as any).body).message).toBe('bulk')
  })

  it('POST /documents/{id}/reprocess (id present) routes to reprocessOne (single)', async () => {
    // act
    const res = await handler(
      makeEvent({
        method: 'POST',
        rawPath: '/documents/abc123/reprocess',
        id: 'abc123',
        body: JSON.stringify({ mode: 'emit-only' }),
      }),
      {} as any,
      {} as any,
    )

    // assert — single-doc handler hit, bulk handler NOT
    expect(reprocessOne).toHaveBeenCalledTimes(1)
    expect(reprocessDocuments).not.toHaveBeenCalled()
    expect(JSON.parse((res as any).body).message).toBe('single')
  })
})
