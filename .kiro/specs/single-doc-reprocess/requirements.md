# Spec: Single-Document Reprocess with DocumentProcessed Re-emission (Parsely #2)

> Lane: Parsely (GENERIC — must stay backwards-compatible) · Repo: `data-management-cdk`
> Epic/Issue: `data-management-cdk#1` / `#2` · Status: Draft

## Summary

Add a generic Parsely capability: reprocess ONE document by id and re-emit the canonical
`DocumentProcessed` EventBridge event, so any event-driven consumer can react to a
correction. BDK's expense processor is the first consumer (Path A), but the feature is
tenant/consumer-agnostic.

## Motivation

- `patchDocument` and the legacy bulk `reprocessDocuments` update DynamoDB but emit NO
  event. `emitDocumentProcessedEvent` fires only on the processing happy path.
- There is no way to re-drive a single document and notify downstream.
- The documents Lambda has NO EventBridge permission or env today.

## Goals

- A single-doc reprocess endpoint that re-emits the exact canonical event.
- Tenant-scoped, JWT-authorized, isolated (no cross-tenant reprocess).
- Default behavior is cheap + deterministic (emit stored metadata); re-classification is
  an explicit opt-in (see Parsely #3 decision).

## Non-Goals

- Rewriting the deprecated keyword-based bulk `reprocessDocuments`.
- Any BDK/expense/QBO logic.
- Building the `reclassify` mode implementation (gated by #3; this spec ships `emit-only`
  default and leaves a seam).

## Functional Requirements

- **FR1** New route `POST /documents/{id}/reprocess` (single doc), JWT-authorized,
  tenant-scoped via `extractTenantContext`.
- **FR2** Handler loads the document (tenant-scoped). 404 if not found / other tenant.
- **FR3** Handler calls `emitDocumentProcessedEvent(tenantId, metadata)` with the stored
  metadata → exactly one `DocumentProcessed` event, payload identical to the existing
  emitter (same `Source: parsely.processing`, `DetailType: DocumentProcessed`, fields).
- **FR4** `mode` body param: `emit-only` (default) re-emits stored metadata; `reclassify`
  is reserved/opt-in (impl gated by #3 — may 501/NotImplemented until built, or be
  included if #3 lands first).
- **FR5** Response returns the document id + the mode used + confirmation an event was
  emitted.

## Non-Functional / Backwards-Compatibility Requirements (MANDATORY)

- **BC1** NO change to the `DocumentProcessed` event schema. The payload emitted here is
  byte-compatible with `emitDocumentProcessedEvent`.
- **BC2** NO change to default pipeline behavior or any existing route. The bulk
  `POST /documents/reprocess` keeps working unchanged (route-ordering must not shadow it —
  see Design R1).
- **BC3** Existing consumers unaffected; existing unit/integration tests unchanged + green.
- **BC4** `cdk diff` shows ONLY: the new route + `events:PutEvents` IAM on the documents
  Lambda (+ its new env if any). No other resource/IAM drift.

## Acceptance Criteria (agent-verifiable)

- [ ] `POST /documents/{id}/reprocess` → 200 and emits exactly one `DocumentProcessed`.
- [ ] Emitted detail fields/Source/DetailType identical to `emitDocumentProcessedEvent`.
- [ ] 404 for unknown/other-tenant id; tenant isolation enforced.
- [ ] Bulk `POST /documents/reprocess` still routes to the bulk handler (regression test).
- [ ] Unit test (mock DDB + EventBridge) asserts one `PutEvents` with correct detail.
- [ ] `cdk diff` reviewed — only new route + `events:PutEvents` IAM (+ env) appear.
- [ ] `npm run build` + tests green.

## Open Questions

- **OQ1** (defers to #3) default `mode` = `emit-only`; is `reclassify` in-scope for this PR
  or a follow-up? Recommend: ship `emit-only`, stub `reclassify` → 501 until #3 lands.
