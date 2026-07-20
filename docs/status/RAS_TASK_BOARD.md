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

## Latest Zernio feedback incorporated

- Base/Auth: endpoints under `/v1`; Bearer API key.
- IDs: local RAS `externalId` maps to `Zernio profile._id`; social account source of truth is `SocialAccount._id`; create-post scope is `platforms[].accountId`, not root `profileId`.
- Profile create fields: only documented `name`, `description`, `color`, `isDefault`; do not invent `externalId`, `metadata`, or `email` on Zernio profile payload.
- Webhooks: at-least-once delivery; dedup by `payload.id` / `X-Zernio-Event-Id`; verify `X-Zernio-Signature` HMAC-SHA256 over raw body when secret exists; auto-disable after 10 consecutive failures; logs retained 30 days.
- 429: honor `Retry-After` seconds and `X-RateLimit-*`; rate limit is shared at billing/team account level, so queue throttle must be global/fair.
- Account auth: surface `needsReconnection=true`; never show fake Connected.
- Media/live smoke: use public HTTPS media or `/v1/media/presign`; Facebook/YouTube live test remains behind human gate.

## MVP Sprint 1 — updated task board

1. [x] Product: RAS Sandbox Agent Environment scope and roadmap.
2. [x] API baseline: JSON store, auth/login, tenant dashboard, billing/audit endpoint coverage.
3. [x] Control panel baseline: login, tenant dashboard, connection state from verified mapping only.
4. [ ] Backend28: tenant/customer/profile/account mapping endpoints.
5. [ ] Backend28: persistent worker hardening — global/team rate-limit bucket, retry/backoff using `Retry-After`, lifecycle audit rows.
6. [x] Zernio29: update adapter contract to enforce `platforms[].accountId`, documented profile fields only, no root `profileId`.
7. [ ] Zernio29: webhook receiver design — raw-body signature verify, event dedup store, retry/failure log surface.
8. [ ] Frontend30: show integration state (`connected`, `needsReconnection`, `lastVerifiedAt`) from API summary; no UI/demo Connected state.
9. [ ] Frontend30: add small admin screens for tenant mapping, agent health/log summary, and smoke-test status.
10. [ ] Ops33: Docker/VPS/Vercel smoke checklist only; no production deploy without approval.
11. [ ] Ops33: optional script-only heartbeat/watchdog, no LLM/code changes, alerts only on dirty repo/failed cron/env accidentally live.
12. [ ] Hardening later: service packages, billing UI, audit exports, live Facebook/YouTube smoke after explicit account/platform/mode approval.

## Topic assignment — small tasks only

| Topic | Next small tasks | Risk | Order |
|---|---|---|---:|
| Backend28 - RAS API/Worker | Add local mapping model/API; add global rate-limit/retry fields; add tests for no root `profileId` assumption | Medium: schema drift, worker retry loops | 1 |
| Zernio29 - Social Adapter | Align adapter payloads with Zernio feedback; draft webhook contract; list exact live-smoke prerequisites | High if live enabled too early | 2 |
| Frontend30 - RAS Dashboard | Render verified connection summary; add `needsReconnection` warning; add smoke/log summary page | Medium: fake status bug if UI keeps local state | 3 |
| Ops33 - Deploy/Smoke | Keep deploy/smoke checklist; monitor cron/dirty diff; prepare heartbeat proposal; report blockers only | Low/Medium: noisy logs/token waste | 4 |

## Human gates

- Before touching production VPS state.
- Before using live Zernio OAuth/API credentials.
- Before assuming undocumented Zernio fields or behavior.
- Before Vercel production deploy.
