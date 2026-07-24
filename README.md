# RunAgentSys / RAS Product & Deployment Kit

This repository contains the product architecture, implementation docs, backend/domain code, adapter tests, and deployment planning artifacts for the RunAgentSys / RAS MVP.

## Locked MVP direction

RunAgentSys MVP has **two service lines** managed by **one shared backend/control panel**.

```text
RunAgentSys
  ├─ Service A: Webapp / Zernio Integration
  │    ├─ Customer account on runagentsys.com
  │    ├─ Customer connects supported platforms from the dashboard
  │    └─ Backend enforces purchased connection entitlement (`N`) and maps customer to one or more Zernio/API profiles as needed
  │
  └─ Service B: Managed RAS VPS 2-Agent Setup
       ├─ Team prepares/assigns a VPS or sandbox
       ├─ VPS contains RAS1 + RAS2 agents
       └─ Customer sees package/onboarding/agent status on runagentsys.com
```

The two services are sold separately, but they share the same backend records:

- `Customer`
- `UserIdentity` / Google OAuth subject mapping
- `Order` / `Package`
- Zernio profile mapping + RAS-owned connection entitlement/quota
- `Integration`
- `VpsAssignment`
- `AgentStatus`
- audit/onboarding state

## Customer onboarding flow

```text
Lead arrives from web or sale conversation
  ↓
Sale/Admin creates customer account
  ↓
Admin assigns package:
  - zernio_webapp
  - ras_vps_2_agent
  - hybrid
  ↓
RAS provisions entitlement and creates/assigns the first Zernio/API profile and/or VPS
  ↓
Customer logs in to runagentsys.com with Google OAuth
  ↓
Customers connect allowed platforms until their RAS-owned purchased quota is reached
  ↓
Backend/Zernio verifies real status
  ↓
Dashboard shows integration, VPS, agent, and onboarding state
```

Customers should not need to understand Zernio. Zernio is an internal/partner integration backend behind RunAgentSys UX.

## Service lines

| Service | Customer promise | MVP delivery mode |
|---|---|---|
| **RunAgentSys Webapp / Zernio Integration** | Customer gets a web account and connects social/platform channels through `runagentsys.com` | RAS stores dynamic purchased connection quota, creates/assigns Zernio profiles, and enforces limits before OAuth connect |
| **Managed RAS VPS 2-Agent Setup** | Customer gets a managed automation VPS/sandbox with RAS1 + RAS2 configured for their business | Manual/admin-assisted VPS assignment first |
| **Hybrid** | Customer gets both the webapp integration layer and a dedicated RAS VPS setup | Shared customer/account/backend record |

## What this repo is for

- Locking architecture decisions and product scope.
- Backend/domain implementation for customers, packages, profile slots, integrations, VPS assignments, agent status, queues, audit, and webhooks.
- Zernio adapter contracts and tests.
- Operational checklists for local/VPS/Vercel smoke tests.
- Keeping implementation aligned with the approved MVP flow.

## What this repo is not

- Not a landing-page-only project.
- Not a VPS rental-only product.
- Not a source-code resale package.
- Not a Zernio clone.
- Not a place to store runtime secrets, `.hermes`, `.hermes-cskh`, logs, backups, OAuth tokens, or customer credential state.

## Current implementation guardrails

- Keep modules small and business-flow-first.
- RAS is the source of truth for purchased connection quota. Do not try to set “5 slots” or any `N` on a Zernio profile; Zernio profiles are containers for connected accounts only.
- Prepared profile/API slots are acceptable for MVP, but payment/webhook provisioning should create or assign profiles lazily when the customer actually has entitlement.
- If a customer connects multiple accounts on the same platform, RAS creates/assigns another Zernio profile because Zernio supports one account per platform per profile.
- Login is Google OAuth-only: `/login` has exactly one `Continue with Google` CTA. Do not build Email/Password, Forgot Password, password reset, or local-password fallback flows.
- Do not fake `Connected` state in UI. Only show connected when backend has verified mapping/status.
- Do not use undocumented Zernio fields.
- Keep Zernio IDs as external references, not RAS primary IDs.
- Production deploy, live credentials, live social publishing, and VPS mutations require explicit human approval.
- Prefer strong local tests and smoke checks before any production action.

## Important docs

