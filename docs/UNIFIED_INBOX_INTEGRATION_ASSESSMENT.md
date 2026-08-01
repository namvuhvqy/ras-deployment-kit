# Unified Inbox Integration Assessment — RAS Phase 6A

Updated: 2026-08-01
Candidate: `https://github.com/zernio-dev/unified-inbox`
Audited revision: `3d62be18923df6fa22fa01037a2057254553206d`
Decision: **controlled UI adaptation; do not deploy upstream as a RAS production service**

## 1. Findings

| Area | Finding | RAS decision |
|---|---|---|
| License | MIT | Allowed for controlled adaptation with attribution/license retention. |
| Stack | Next.js 15, React 19, Tailwind 4, React Query | Compatible conceptually; dependency versions must be reconciled in an isolated branch. |
| Security | No app authentication; a single Zernio API key proxies provider APIs | Not acceptable for RAS production. Never add `ZERNIO_API_KEY` to the RAS web app. |
| Data | Stateless, provider-centric, account selection stored in cookie | RAS persistent store remains source of truth for tenant/account/conversation/draft state. |
| Writes | Supports direct send, outbound DMs, block/unblock, calls and provider features | Exclude. RAS retains draft → explicit approval → idempotent worker send. |
| Polling | React Query polling + global 429 latch | Reuse UX pattern only; RAS API owns rate limits and returns `Retry-After`. |
| UI | Conversation list, filters, thread, composer, responsive/dark UI | Good candidate for visual/component reference. |

## 2. Required RAS adapter boundary

The adapted UI calls same-origin RAS session proxy routes only. Browser requests cannot carry raw provider keys or arbitrary `customerId`.

| UI need | RAS source | Required scope |
|---|---|---|
| Conversation list | `GET /customers/:customerId/inbox/conversations` via session-derived proxy | `inbox:read` |
| Thread messages | `GET /customers/:customerId/inbox/conversations/:conversationId/messages` | `inbox:read` |
| Create draft | `POST .../drafts` | `inbox:draft` |
| Approve draft | `POST .../drafts/:draftId/approve` | `inbox:approve` |
| Provider send | Worker-only after approval | none from browser |

The UI must not implement or expose direct equivalents of upstream Zernio `/v1/inbox/*`, direct `POST messages`, account selection cookies, broadcasts, calling, contact blocking, or template/flow management.

## 3. Scope of Phase 6B

### Include

- Tenant-scoped conversation list and thread.
- Platform filter/search over RAS-read data.
- Unread and pending-review visuals.
- Draft composer that always creates `pending_review`.
- Owner approval control only when permitted by RAS role/scope.
- Delivery/sent/failed state rendered from RAS persistence.
- Responsive/dark layout and rate-limit pause UX.

### Exclude

- Auto-reply, direct send, broadcast, delete, contact block/unblock, WhatsApp calls/templates/flows, new outbound conversations.
- Direct Zernio API calls, direct Zernio webhook changes, and browser-exposed provider credentials.
- Cross-tenant search/filtering or profile/account selection controlled by a browser cookie.

## 4. Controlled adaptation plan

1. Create isolated frontend worktree/branch `feat/ras-inbox-ui-shell` from clean remote deployment branch.
2. Copy only selected presentational components with MIT notice preserved; do not vendor upstream server routes, settings, provider client, or `.env` contract.
3. Add RAS typed client and same-origin route handlers forwarding the current `ras_session` server-side.
4. Reconcile payloads with RAS `InboxConversation`, `InboxMessage`, and `InboxDraftReply`; do not force RAS types to mimic Zernio shape.
5. Write UI/API tests for tenant isolation, `pending_review`, no direct-send route, 429 pause, no-session `401` and forbidden `403`.
6. Build/lint isolated worktree, then staging-only DM E2E with an approved test account/message before any Production Inbox release.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Upstream is unauthenticated | Do not deploy it standalone; wrap only adapted components in RAS session/authz boundary. |
| Provider key leakage | No upstream proxy/server settings code enters RAS; no `ZERNIO_API_KEY` in Vercel project. |
| Direct outbound send bypasses review | Do not import upstream composer send behavior; RAS draft API is the only write path. |
| Tenant leak through selected account cookie | Derive tenant from RAS session and enforce on backend for every request. |
| Version/dependency drift | Install/reconcile in isolated branch; do not bulk-upgrade main frontend dependencies. |
| Inbox workflow impact | Staging E2E and human gate precede production. |

## 6. Exit criteria for discovery

Discovery is complete. The next implementation decision is a clean RAS frontend worktree for the limited Phase 6B shell. No fork deployment or provider configuration was created during this assessment.

## 7. Attribution

If components are copied/adapted, retain the upstream MIT license text and document source attribution in the frontend repository.
