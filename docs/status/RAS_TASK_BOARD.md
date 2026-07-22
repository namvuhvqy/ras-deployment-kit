# RAS Sandbox Task Board

Updated: 2026-07-22

## Locked MVP decision

RunAgentSys MVP has **two service lines** but **one shared backend/control panel**:

1. `zernio_webapp` — customer account on `runagentsys.com`, platform integrations through prepared Zernio/API profile slots.
2. `ras_vps_2_agent` — managed VPS setup with RAS1 + RAS2, manually assigned first.
3. `hybrid` — both webapp integrations and dedicated VPS/agents.

Primary MVP flow:

```text
web lead or sale lead
→ sale/admin creates customer account
→ admin assigns package
→ admin assigns prepared profile slot and/or VPS
→ customer logs in to runagentsys.com
→ customer connects platforms
→ backend/Zernio verifies status
```

## Topic lanes

| Topic | Purpose |
|---|---|
| PMO27 - RAS Roadmap | Điều phối tổng, scope, roadmap, priorities, decisions |
| Backend28 - RAS API/Worker | Customer/order/profile slot/VPS/agent APIs, worker/core domain |
| Zernio29 - Social Adapter | Zernio profile/account/post/webhook, connect/status mapping |
| Frontend30 - RAS Dashboard | Webapp, customer dashboard, admin screens, real connection-state UI |
| Marketing31 - RAS Growth/Content | Website copy, content, campaigns, packaging 2 service lines |
| Sales32 - RAS Onboarding | Leads, package sale, account creation, customer handoff |
| Ops33 - Deploy/Smoke | VPS setup, deploy checks, smoke tests, logs/support |

## Done / baseline

- [x] Re-scope product away from landing-page-only.
- [x] Confirm Zernio is integration backend/add-on, not whole RAS core backend.
- [x] Add adapter constraints: documented profile fields only, `platforms[].accountId`, no root `profileId`.
- [x] Add login/dashboard baseline.
- [x] Fix fake Connected rule: frontend must not claim connected without verified mapping.
- [x] Add Vercel/runagentsys.com project visibility check.
- [x] Lock MVP decision: 2 service lines, 1 shared backend/control panel.

## MVP Sprint 1 — next execution order

1. [ ] PMO27: publish locked MVP architecture/roadmap summary to the correct topic.
2. [ ] Backend28: add/verify minimal `Customer` model/API.
3. [ ] Backend28: add `Order/Package` state with package types `zernio_webapp`, `ras_vps_2_agent`, `hybrid`.
4. [ ] Backend28: add `ProfileSlot` pool API: available/assigned/disabled.
5. [ ] Backend28: add admin assign-profile action with audit row.
6. [ ] Backend28: add `VpsAssignment` model for manual VPS handoff.
7. [ ] Backend28: add `AgentStatus` model for RAS1/RAS2 heartbeat/log summary.
8. [ ] Zernio29: connect/status API must resolve through assigned profile slot.
9. [ ] Zernio29: webhook receiver: raw-body signature verify, event dedup, failure log surface.
10. [ ] Frontend30: remove/label static demo account management from production path.
11. [ ] Frontend30: customer dashboard shows package/profile/integration status from API.
12. [ ] Frontend30: admin dashboard can create customer and assign profile/VPS.
13. [ ] Ops33: smoke test full flow locally: create customer → assign slot/VPS → customer dashboard → connect/status.
14. [ ] Ops33: keep no-prod-deploy/no-live-credential gate until explicit approval.

## Human gates

- Before touching production VPS state.
- Before using live Zernio OAuth/API credentials.
- Before Vercel production deploy.
- Before live publishing to customer social accounts.
- Before handing SSH key/config to a real customer.

## Repo/testing note

Two repos are acceptable short term. If boundary testing keeps breaking, migrate toward one monorepo:

```text
runagentsys/
  apps/web
  apps/api
  apps/worker
  packages/shared
  packages/zernio-adapter
```
