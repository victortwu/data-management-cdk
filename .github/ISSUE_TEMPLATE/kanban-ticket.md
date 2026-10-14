---
name: Kanban ticket (Parsely lane)
about: Agent-verifiable work item for the generic Parsely document-intelligence service
title: "[Parsely] <concise outcome>"
labels: ["lane:parsely"]
---

## Context
<!-- Why this exists. Parsely is a GENERIC multi-tenant service. Link the epic. -->

## Problem
<!-- The gap/defect in generic terms. BDK may be the first consumer, but the
     feature must serve ANY tenant/consumer. -->

## Scope
<!-- What changes in data-management-cdk. Keep tightly bounded. -->

## Acceptance Criteria
- [ ]
- [ ]
- [ ] **BACKWARDS COMPATIBILITY (mandatory):** No change to the existing
      `DocumentProcessed` event schema or default pipeline behavior for existing
      consumers. New capability is additive and opt-in. Existing tests unchanged
      and green.
- [ ] Build passes (`npm run build`), unit + integration tests green
- [ ] `cdk diff` reviewed; only intended resources change (cite the diff)

## Dependencies
<!-- Blocking/blocked-by tickets. Cross-link cross-lane deps (e.g., BDK consumers). -->

## Out of Scope
<!-- No BDK-specific/expense/QBO logic belongs in this lane. State it. -->

## Notes / Risks