- `docs/ARCHITECTURE_DECISION_LOCKED.md` — locked MVP architecture decision.
- `docs/ARCH.md` — protected customer dashboard RFC/API contract for Base VPS + 2 Agent RAS + modular Add-ons.
- `docs/PRODUCT_SCOPE_ROADMAP.md` — current MVP product scope and execution roadmap.
- `docs/status/RAS_TASK_BOARD.md` — topic-based task board and execution order.
- `docs/RAS_DEPLOYMENT_ARCHITECTURE.md` — deployment architecture notes.
- `docs/IMPLEMENTATION_PLAN.md` — implementation plan.
- `pricing/RAS_PRICING_MODEL.md` — pricing/package model.
- `frontend-audit/RUNAGENTSYS_FRONTEND_AUDIT.md` — frontend audit notes.

## Local verification

```bash
npm run check
```

Expected result: TypeScript build passes and all Node tests pass.

## Google OAuth 2.0 login

RAS login is Google OAuth-only. The backend exposes these auth routes before the final 404 fallback:

| Route | Purpose |
|---|---|
| `GET /auth/google` | Builds the Google authorization URL using scope `openid email profile`. |
| `POST /auth/google/callback` | Exchanges Google code, reads Google profile, upserts user/customer, creates a session token, and returns dashboard redirect metadata. |
| `GET /dashboard` | Requires `Authorization: Bearer <token>` and returns tenant dashboard data. |

Required backend env keys are documented in `.env.example`:

```bash
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_CALLBACK_URL=http://localhost:8080/auth/google/callback
```

Do not commit real Client IDs/Secrets. Frontend `/login` must show only one CTA: `Continue with Google`.

## Frontend ↔ backend API contract

`runagentsys.com` is the customer-facing webapp. It must call the RunAgentSys backend for customer/package/profile/VPS/integration state; the webapp must not treat a local click or demo response as a verified connection.

Current MVP boundary:

| Frontend route/use | Backend source of truth | Purpose |
|---|---|---|
| `GET /api/integrations/summary` | `GET {RAS_API_BASE}/customers/{RAS_CUSTOMER_ID}/connection-summary` | Render verified social/platform connection state. |
| customer dashboard | `GET /dashboard` or customer-scoped dashboard endpoint | Render package, assigned profile slot, VPS, agent, and onboarding state. |
| account/profile mapping | `GET /mappings/customers/{customerId}` and `GET /customers/{customerId}/mapping` | Read RAS customer ↔ Zernio/profile/VPS mapping. |
| `POST /billing/entitlements/provision` | RAS customer store + Zernio profile creation | Persist dynamic purchased quota `maxConnectedAccounts=N`, package/add-on status, and create the first profile lazily when needed. |
| `GET /customers/{customerId}/connect/{platform}` | RAS quota enforcement + Zernio connect URL | Block if package/add-on inactive or active connections reached `N`; auto-create another profile for same-platform second account. |
| connect action | backend/Zernio adapter through assigned profile slot | Open OAuth/connect only after RAS verifies entitlement and picks the correct customer-owned profile. |

Frontend env expected by the current split-repo setup:

```bash
RAS_API_BASE=http://localhost:8080
RAS_CUSTOMER_ID=demo
```

Production status as of 2026-07-23: the public RAS backend target is `https://ras-api.runagentsys.com`. Do not use `api.runagentsys.com` for this project. Do not set `RAS_API_BASE=localhost` on Vercel.

`ZERNIO_API_KEY` remains a fallback/integration credential, not the primary frontend source of truth. If neither `RAS_API_BASE` nor `ZERNIO_API_KEY` is configured, frontend API routes must return safe empty state instead of fake `Connected`.

## Next customer portal scope

After the integration-summary path is deployed behind a real backend URL, the next product slice is **customer portal MVP**:

1. Login/session screen for customers and admin-assisted onboarding.
2. Account/service management page backed by RAS APIs, not static cards.
3. Package/service status: `zernio_webapp`, `ras_vps_2_agent`, or `hybrid`.
4. Renewal/expiry fields: start date, expiry date, renewal status, payment/manual follow-up note.
5. Assigned resources: Zernio profile/account slot, VPS assignment, RAS1/RAS2 agent status.
6. Audit trail: who assigned/changed customer package, profile slot, VPS, or renewal status.

Current frontend `/account-management` is a useful visual baseline only; it is not yet a real authenticated customer/admin management screen.

## Topic lanes

| Topic | Role |
|---|---|
| PMO27 | Scope, roadmap, decisions, human gates |
| Backend28 | Customer/order/profile slot/VPS/agent APIs |
| Zernio29 | Zernio profile/account/webhook/connect/status |
| Frontend30 | Webapp, customer dashboard, admin screens, real status UI |
| Marketing31 | Sales copy and packaging for the two service lines |
| Sales32 | Lead → account → onboarding workflow |
| Ops33 | VPS setup, smoke tests, deploy checks, logs/support |
