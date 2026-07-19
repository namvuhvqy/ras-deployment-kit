# RAS Sandbox — Product Scope & Roadmap

Updated: 2026-07-19
Owner: Nam Vũ / RunAgentSys
Status: PRODUCT SCOPE LOCKED FOR NEXT BUILD

## 1. Product scope

The primary product is **RAS Sandbox Agent Environment**: a SaaS web application and control panel for provisioning and operating isolated automation environments.

Each tenant/customer owns a separate VPS/cloud sandbox environment containing **2 RAS agents**:

1. **RAS1 — Hermes Main**: customer-care, routing, CRM/leads, operations brain.
2. **RAS2 — OpenClaw/worker agent**: content, media, campaign assets, publishing drafts, workflow automation.

The web application is a **control panel/dashboard**, not a landing page. Its core job is to manage:

- Tenant/customer records.
- Sandbox/env provisioning and lifecycle.
- Agent status, health, and logs.
- Service packages and billing state.
- Integrations and connected add-ons.
- Audit trail, smoke tests, and operational hardening.

## 2. Explicit non-goals

RAS is **not**:

- A landing-page-only project.
- A generic marketing website.
- A Zernio clone.
- A product where Zernio is the backend for the entire RAS system.

## 3. Zernio role

**Zernio / runagentsys.com is a social operations add-on / white-label backend**, used for:

- Connected social accounts.
- Media handling.
- Posts/drafts/scheduling.
- Inbox/events where supported.
- Social operations workflows.

RAS must integrate Zernio through a tenant/profile/account mapping layer. RAS should not rebuild Zernio, and should not depend on undocumented Zernio fields.

Current confirmed OpenAPI constraints:

- `POST /v1/profiles` documents only `name`, `description`, `color`, `isDefault`.
- Do not send undocumented profile fields such as `externalId`, `metadata`, or `email`.
- Store RAS customer/tenant to Zernio `profile._id` mapping locally.
- `POST /v1/posts` does not accept root `profileId`.
- `platforms` must be an array of objects such as `{ platform, accountId }`, not strings.
- Platform-specific settings belong in `platforms[].platformSpecificData`.
- 429 handling: `Retry-After` is seconds; `X-RateLimit-Reset` is a Unix timestamp in seconds; limits are account-wide.

## 4. Priority roadmap

1. **Lock product scope**: RAS Sandbox Agent Environment.
2. **Fix fake Connected bug**: UI/API must not show `Connected` unless a real account mapping exists and status is verified.
3. **Build minimum login + dashboard/control panel**.
4. **Manage sandbox/env + 2 agents + health/logs**.
5. **Add service/package management**.
6. **Integrate Zernio as tenant/profile/account add-on mapping**.
7. **Hardening**: webhooks, persistent queue/worker, billing, audit logs, staging smoke tests.

## 5. Topic naming

Use these topics instead of `ras landing`:

- **RAS Sandbox — Product Scope & Roadmap**
- **RAS Sandbox — Agent Env & Control Panel**
- **RAS Sandbox — Zernio Add-on / White-label Social**

## 6. Implementation guardrails

- Prefer clean, small modules over over-complex pipelines.
- Keep RAS core domain types independent from Zernio transport details.
- Treat Zernio IDs as external references, never as RAS primary identity.
- Any missing or undocumented Zernio behavior must be confirmed from Zernio docs/admin before coding live assumptions.
- Production/VPS mutations require explicit approval unless the action was already approved for the current task.
- Every live integration change needs a staging smoke test and read-back verification.
