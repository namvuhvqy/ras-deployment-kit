# RAS Dashboard IA & API Contract — Phase 5A

Updated: 2026-08-06
Status: **local implementation contract; deployment status is not asserted here**
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
    // Exact safe projection only; never a persisted RasCustomer record.
    customer: { id: string; name: string; status?: string };
    // Deep allowlisted product/quota view only. `basePlan` permits planId,
    // status, billingCycle, prices, vps type/size, agents included/kinds,
    // aiTokens limit/usage, and activation/expiry. `connectSlots` permits
    // status, counts, trial expiry, and solo API flag. `addOns` permits only
    // id/name/status/slots. Unknown persisted fields are never returned.
    entitlement: DashboardEntitlement;
    // Dashboard-safe projection only; never a persisted ConnectedAccount record.
    connectedAccounts: Array<{
      id: string; // local RAS connection ID
      platform: SocialPlatform;
      status: 'pending' | 'connected' | 'disconnected' | 'error';
    }>;
    // No provider account/profile IDs, internal profile IDs, tokens, or customer IDs.
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

```ts
type LeadDashboard = {
  dashboard: {
    state: 'lead';
    user: { id: string; email: string; displayName?: string };
    cta: { label: string; href: '/pay' };
  };
};
```

### Required backend behavior

1. A tenant-bound session/PAT principal resolves customer before any tenant data lookup; cross-tenant result is `403`. A lead session returns only `state: 'lead'` safe data.
2. `dashboardSummary` values are computed from RAS persistence only; do not query Zernio directly on dashboard page render.
3. Inbox counts are tenant scoped and do not expose conversation text in this summary.
4. Customer-facing endpoint does not expose `zernioProfileId`, raw provider IDs, host/IP, secret metadata, or other tenant internals.
5. Preserve legacy `plan`, `maxConnectedAccounts`, `activeConnectedAccounts`, and `addOnStatus` until all frontend consumers migrate.

### Subscription lifecycle read model (Task 5)

Tenant-bound `GET /dashboard` now adds the following **read-only** projection. Its clock is server-owned (`new Date().toISOString()`); callers cannot supply `now`.

```ts
type DashboardSubscription = {
  lifecycleState: 'active' | 'expiring_soon' | 'past_due' | 'expired' | 'unknown';
  expiresAtIso?: string;
  reminderAtIso?: string;
  graceEndsAtIso?: string;
  paidCapability: 'allow' | 'entitlement_unavailable' | 'entitlement_expired' | 'entitlement_inactive';
};
```

- It is derived from `getSubscriptionLifecycle(customerId, serverNow)` and the entitlement policy, not mutable billing/package flags. Invalid or missing expiry is `unknown` plus `entitlement_unavailable`, rather than an error.
- Boundaries are **T-7** reminder (`expiring_soon`), **T0** `past_due`, and **T+7** `expired`. `active` is before T-7.
- The endpoint never sweeps lifecycle events or mutates entitlement, connection mappings, provider status, or provider resources. A separate idempotent renewal/capture path may extend the authoritative expiry; repeated capture handling must retain its existing idempotency semantics.
- `paidCapability` is a mutation gate, not a provider-health label: paid mutations are blocked when it is not `allow`; existing Zernio mapping/status remains visible and its `connected`/error health is reported independently of RAS billing. No automatic disconnect or deletion occurs at expiry, and no tokens are returned.
- UX mapping: show renewal/reminder/billing follow-up from `subscription`; retain each Channels card and show its provider status separately. For `unknown`, show an entitlement-support state rather than fabricating expiry. For blocked paid mutations, retain read access and explain the renewal requirement.
- Changing plans is not inferred from this read model and requires a dedicated, audited migration. No public VPS/agent paid-mutation routes currently exist.

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
