# Zernio upstream UI integration inventory

Updated: 2026-08-04

This inventory distinguishes code that RunAgentSys actually runs from upstream projects used only as design or component references. Similar UI or API concepts are not evidence of direct integration.

## Classification

| Upstream | Audited revision | Current RAS status | Reusable scope | RAS boundary |
|---|---|---|---|---|
| [`zernio-dev/unified-inbox`](https://github.com/zernio-dev/unified-inbox) | `3d62be18923df6fa22fa01037a2057254553206d` | **Controlled adaptation implemented. Not a direct upstream deployment or import.** | Conversation/thread shell, filters, draft composer, lifecycle and rate-limit UX patterns. | Browser calls same-origin, session-scoped RAS APIs. Draft → explicit approval → idempotent worker send remains mandatory. No raw Zernio key or direct-send provider route is exposed. |
| [`zernio-dev/latewiz`](https://github.com/zernio-dev/latewiz) | `28dd018063b955769de11f881acd03bb64c61cd4` | **Not integrated. Backend scheduling primitives/contracts exist, but no LateWiz UI is imported or run.** | Composer, calendar, post cards, timezone/schedule picker, queue and media UX. | Build customer-facing RAS post APIs first. Tenant/account identity comes from the RAS session; provider credentials remain server/worker-only. Preview/draft must not publish. |
| [`zernio-dev/ads-dashboard`](https://github.com/zernio-dev/ads-dashboard) | `4386eddc9a35c2b93c392d8523d148b0f95a62eb` | **Not integrated. Current marketing copy mentioning Ads is not an Ads product implementation.** | KPI cards, date range, spend/CTR/CPC/CPM/ROAS charts, campaign/ad-set/ad drill-down and creative preview. | Add read-only, tenant-scoped RAS Ads APIs and entitlement/account ownership checks before UI work. No provider key or arbitrary account ID in the browser. No campaign/budget mutation or live Ads action without a separate approved gate. |
| [`zernio-dev/zernflow`](https://github.com/zernio-dev/zernflow) | `e8a0a16f2de46b86e506edbfe06c192f3cb1390a` | **Not integrated. Design/reference candidate only.** | Visual flow canvas, node palette, versions/publish, simulator, sequences, contacts and analytics information architecture. | RAS owns tenant authz, graph/version persistence and compilation to worker jobs. Published graphs cannot bypass approval/idempotency. HTTP/action nodes require SSRF controls, allowlists and secret isolation. |

## Evidence in the current RAS codebase

- The Inbox assessment and adapter contract are documented in `docs/UNIFIED_INBOX_INTEGRATION_ASSESSMENT.md`.
- The backend implements tenant-scoped Inbox read/draft/approval and worker-only delivery; the frontend implements the corresponding same-origin Inbox shell.
- Repository-wide searches found no direct imports, package dependencies, vendored source, runtime services or route namespaces for `latewiz`, `ads-dashboard` or `zernflow`.
- Generic product/marketing references to scheduling, campaigns, Ads or workflows are not classified as implementation evidence.

## Approved implementation order

1. **OAuth production gate — complete:** the production broker emits `https://ras-api.runagentsys.com/auth/google/callback`; Google accepts both Production and Staging redirect URIs.
2. **Scheduling / LateWiz adaptation:** define tenant-safe post/list/detail/schedule APIs, then adapt Composer and Calendar in an isolated frontend branch. Safe tests cover no-session, cross-tenant ownership, timezone conversion, draft/preview no-publish and idempotent schedule mutation.
3. **Ads reporting:** implement read-only account/KPI/timeline/campaign contracts and entitlement gates before adapting dashboard components. Initial release cannot create, edit, enable, pause or change campaign budgets.
4. **ZernFlow automation builder:** begin with versioned draft graphs and a no-side-effect simulator. Publishing/execution remains a later human-gated worker capability with SSRF and secret boundaries.

## Release gates

- Every adaptation uses clean split-repository branches and preserves applicable upstream license/attribution.
- Backend contract and tenant-isolation tests pass before frontend implementation.
- Preview and Staging smoke precede Production; Production alias/deploy changes require a separate approved release gate.
- Inbox smoke must not send another DM. Scheduling smoke must not publish. Ads smoke must be read-only. Flow-builder smoke must run in simulator/draft mode only.
