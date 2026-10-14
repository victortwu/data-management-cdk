# Design: Single-Document Reprocess (Parsely #2)

> Lane: Parsely · Repo: `data-management-cdk`

## Route placement — the ordering gotcha (R1)

The documents router (`lambdas/documents/index.ts`) matches by string:

```ts
if (method === 'POST' && path.endsWith('/documents/reprocess')) return reprocessDocuments(...)
```

The new single-doc route is `POST /documents/{id}/reprocess`. API Gateway treats
`/documents/reprocess` and `/documents/{id}/reprocess` as DISTINCT routes (literal vs
templated), so no gateway collision. But the **router's `endsWith` check** matters:
`/documents/abc123/reprocess`.endsWith('/documents/reprocess') === false, so it will NOT
be mis-routed to the bulk handler — good. Still, add the single-doc check explicitly and
place it BEFORE the generic `id` GET/PATCH branches:

```ts
if (method === 'POST' && path.endsWith('/documents/reprocess') && !id)
  return reprocessDocuments(tenantId, ddb)           // bulk (existing)
if (method === 'POST' && id && path.endsWith('/reprocess'))
  return reprocessOne(tenantId, id, event, ddb)       // NEW single-doc
```

Note `event.pathParameters?.id` is populated for the templated route, so `id` presence
cleanly distinguishes the two. Add a regression test asserting the bulk route still hits
`reprocessDocuments`.

## Handler: `handlers/reprocessOne.ts`

```ts
export const reprocessOne = async (tenantId, id, event, ddb) => {
  const mode = JSON.parse(event.body ?? '{}').mode ?? 'emit-only'
  const doc = await ddb.send(new GetCommand({
    TableName: DOCUMENT_TABLE, Key: { tenantId, documentId: id },
  }))
  if (!doc.Item) return respond(404, { error: 'NOT_FOUND', ... })

  if (mode === 'reclassify') return respond(501, { error: 'NOT_IMPLEMENTED', ... }) // gated by #3

  await emitDocumentProcessedEvent(tenantId, doc.Item as DocumentRecord)
  return respond(200, { documentId: id, mode, emitted: true })
}
```

- Reuses the EXISTING `emitDocumentProcessedEvent` util verbatim → guarantees schema
  compatibility (BC1). No new event shape.
- Tenant isolation: `Key: { tenantId, documentId }` — a doc belonging to another tenant
  simply isn't found → 404. No cross-tenant reprocess possible (FR2/BC).

## CDK changes (`lib/stacks/api-stack.ts`)

The documents Lambda currently has NO EventBridge access. Add:

1. **IAM**: `events:PutEvents` on the default event bus for `documentsLambda`
   (mirror how the processing Lambda is granted in the processing stack — scope to the
   default bus ARN).
2. **Env (if the emitter needs it)**: `emitDocumentProcessedEvent` uses a default
   `EventBridgeClient` (no bus env var — it targets the default bus implicitly). Confirm;
   likely NO new env var needed. If the processing Lambda sets an `EVENT_BUS` env, mirror it.
3. **Route**: add
   `this.api.addRoutes({ path: '/documents/{id}/reprocess', methods: [POST], integration: docsInt, authorizer })`.

`cdk diff` must show ONLY these (BC4). The bulk route, all other routes, and every other
resource stay byte-identical.

## Backwards-compatibility proof plan

- Keep `emitDocumentProcessedEvent` untouched → event schema unchanged (BC1).
- Add route + IAM only → no existing behavior changes (BC2/BC3).
- Regression test: bulk `POST /documents/reprocess` still → `reprocessDocuments`.
- `cdk diff` cited in the PR showing the minimal change set (BC4).

## Risks

- **R2 — reclassify scope creep.** Default to `emit-only`; return 501 for `reclassify`
  until #3 decides the contract + shared-classification approach. Keeps this PR small and
  backwards-safe.
- **R3 — EventBridge IAM over-grant.** Scope `PutEvents` to the default bus ARN, not `*`.
