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

---

## DECISION — reclassify mode (Parsely #3, resolved 2026-10-17)

> Resolves GitHub issue `data-management-cdk#3` ("Decide: re-emit current metadata vs
> re-run Bedrock on reprocess"). Supersedes R2 above (the 501 stub is now implemented).

**Contract (final).** `POST /documents/{id}/reprocess` takes a body param `mode`:

| mode | behavior | BC |
| --- | --- | --- |
| `emit-only` (DEFAULT) | re-emit stored metadata via the existing emitter. No metadata change. | unchanged default — existing consumers unaffected |
| `reclassify` (OPT-IN) | re-run Bedrock over the stored `extractedTextUri`, PATCH metadata, emit the fresh `DocumentProcessed`. | strictly additive — same event schema, same emitter |

**Chosen approach: (a) SHARED classification module — NOT (b) invoke the processing Lambda.**

Rationale: avoids cross-Lambda coupling, a second cold-start, and broad IAM
(`lambda:InvokeFunction` + the processing Lambda's whole permission set). The processing
Lambda's classification is ALREADY factored into importable modules, so no refactor of
`processing/` was needed:

- `createBedrockAdapter(modelId)` from `lambdas/processing/adapters/bedrock.ts` — the exact
  Bedrock (Nova Lite) call the ingestion path uses. (Imported directly, not via the
  `adapters/index.ts` factory, so the Documents Lambda bundle does NOT pull in the
  ollama/openai adapters — those carry the pre-existing `tsc` errors tracked in
  `data-management-cdk#5`, and the Documents Lambda is Bedrock-only anyway.)
- `buildBedrockPrompt(tenantId, ddb)` from `lambdas/processing/utils/buildBedrockPrompt.ts`
  — the same tenant-scoped system prompt.
- `saveMetadata(tenantId, record, ddb)` from `lambdas/processing/utils/saveMetadata.ts`
  — re-derives the GSI composite keys (`typeDate`/`vendorDate`/`statusDate`) identically to
  ingestion, so the write stays consistent.
- `emitDocumentProcessedEvent` — the SAME unchanged emitter (schema untouched → BC1 holds
  for `reclassify` too).

**NOTHING in `lambdas/processing/` was modified** — the classification pieces were already
importable; this handler just composes them.

**reclassify flow (in `handlers/reprocessOne.ts`):**
1. Load doc tenant-scoped (`{ tenantId, documentId }`) → 404 if absent/cross-tenant.
2. `409 NO_EXTRACTED_TEXT` if the doc has no `extractedTextUri` (nothing to reclassify).
3. Fetch the stored extracted text from the processed bucket (no re-OCR) via a new
   `lambdas/documents/utils/fetchExtractedText.ts` (mirrors the presign utils: bucket from
   `PROCESSED_BUCKET` env, key stripped from the `s3://` URI).
4. `buildBedrockPrompt` + `llm.analyze` → fresh documentType/subType/vendor/date/amounts/…
5. Derive status (`needs_review` on low-confidence/unknown) exactly as processing does.
6. `saveMetadata` the patched record — classification fields refreshed; identity/storage
   fields (`documentId`/`source`/`fileType`/`uploadedAt`/`*Uri`) PRESERVED. `uploadedAt` is
   intentionally kept (reclassification is not a re-upload) so `statusDate` stays meaningful.
7. Emit `DocumentProcessed` via the existing emitter.
8. Respond `{ documentId, mode: 'reclassify', reclassified: true, documentType, subType,
   vendorName, confidence, status }`.

**CDK (`lib/stacks/api-stack.ts`) — minimal additive diff on the Documents Lambda only:**
- IAM: `bedrock:InvokeModel` scoped to the Nova Lite ARNs (base foundation-model +
  cross-region id foundation-model + the account/region inference-profile) — NOT `*`.
  (S3 read of the processed bucket, config-table read, document-table write, and
  `events:PutEvents` were ALREADY granted for emit-only / existing routes — reclassify adds
  no further grants beyond Bedrock.)
- Env: `LLM_PROVIDER=bedrock`, `LLM_MODEL_ID=us.amazon.nova-lite-v1:0` (mirrors the
  processing Lambda; the adapter would default to these anyway, but set explicitly).
- No route change (the route already exists from #2).
