# RAS Sandbox Task Board

## Topic lanes

| Topic | Purpose |
|---|---|
| PMO27 - RAS Roadmap | Điều phối tổng, scope, roadmap, priorities, decisions |
| Backend28 - RAS API/Worker | API, DB, queue, persistent worker, core domain |
| Zernio29 - Social Adapter | Zernio profile/account/post/webhook, tenant/profile/account mapping |
| Frontend30 - RAS Dashboard | Vercel app, login, dashboard, control panel, connection-state UI |
| Marketing31 - RAS Growth/Content | Website copy, content, campaigns, positioning, social marketing ops |
| Sales32 - RAS Onboarding | Leads, packages, customer onboarding, CRM/CSKH handoff |
| Ops33 - Deploy/Smoke | VPS, deploy, smoke tests, summarized logs, support operations |

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
- [x] Add minimum login + dashboard/control panel: JSON store users/sessions, `/auth/login`, protected `/dashboard`, tenant control panel payload, tests pass.
- [x] Link/check Vercel app project after access granted: CLI authenticated as `namvuhvqy`, project `landingpage-ban-hang` visible with production URL `https://runagentsys.com`; see `docs/status/RAS_VERCEL_CHECK_20260720T000524Z.md`.

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
