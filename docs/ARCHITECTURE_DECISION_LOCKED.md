# RunAgentSys / RAS — Locked Architecture Decision

Updated: 2026-07-19
Owner: Nam Vũ / RunAgentSys
Status: LOCKED FOR MVP IMPLEMENTATION

## 1. Product Positioning

RunAgentSys sells **RAS Sandbox Agent Environment**: a SaaS web application and managed control panel for isolated customer automation sandboxes.

Each tenant/customer has a separate VPS/cloud sandbox containing **2 RAS agents**:

1. **RAS1 — Hermes Main**: customer-care, operations, CRM/leads, routing, and orchestration brain.
2. **RAS2 — OpenClaw/worker agent**: content, media, campaign assets, publishing drafts, and workflow automation.

The current web product must be treated as a **control panel/dashboard**, not as a landing page. It manages sandbox environments, agent status, customers, service packages, billing, integrations, webhooks, queue state, and audit/smoke-test operations.

RAS is **not** positioned as:

- VPS rental only.
- Source-code resale.
- A single chatbot API.
- A landing-page-only website.
- A Zernio clone.
- A product where Zernio is the backend for the entire RAS system.

Customer-facing language should describe RAS as:

> A managed AI automation sandbox for your business, with isolated agents, health monitoring, workflow automation, social operations add-ons, and secure account connections.

Do not expose internal component names such as `Zernio` in normal sales copy unless the customer asks for technical architecture.

## 2. Final MVP Architecture

```text
RAS SaaS Control Panel
  │
  ├── Tenant / Customer Management
  ├── Sandbox Environment Management
  ├── Agent Health + Logs
  ├── Service Packages + Billing State
  ├── Integrations / Add-ons
  ├── Queue / Worker / Webhook Operations
  └── Audit + Smoke Tests
        │
        ▼
Tenant VPS / Cloud Sandbox
  │
  ├── RAS1 — Hermes Main
  │     ├── CSKH / sales chatbot
  │     ├── Telegram / Zalo / WhatsApp / LINE / Facebook inbox handling
  │     ├── Lead capture and CRM-lite logging
  │     ├── Support / sales / payment intent routing
  │     └── Requests content/campaign work from RAS2
  │
  ├── RAS2 — OpenClaw / Worker Agent
  │     ├── Content planning
  │     ├── Caption/post generation
  │     ├── Image/video generation workflow
  │     ├── Campaign asset preparation
  │     └── Drafts returned to RAS1 / human review
  │
  ├── Zernio / runagentsys.com Add-on — White-label Social Operations
  │     ├── Connected social accounts
  │     ├── Media, posts, drafts, scheduling
  │     ├── Inbox/events where supported
  │     ├── Webhooks and lifecycle events
  │     └── Tenant/profile/account mapping stored in RAS
  │
  ├── Google Workspace Layer — gog CLI
  │     ├── Gmail
  │     ├── Sheets CRM / lead log
  │     ├── Drive / Docs
  │     └── Calendar where needed
  │
  └── Platform Workflows
        ├── Social inbox/comment workflows
        ├── Multi-account/channel operations
        └── Platform-specific automation where API access allows
```

## 3. Component Responsibilities

### RAS SaaS Control Panel

The control panel is the primary web app.

Responsibilities:

- Login/session management.
- Tenant/customer records.
- Sandbox lifecycle: provisioned, starting, running, degraded, stopped, failed.
- Two-agent status per sandbox: RAS1 and RAS2.
- Health, logs, smoke tests, and incident visibility.
- Service/package management.
- Billing state and plan entitlement checks.
- Integration add-on mapping.
- Audit logs and admin actions.

### RAS1 — Hermes Main

RAS1 is the **operations and customer-care brain**.

Responsibilities:

- Receive messages from connected channels.
- Answer using customer-specific CSKH/sales/support knowledge.
- Ask short follow-up questions to qualify the lead.
- Capture lead/contact/support data.
- Route hot intents: demo, pricing, payment, invoice, custom deployment.
- Log conversation and lead state.
- Trigger RAS2 tasks for content/campaign/media work.
- Use secure connection references instead of raw secrets.

### RAS2 — OpenClaw / Worker Agent

RAS2 is the **content/media/workflow worker**.

Responsibilities:

- Generate captions, content calendars, campaign ideas.
- Generate image/video assets through configured providers.
- Prepare publishing drafts.
- Return outputs to RAS1, CRM, Sheets, asset library, or human review.
- Avoid direct access to customer credentials unless explicitly scoped.

### Zernio / runagentsys.com Add-on

Zernio is the **social operations add-on / white-label backend**, not the core backend for all RAS.

Responsibilities:

