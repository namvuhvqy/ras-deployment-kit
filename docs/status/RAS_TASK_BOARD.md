# RAS Task Board

## Now

- [x] Lock architecture decision.
- [x] Verify daily Telegram MD report cron at 17:00 VN.
- [x] Create clean deployment repo skeleton.
- [x] Add dry-run Zernio adapter contract.
- [x] Add fair per-profile queue skeleton.
- [x] Add persistent DB schema/migrations.
- [ ] Add live Zernio API client behind adapter.
- [x] Add VPS deploy key / non-interactive SSH.
- [ ] Link/check Vercel landing project after access granted.

## MVP Sprint 1

1. API: customer/profile mapping endpoints.
2. Queue: job persistence + fair dequeue worker.
3. Zernio: dry-run profile/connect/post flow tests.
4. Webhook: receiver + idempotency table.
5. Ops: Docker compose + VPS deploy smoke.
6. Frontend: landing audit + connect/demo CTA.

## Human gates

- Before touching production VPS state.
- Before using live Zernio OAuth/API credentials.
- Before Vercel production deploy.
