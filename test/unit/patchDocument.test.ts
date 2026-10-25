/**
 * Handler unit test — patchDocument optimistic concurrency (Parsely #4).
 * ────────────────────────────────────────────────────────────────────────────
 * Mocks DynamoDB (aws-sdk-client-mock). Asserts:
 *   - backwards compat: a request with NO `version` still succeeds and the
 *     UpdateCommand carries ONLY the legacy attribute_exists guard (no version
 *     condition, no version SET) → existing clients are unaffected.
 *   - versioned happy path: matching `version` succeeds, the condition guards on
 *     the supplied version, and the stored version is bumped by 1.
 *   - stale version → 409 CONFLICT (re-read reveals the doc still exists) with
 *     the real currentVersion so a frontend can translate it to "reload".
 *   - versioned write against a missing doc → 404 (re-read reveals absence),
 *     NOT 409 — the disambiguation requirement.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb'
import { mockClient } from 'aws-sdk-client-mock'

import { patchDocument } from '../../lambdas/documents/handlers/patchDocument'

const ddbMock = mockClient(DynamoDBDocumentClient)

const TENANT = 'bdk'
const DOC_ID = '01J8XZQK3P0000000000000001'

// Minimal event factory — patchDocument only reads event.body.
const makeEvent = (body?: Record<string, unknown>) =>
  ({ body: body ? JSON.stringify(body) : undefined }) as any

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

// A ConditionalCheckFailedException mirrors what DynamoDB throws on a failed
// ConditionExpression (name is what the handler branches on).
const conditionalCheckFailure = () => {
  const err = new Error('The conditional request failed')
  err.name = 'ConditionalCheckFailedException'
  return err
}

beforeEach(() => {
  ddbMock.reset()
})

describe('patchDocument — backwards compat (no version supplied)', () => {
  it('succeeds unchanged and uses ONLY the attribute_exists guard', async () => {
    // arrange — no GSI-key fields changing (reviewNotes only) → no pre-read GET
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { documentId: DOC_ID, reviewNotes: 'looks good' },
    })

    // act
    const res = await patchDocument(TENANT, DOC_ID, makeEvent({ reviewNotes: 'looks good' }), ddb)

    // assert — response unchanged
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ documentId: DOC_ID, reviewNotes: 'looks good' })

    // assert — update carries the legacy guard, no version machinery
    const updateCalls = ddbMock.commandCalls(UpdateCommand)
    expect(updateCalls).toHaveLength(1)
    const input = updateCalls[0].args[0].input
    expect(input.ConditionExpression).toBe('attribute_exists(documentId)')
    expect(input.UpdateExpression).not.toContain('version')
    expect(input.ExpressionAttributeValues).not.toHaveProperty(':newVersion')
    expect(input.ExpressionAttributeValues).not.toHaveProperty(':expectedVersion')
  })
})

describe('patchDocument — versioned happy path', () => {
  it('guards on the supplied version and bumps the stored version by 1', async () => {
    // arrange — matching version, stored bumped to 4 on ALL_NEW
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { documentId: DOC_ID, reviewNotes: 'edited', version: 4 },
    })

    // act
    const res = await patchDocument(
      TENANT,
      DOC_ID,
      makeEvent({ reviewNotes: 'edited', version: 3 }),
      ddb,
    )

    // assert — response carries the bumped version
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ documentId: DOC_ID, version: 4 })

    // assert — condition guards on current version, SET bumps to +1
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input
    expect(input.ConditionExpression).toContain('if_not_exists(#version, :zero) = :expectedVersion')
    expect(input.ExpressionAttributeValues?.[':expectedVersion']).toBe(3)
    expect(input.ExpressionAttributeValues?.[':newVersion']).toBe(4)
    expect(input.UpdateExpression).toContain('#version = :newVersion')
  })
})

describe('patchDocument — versioned conflict (stale version)', () => {
  it('returns 409 CONFLICT with the real currentVersion when the doc still exists', async () => {
    // arrange — conditional write fails; re-read shows the doc at version 5
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailure())
    ddbMock.on(GetCommand).resolves({ Item: { documentId: DOC_ID, version: 5 } })

    // act — client thinks it's still version 3
    const res = await patchDocument(
      TENANT,
      DOC_ID,
      makeEvent({ reviewNotes: 'stale edit', version: 3 }),
      ddb,
    )

    // assert
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({
      error: 'CONFLICT',
      message: 'Document changed; reload and retry',
      currentVersion: 5,
    })
  })
})

describe('patchDocument — versioned write against a missing doc', () => {
  it('returns 404 (not 409) when the re-read shows the doc is absent', async () => {
    // arrange — conditional write fails; re-read shows nothing
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailure())
    ddbMock.on(GetCommand).resolves({ Item: undefined })

    // act
    const res = await patchDocument(
      TENANT,
      DOC_ID,
      makeEvent({ reviewNotes: 'edit', version: 1 }),
      ddb,
    )

    // assert
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'NOT_FOUND', message: 'Document not found' })
  })
})
