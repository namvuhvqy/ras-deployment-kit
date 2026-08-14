# RAS Roadmap

## Post V1 — active implementation

**Current state: Slice 1 implemented locally; awaiting independent Codex QA.**

| Slice | Scope | State |
|---|---|---|
| P1 Post Core | Opaque durable connection references; customer-safe capability discovery; draft create/list/detail; tenant session/PAT scope enforcement; idempotency; OpenAPI/Agent-tool contracts | `IMPLEMENTED — QA PENDING` |
| P2 Posts workspace | Read-only Posts workspace and customer-safe status/history UI | `PLANNED` |
| P3 Composer | Account selection, content editor, local draft UX through the P1 API | `PLANNED` |
| P4 Schedule dry-run | Explicit dry-run schedule flow; no provider mutation | `PLANNED` |
| P5 Provider execution | Separately approved bounded provider publish/schedule execution and webhook lifecycle | `BLOCKED — separate approval required` |

### Post V1 boundaries

- No Payment, Inbox, Ads, Production, provider call, worker/job enqueue, media upload, or live publish in P1.
- Media is explicitly unsupported in P1: public media arrays must be empty.
- P1 reserves projection states `scheduled`, `publishing`, `published`, and `failed`; only `draft` is mutable/created.
- Multiple platforms use one Post Core plus per-connection capability fields. They do not create independent platform flows.

### Future backlog

- Media asset upload/validation and platform-specific media constraints.
- Separately-approved live provider publish and real scheduling.
- Rich multi-platform capability adapters and advanced platform formats.
- Durable execution history/retries and customer-safe lifecycle projection after execution is approved.

## Payment Slice A

`PASS — Backend Staging checkpoint preserved. STOPPED.` Follow-up capture/outbox/provider work requires a separate Owner approval.

## Other lanes

Inbox, Ads, and Production remain outside Post V1 and unchanged.
