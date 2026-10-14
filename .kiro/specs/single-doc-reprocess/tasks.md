# Tasks: Single-Document Reprocess (Parsely #2)

> Lane: Parsely · Repo: `data-management-cdk` · Issue: `data-management-cdk#2`

## T1 — Handler
- [ ] Add `lambdas/documents/handlers/reprocessOne.ts` per design.
- [ ] Load doc tenant-scoped; 404 if absent.
- [ ] `mode` param: `emit-only` (default) → `emitDocumentProcessedEvent(tenantId, doc)`;
      `reclassify` → 501 (gated by Parsely #3).
- [ ] Return `{ documentId, mode, emitted: true }`.

## T2 — Router wiring
- [ ] In `lambdas/documents/index.ts`, add the single-doc branch using `id` presence to
      distinguish from the bulk route; place correctly (see design R1).
- [ ] Confirm bulk `POST /documents/reprocess` still routes to `reprocessDocuments`.

## T3 — CDK (api-stack)
- [ ] Grant `events:PutEvents` (default bus, scoped ARN) to `documentsLambda`.
- [ ] Add route `POST /documents/{id}/reprocess` → `docsInt` with authorizer.
- [ ] Confirm no new env var needed (emitter targets default bus); mirror processing
      Lambda if it uses one.

## T4 — Tests
- [ ] Unit (mock DDB + EventBridge): emit-only → exactly one `PutEvents`, detail fields
      identical to `emitDocumentProcessedEvent`; 404 for missing/other-tenant;
      reclassify → 501.
- [ ] Regression: bulk reprocess route still hits `reprocessDocuments`.
- [ ] CDK assertion test: new route exists; `events:PutEvents` present on documents role.

## T5 — Verify (backwards-compat gates)
- [ ] `npm run build` + unit + integration tests green (existing tests UNCHANGED).
- [ ] `cdk diff` reviewed and cited: ONLY new route + `events:PutEvents` IAM (+ env if any).
- [ ] Confirm `DocumentProcessed` schema untouched (emitter file unchanged in the diff).

## Out of scope / follow-ups
- `reclassify` mode implementation → Parsely #3 (decision) then a follow-up PR.
- `patchDocument` optimistic concurrency → Parsely #4.
- BDK Path A wiring consumes this endpoint → `bdk-data-management-frontend#4`.