- Connected social accounts.
- Media handling.
- Posts, drafts, scheduling.
- Inbox/events where supported.
- Social lifecycle webhooks.
- Scoped social operation execution.

RAS stores local mapping:

```text
RAS tenant/customer/profile/account  <->  Zernio profile._id / accountId
```

Confirmed integration rules from Zernio OpenAPI/admin guidance:

- `POST /v1/profiles` documents `name`, `description`, `color`, `isDefault` only.
- Do not send undocumented profile fields such as `externalId`, `metadata`, or `email`.
- `POST /v1/posts` does not accept root `profileId`.
- `platforms` must be an array of objects like `{ platform, accountId }`, not strings.
- Platform-specific settings belong in `platforms[].platformSpecificData`.
- Post lifecycle webhook events include `post.scheduled`, `post.published`, `post.failed`, `post.partial`, `post.cancelled`, and `post.recycled`.
- 429 `Retry-After` is seconds; `X-RateLimit-Reset` is a Unix timestamp in seconds; limit is shared account-wide.

Customer-facing copy should usually say:

> Secure social account connection and publishing add-on

instead of saying `Zernio`.

### gog CLI

gog is used when the deployment needs Google Workspace integration.

Responsibilities:

- Gmail workflows.
- Sheets lead log / CRM-lite.
- Drive/Docs assets.
- Calendar tasks.

Rule: each customer must use isolated Google auth/account context. Do not mix owner/internal Google credentials with customer deployments.

## 4. Deployment Unit

Each customer gets an isolated deployment scope.

Recommended layout:

```text
/opt/ras/customers/<customer_id>/
  config/
    customer.yaml
    channels.yaml
    agents.yaml
    pricing.yaml
    integrations.yaml
  prompts/
    cskh.md
    sales.md
    support.md
    legal_contact.md
  data/
    conversations.jsonl
    leads.jsonl
    tasks.jsonl
    assets/
  logs/
    ras1-hermes.log
    ras2-openclaw.log
    zernio-addon.log
  backups/
```

Secrets must not be stored here as plaintext. Use secret references like:

```text
zernio://customer_id/provider/account_id
```

## 5. RAS1 → RAS2 Task Contract

RAS1 can request work from RAS2 using a small task contract.

Request:

```json
{
  "task_id": "task_xxx",
  "customer_id": "customer_xxx",
  "requested_by": "ras1-hermes",
  "task_type": "caption|content_plan|image|video|campaign_asset|publishing_draft",
  "priority": "normal|urgent",
  "input": {},
  "output_target": "asset_library|social_draft|customer_reply",
  "requires_human_review": true
}
```

Response:

```json
{
  "task_id": "task_xxx",
  "status": "completed|failed|needs_review",
  "text_outputs": [],
  "assets": [],
  "notes": [],
  "error": null
}
```

## 6. MVP Scope

### MVP must include

- Product scope: RAS Sandbox Agent Environment.
- Minimum login/session guard.
- Control panel dashboard shell.
- Tenant/customer mapping endpoints.
- Sandbox/env status model.
- Two-agent health/log model.
- Service/package management model.
- Mock/dry-run and live-gated Zernio add-on adapter.
- Zernio tenant/profile/account local mapping.
- Persistent fair queue/worker.
- Webhook receiver with idempotency.
- Audit log.
- VPS Docker deploy smoke.

### MVP does not need yet

- Full customer self-service provisioning without admin gate.
- Full billing provider automation.
- Rebuilding Zernio social operations backend.
- Large UI surface before login/dashboard/control panel basics are stable.
- Long-term analytics warehouse.

## 7. Roadmap Priority

1. Lock product scope: **RAS Sandbox Agent Environment**.
2. Fix fake Connected bug: do not show `Connected` unless a real account mapping exists and status is verified.
3. Build login + minimal dashboard/control panel.
4. Manage sandbox/env + 2 agents + health/logs.
5. Add service/package management.
6. Integrate Zernio as add-on by tenant/profile/account mapping.
7. Harden webhook, queue, billing, audit, smoke tests.

## 8. Topic Names

Use these working topics:

- **RAS Sandbox — Product Scope & Roadmap**
- **RAS Sandbox — Agent Env & Control Panel**
- **RAS Sandbox — Zernio Add-on / White-label Social**

Avoid the old `ras landing` framing.

## 9. Operating Rules

- Keep modules small and clean.
- Avoid over-complex loops/pipelines.
- Treat RAS core identity as internal; Zernio IDs are external references.
- Do not code against undocumented Zernio fields.
- Ask/confirm with Zernio admin when docs do not specify behavior.
- Production/VPS mutations need explicit human gate unless the action is already approved for the current task.
- Every live integration change needs staging smoke test and read-back verification.
