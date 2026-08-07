# Phase 5C — Admin Operations Foundation

## Scope lock

Backend-only first slice. It does not call PayPal, Zernio, VPS providers, or workers. It creates durable operational records and emits immutable audit records.

## Contract

- Only a session user explicitly listed in server-side `RAS_SYSTEM_ADMIN_USER_IDS` may access `/admin/*`; tenant roles (`owner`, `admin`, `operator`, `viewer`), PATs, and anonymous callers are denied. This prevents tenant owners from becoming global operators.
- `POST /admin/customers` creates a customer plus an audit row. Repeating the same explicit id is conflict-safe (`409`), never overwriting an existing tenant.
- `POST /admin/customers/:id/assignments` atomically applies a selected existing service package, profile-slot reference, sandbox/VPS assignment, and optional agent status update; then appends one audit row with actor and before/after-safe identifiers. No external provider calls are made.
- `GET /admin/customers` and `GET /admin/customers/:id/operations` return operational read models only to admins.
- Customer-scoped public routes retain tenant checks and do not acquire admin bypass.

## Data model

- `RasOrder`: internal/manual or provider-referenced order state. This slice only records `manual` order creation through an explicit admin create endpoint.
- `RasProfileSlot`: pool reference, status, and assigned customer. Assignment requires an unassigned or same-customer slot; conflicting assignment returns `409`.
- Existing `RasSandboxEnvironment` and `RasAgentInstance` represent VPS and agent status. An admin assignment only upserts persisted records.

## Gates

1. RED: API tests prove admin authorization, cross-customer safety, conflicts, idempotency, audit persistence.
2. GREEN: minimal store/API implementation.
3. `npm run check`, `git diff --check`.
4. Independent spec and security review.
5. Draft PR only; no staging/production mutation until separately approved.
