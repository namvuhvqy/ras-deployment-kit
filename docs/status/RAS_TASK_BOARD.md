# RAS Sandbox Task Board

## Topic lanes

- RAS Sandbox — Product Scope & Roadmap
- RAS Sandbox — Agent Env & Control Panel
- RAS Sandbox — Zernio Add-on / White-label Social

## Now

- [x] Lock architecture decision.
- [x] Re-scope product as RAS Sandbox Agent Environment, not landing-page-only and not Zernio-as-core-backend.
- [x] Verify daily Telegram MD report cron at 17:00 VN.
- [x] Create clean deployment repo skeleton.
- [x] Add dry-run Zernio adapter contract.
- [x] Add fair per-profile queue skeleton.
- [x] Add persistent DB schema/migrations.
- [x] Add live Zernio API client behind adapter.
- [x] Add VPS deploy key / non-interactive SSH.
- [x] Fix fake Connected bug: connection state must come from real connected account mapping + verification, never from click/demo state.
- [ ] Add minimum login + dashboard/control panel.
- [ ] Link/check Vercel app project after access granted.

## MVP Sprint 1

1. Product: RAS Sandbox Agent Environment scope and roadmap.
2. API: tenant/customer/profile/account mapping endpoints.
3. Control panel: login, tenant dashboard, env/agent health and logs.
4. Sandbox/env: lifecycle status for per-tenant VPS/cloud sandbox and 2 RAS agents.
5. Queue: job persistence + fair dequeue worker.
6. Zernio add-on: tenant/profile/account mapping, connected accounts, posts/drafts, webhooks.
7. Ops: Docker compose + VPS deploy smoke.
8. Hardening: service packages, billing state, audit logs, smoke tests.

## Human gates

- Before touching production VPS state.
- Before using live Zernio OAuth/API credentials.
- Before assuming undocumented Zernio fields or behavior.
- Before Vercel production deploy.
