# RAS Dashboard IA & API Contract — Phase 5A

Updated: 2026-08-01
Status: **design locked; implementation next**
Owner: Nam Vũ / RunAgentSys

## 1. Goal and boundaries

Deliver one session-derived customer dashboard and a separate admin workspace. The dashboard is the control plane for the two RAS service lines:

- Managed RAS VPS / two-agent setup.
- Social integrations / Inbox through Zernio-backed RAS APIs.

The browser never selects a tenant by query parameter, build environment, or UI state. `ras_session` resolves the customer server-side. Existing `/customer-portal` remains a compatibility/demo smoke route until the protected `/dashboard` release is complete.

## 2. Information architecture

| Area | Customer can see/do | Source of truth | Phase |
|---|---|---|---|
| Overview | plan, renewal, entitlement, needs-plan CTA, usage summary | `GET /dashboard` | 5B |
| Channels | account status, quota, connect entry point | dashboard + connection summary | 5B |
| Inbox | unread/pending-review counters and link to Inbox | RAS Inbox read APIs | 6B |
| API & security | PAT list/create/rotate/revoke, rate-limit state | PAT session APIs | existing; link in 5B |
| Managed VPS | VPS label/status, `ras1-hermes` / `ras2-openclaw` heartbeat | dashboard payload | 5B |
| Billing | package, billing period, renewal state, support CTA | entitlement/payment records | 5B |
| Admin workspace | customer/order/package/profile/VPS assignment | admin-only APIs | 5C |

### Customer dashboard state

- `lead`: safe welcome and `/pay` CTA before tenant binding; no technical error, customer/tenant, entitlement, profile, quota, or provider provisioning is created by login.
- `needs_plan`: safe welcome and `/pay` CTA for a tenant-bound session without an active plan; no provider provisioning.
- `ready`: show Overview, Channels, Inbox entry point, Security, VPS/Agents and Billing.
- Degraded/missing optional records render `unknown`/empty cards, never a fabricated connected state.

## 3. API contract delta

Keep the existing tenant-bound `GET /dashboard` response backward compatible. A lead session instead returns lead-safe state without customer-derived fields. Add these tenant fields additively, each derived from the authenticated session customer:

```ts
type DashboardV2 = {
  dashboard: {
    state: 'ready' | 'needs_plan';
    customer: { id: string; name: string; status?: string };
    entitlement: RasEntitlement;
    connectedAccounts: ConnectedAccount[];
    agents: RasAgentInstance[];
    sandbox?: RasSandboxEnvironment;
    dashboardSummary: {
      renewalState: 'active' | 'past_due' | 'unknown';
      inbox: { unreadConversations: number; pendingReviewDrafts: number };
      channels: { totalSlots: number; activeAccounts: number; needsReconnect: number };
      api: { patManagementHref: '/personal-access-tokens' };
    };
  };
};
```

### Required backend behavior

1. A tenant-bound session/PAT principal resolves customer before any tenant data lookup; cross-tenant result is `403`. A lead session returns only `state: 'lead'` safe data.
2. `dashboardSummary` values are computed from RAS persistence only; do not query Zernio directly on dashboard page render.
3. Inbox counts are tenant scoped and do not expose conversation text in this summary.
4. Customer-facing endpoint does not expose `zernioProfileId`, raw provider IDs, host/IP, secret metadata, or other tenant internals.
5. Preserve legacy `plan`, `maxConnectedAccounts`, `activeConnectedAccounts`, and `addOnStatus` until all frontend consumers migrate.

## 4. Admin workspace contract

Admin must be backend-authorized by role, not only an allow-list environment variable in a Next.js route. Phase 5C introduces admin-only APIs:

- `GET /admin/customers?cursor=&status=`
- `GET /admin/customers/:customerId`
- `PATCH /admin/customers/:customerId/entitlement`
- `POST /admin/customers/:customerId/profile-assignments`
- `POST /admin/customers/:customerId/vps-assignments`
- `POST /admin/orders`
- `PATCH /admin/orders/:orderId`

Every mutation records actor, customer, before/after safe fields, request id and timestamp. Provider secrets/tokens are never accepted or returned by these routes.

## 5. Implementation slices

1. **5B.1:** Extend dashboard aggregate/store tests for summary counters and `needs_plan`.
2. **5B.2:** Add frontend Dashboard shell/sections using current session proxy; remove production customer UI dependence on static demo customer ID.
3. **5B.3:** Add Channel quota/connection card and PAT security entry link.
4. **5C.1:** Add backend role middleware and admin customer/order read model.
5. **5C.2:** Add admin assignment UI after APIs and audit tests pass.

## 6. Acceptance gates

- Missing/invalid session remains `401`; cross-tenant attempts remain `403`.
- New Google lead receives `state: 'lead'` with no customer/tenant, entitlement, profile, quota, or provider side effect.
- Dashboard only displays backend-verified connected account state.
- Backend `npm run check`; frontend `npm run lint && npm run build` pass.
- Before production: staging smoke for no-session, invalid-session, ready customer, needs-plan customer and admin-forbidden customer.

## 7. Explicit non-goals

- No auto VPS provision.
- No automatic inbox send/reply.
- No raw Zernio credential or broad provider API pass-through.
- No public pricing copy/price change in this phase.
