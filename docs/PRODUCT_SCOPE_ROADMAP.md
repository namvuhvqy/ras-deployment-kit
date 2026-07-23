# RunAgentSys / RAS — MVP Product Scope & Roadmap

Updated: 2026-07-23
Owner: Nam Vũ / RunAgentSys
Status: LOCKED FOR MVP EXECUTION

## 0. Current integration checkpoint — 2026-07-23

- Public RAS API base URL is live at `https://ras-api.runagentsys.com`.
- Smoke passed for public backend health and customer connection summary.
- Vercel production env is set to `RAS_API_BASE=https://ras-api.runagentsys.com` and `RAS_CUSTOMER_ID=demo_khach_2`.
- Production frontend `https://runagentsys.com/api/integrations/summary` now proxies the RAS backend and returns `source: "ras-backend"` with verified Facebook integration state for the demo customer.
- Next MVP focus: customer portal/account-management screens backed by real RAS customer/session APIs.

## 0.1 Protected dashboard rollout checkpoint — 2026-07-23

- [x] Step 1 docs: RFC/API contract written in `docs/ARCH.md` for a protected `/dashboard` that derives `customerId` from session token.
- [x] Step 1 docs: Base Plan schema documented as VPS/sandbox + exactly 2 default RAS agents (`ras1-hermes`, `ras2-openclaw`).
- [x] Step 1 docs: Add-ons schema documented with inactive-safe `active: false` behavior for modules such as Zernio and Social Automation.
- [x] Step 1 docs: Backward-compatibility rule locked — keep `/customer-portal` demo path for smoke testing until protected `/dashboard` passes end-to-end.
- [ ] Step 1 implementation: add TypeScript schema/types, store defaults, and contract tests.
- [ ] Step 2: homepage Login link and `/login` UI connected to `/auth/login`.
- [ ] Step 3: protected `/dashboard` UI rendering Base VPS → 2 Agent RAS → Add-ons widget/banner.

## 1. MVP product scope

RunAgentSys MVP has **two service lines** managed by one backend/control panel:

1. **RunAgentSys Webapp / Zernio Integration**
   - Customer has account on `runagentsys.com`.
   - Customer connects Telegram/WhatsApp/Facebook/Zalo/other platforms through the dashboard.
   - Backend uses prepared Zernio/API profile slots.

2. **Managed RAS VPS 2-Agent Setup**
   - Team builds or assigns a VPS with RAS1 + RAS2.
   - Customer may receive SSH access, but normal operation/integration should be visible on `runagentsys.com`.

Both service lines share:

- Customer/account records.
- Package/order/onboarding state.
- Profile slot assignment.
- Integration status.
- VPS/agent status when included.

## 2. MVP sales/onboarding flow

```text
Customer registers on web OR sale creates lead
  ↓
Sale/Admin creates customer account
  ↓
Admin assigns package
  ↓
Admin assigns prepared profile slot and/or VPS
  ↓
Customer logs in to runagentsys.com
  ↓
Customer connects platforms allowed by package
  ↓
Backend calls Zernio/API behind the scenes
  ↓
Dashboard shows real status and next action
```

## 3. Priority roadmap

1. **Lock MVP docs and API contract** around customer → account → profile slot → integration. ✅ Initial contract locked: frontend summary route proxies `GET {RAS_API_BASE}/customers/{RAS_CUSTOMER_ID}/connection-summary` and never fakes verified connection state. ✅ Protected dashboard RFC/API contract added in `docs/ARCH.md` for Base VPS + 2 Agent RAS + Add-ons while preserving `/customer-portal` demo smoke path.
2. **Customer/order/package minimal API**: create/list/update customer and package status, including service line (`zernio_webapp`, `ras_vps_2_agent`, `hybrid`).
3. **ProfileSlot pool API**: create a few prepared slots, mark available/assigned/disabled.
4. **Assign profile to customer**: admin/sale action, audited.
5. **Login/session MVP**: customer login plus admin-assisted account activation; keep RBAC simple at first.
6. **Customer dashboard API**: `me`, package, assigned profile, integration summary, renewal/expiry status.
7. **Account/service management screen**: display customer account, current service, package, renewal date/status, payment/manual follow-up note, assigned profile/VPS/agent resources.
8. **Integration connect/status API**: Telegram/WhatsApp/Facebook/Zalo/Zernio-backed platforms.
9. **VPS assignment model** for the 2-agent service: IP/host label/status/notes, no auto provisioning yet.
10. **Agent status model**: RAS1/RAS2 heartbeat/log summary.
11. **Frontend dashboard** calls real APIs; no static/demo customer data in production path. Current split-repo rule: frontend may return safe empty state when backend env is missing, but only backend-verified accounts can render as connected.
12. **End-to-end smoke test**: sale creates account → assigns package/slot/VPS → customer logs in → sees dashboard → connect action returns verified status.
13. **Only after MVP works**: auto VPS provisioning, billing automation, advanced RBAC, live publishing scale.

## 4. Non-goals for MVP

- Auto-create all VPS resources after payment.
- Full self-serve checkout-to-provision automation.
- Complex billing/subscription logic.
- Enterprise RBAC/multi-tenant admin complexity.
- Rebuilding Zernio social backend.
- Forcing business customers to use SSH as the main integration workflow.

## 5. Topic routing

| Topic | Purpose |
|---|---|
| PMO27 | Scope, roadmap, decisions, human gates |
| Backend28 | Customer/order/profile slot/VPS/agent APIs |
| Zernio29 | Zernio profile/account/webhook/connect/status |
| Frontend30 | Webapp, customer dashboard, admin screens, real status UI |
| Marketing31 | Sales copy and packaging for 2 service lines |
| Sales32 | Lead → account → onboarding workflow |
| Ops33 | VPS setup, smoke tests, deploy checks, logs |

## 6. Implementation guardrails

- Build only the few customer/profile APIs needed to sell and onboard first customers.
- Prepared profile/API slots are acceptable: sell/assign them, then create more when inventory runs out.
- Keep one shared backend for both service lines.
- If separate repos slow down E2E tests, migrate toward one monorepo.
- Production deploy, live credentials, live publishing, and VPS mutations require explicit approval.

## 7. Split-repo sync rule

Short term the landing page/webapp repo and RAS backend repo can remain separate. They are considered synced only when all are true:

1. Backend `npm run check` passes.
2. Frontend `npm run lint && npm run build` passes.
3. Frontend integration routes call RAS backend contract first, not direct demo state.
4. Public `runagentsys.com` smoke confirms the expected routes exist after deployment.

If this boundary keeps breaking, move to a monorepo with `apps/web`, `apps/api`, `apps/worker`, and shared packages.
