# RunAgentSys / RAS Product & Deployment Kit

This repository contains the product architecture, implementation docs, backend/domain code, adapter tests, and deployment planning artifacts for the RunAgentSys / RAS MVP.

## Locked MVP direction

RunAgentSys MVP has **two service lines** managed by **one shared backend/control panel**.

```text
RunAgentSys
  ├─ Service A: Webapp / Zernio Integration
  │    ├─ Customer account on runagentsys.com
  │    ├─ Customer connects supported platforms from the dashboard
  │    └─ Backend maps customer to prepared Zernio/API profile slots
  │
  └─ Service B: Managed RAS VPS 2-Agent Setup
       ├─ Team prepares/assigns a VPS or sandbox
       ├─ VPS contains RAS1 + RAS2 agents
       └─ Customer sees package/onboarding/agent status on runagentsys.com
```

The two services are sold separately, but they share the same backend records:

- `Customer`
- `Order` / `Package`
- `ProfileSlot`
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
Admin assigns prepared Zernio/API profile slot and/or VPS
  ↓
Customer logs in to runagentsys.com
  ↓
Customer connects allowed platforms
  ↓
Backend/Zernio verifies real status
  ↓
Dashboard shows integration, VPS, agent, and onboarding state
```

Customers should not need to understand Zernio. Zernio is an internal/partner integration backend behind RunAgentSys UX.

## Service lines

| Service | Customer promise | MVP delivery mode |
|---|---|---|
| **RunAgentSys Webapp / Zernio Integration** | Customer gets a web account and connects social/platform channels through `runagentsys.com` | Prepared profile/API slots assigned by admin |
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
- Prepared profile/API slots are acceptable for MVP: create a few, sell/assign them, then create more when needed.
- Do not fake `Connected` state in UI. Only show connected when backend has verified mapping/status.
- Do not use undocumented Zernio fields.
- Keep Zernio IDs as external references, not RAS primary IDs.
- Production deploy, live credentials, live social publishing, and VPS mutations require explicit human approval.
- Prefer strong local tests and smoke checks before any production action.

## Important docs

- `docs/ARCHITECTURE_DECISION_LOCKED.md` — locked MVP architecture decision.
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

## Frontend ↔ backend API contract

`runagentsys.com` is the customer-facing webapp. It must call the RunAgentSys backend for customer/package/profile/VPS/integration state; the webapp must not treat a local click or demo response as a verified connection.

Current MVP boundary:

| Frontend route/use | Backend source of truth | Purpose |
|---|---|---|
| `GET /api/integrations/summary` | `GET {RAS_API_BASE}/customers/{RAS_CUSTOMER_ID}/connection-summary` | Render verified social/platform connection state. |
| customer dashboard | `GET /dashboard` or customer-scoped dashboard endpoint | Render package, assigned profile slot, VPS, agent, and onboarding state. |
| account/profile mapping | `GET /mappings/customers/{customerId}` and `GET /customers/{customerId}/mapping` | Read RAS customer ↔ Zernio/profile/VPS mapping. |
| connect action | backend/Zernio adapter through assigned profile slot | Open OAuth/connect only for the customer/profile slot that RAS assigned. |

Frontend env expected by the current split-repo setup:

```bash
RAS_API_BASE=http://localhost:8080
RAS_CUSTOMER_ID=demo
```

`ZERNIO_API_KEY` remains a fallback/integration credential, not the primary frontend source of truth. If neither `RAS_API_BASE` nor `ZERNIO_API_KEY` is configured, frontend API routes must return safe empty state instead of fake `Connected`.

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
