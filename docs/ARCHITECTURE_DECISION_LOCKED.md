# RunAgentSys / RAS — Locked Architecture Decision

Updated: 2026-07-17
Owner: namfive / RunAgentSys
Status: LOCKED FOR MVP IMPLEMENTATION

## 1. Product Positioning

RunAgentSys sells **managed AI automation deployments** for businesses.

It is **not** positioned as:

- VPS rental
- source-code resale
- a single chatbot API
- a generic SaaS login panel only

Customer-facing language should describe RAS as:

> A managed AI automation system deployed for your business, connecting customer care, social channels, CRM/leads, content, and workflow automation through secure account connections.

Do not expose internal component names such as `Zernio` in normal sales copy unless the customer asks for technical architecture.

## 2. Final MVP Architecture

```text
Customer Business
  │
  ▼
Customer VPS / Cloud / Managed Server
  │
  ├── RAS1 — Hermes Main
  │     ├── CSKH / sales chatbot
  │     ├── Telegram / Zalo / WhatsApp / LINE / Facebook inbox handling
  │     ├── Lead capture and CRM-lite logging
  │     ├── Support / sales / payment intent routing
  │     └── Requests content/campaign work from RAS2
  │
  ├── RAS2 — OpenClaw
  │     ├── Content planning
  │     ├── Caption/post generation
  │     ├── Image/video generation workflow
  │     ├── Campaign asset preparation
  │     └── Drafts returned to RAS1 / human review
  │
  ├── Secure Connection Layer — Zernio
  │     ├── OAuth/API connection registry
  │     ├── Secret references, not plaintext tokens
  │     ├── Refresh/revoke/offboarding
  │     └── Provider calls through scoped connections
  │
  ├── Google Workspace Layer — gog CLI
  │     ├── Gmail
  │     ├── Sheets CRM / lead log
  │     ├── Drive / Docs
  │     └── Calendar where needed
  │
  └── iSocial / Platform Workflows
        ├── Social inbox/comment workflows
        ├── Multi-account/channel operations
        └── Platform-specific automation where API access allows
```

## 3. Component Responsibilities

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

### RAS2 — OpenClaw

RAS2 is the **content/media/workflow worker**.

Responsibilities:

- Generate captions, content calendars, campaign ideas.
- Generate image/video assets through configured providers.
- Prepare publishing drafts.
- Return outputs to RAS1, CRM, Sheets, asset library, or human review.
- Avoid direct access to customer credentials unless explicitly scoped.

### Zernio

Zernio is the **secure account connection layer**.

Responsibilities:

- OAuth/API connection setup.
- Secret storage and reference IDs.
- Token refresh/revoke.
- Offboarding and permission cleanup.
- Prevent tokens/API keys from being placed in prompts, repos, logs, or customer config files.

Customer-facing copy should usually say:

> Secure OAuth/API connection setup

instead of saying `Zernio`.

### gog CLI

gog is used when the deployment needs Google Workspace integration.

Responsibilities:

- Gmail workflows.
- Sheets lead log / CRM-lite.
- Drive/Docs assets.
- Calendar tasks.

Rule: each customer must use isolated Google auth/account context. Do not mix owner/internal Google credentials with customer deployments.

### iSocial / Platform Workflows

iSocial is the social operation layer where available.

Responsibilities:

- Inbox/comment workflows.
- Multi-platform/account handling.
- Social sales operations.
- Bridge between RAS1 customer care and social platform execution.

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
    zernio.log
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

- RAS1 Hermes customer-care chatbot template.
- Telegram CSKH deployment sample.
- Lead capture/logging.
- Short follow-up CTA logic.
- Basic customer config templates.
- Mock/dry-run Zernio adapter.
- RAS1 → RAS2 task contract.
- One RAS2 content task sample.
- Google Sheets lead-log guide via gog.
- Website copy aligned with managed deployment positioning.

### MVP does not need yet

- Full SaaS dashboard.
- Unlimited platform connectors.
- Full billing automation.
- Full multi-tenant control plane.
- Unlimited video/content generation.
- Public source-code release.

## 7. Pricing Direction

Use:

- setup fee + monthly managed fee
- custom deployment from `$100/month` only as starting language
- clear scope-based pricing
- add-ons for extra channels/accounts/content/video

Recommended tiers:

- RAS Starter: chatbot + 1–2 channels + basic lead log
- RAS Growth: RAS1 + RAS2 + 3–5 channels + Google/CRM/content workflow
- RAS Pro / Agency: multi-brand, advanced workflows, custom integrations, SLA/support

Avoid promising unlimited video, guaranteed API access, or every platform without permission/API review.

## 8. Security Rules

- No plaintext customer secrets in repo.
- No tokens/API keys inside LLM prompts.
- No customer password collection unless there is no official alternative and the customer explicitly accepts.
- OAuth/API preferred.
- Per-customer data isolation.
- Backups exclude raw secrets.
- Offboarding must revoke OAuth and rotate/delete relevant credentials.

## 9. Implementation Order From This Locked Architecture

1. Convert current docs into customer config + compose skeleton.
2. Extract Hermes-CSKH behavior into reusable customer chatbot template.
3. Add mock Zernio adapter interface.
4. Add lead/support logging module.
5. Add RAS1 → RAS2 task queue/mock.
6. Add one RAS2 content generation sample.
7. Add gog/Sheets onboarding guide.
8. Update runagentsys.com copy so it matches this architecture.
9. Deploy one internal/test customer flow.
10. Only after MVP works, build dashboard/control plane.

## 10. Final Decision

The architecture is locked as:

> RAS = managed customer deployment package with RAS1 Hermes for operations/customer care, RAS2 OpenClaw for content/workflow execution, Zernio for secure OAuth/secrets, gog for Google Workspace, and iSocial/platform workflows for social operations.

Continue implementation from this model. Do not pivot back to VPS rental, source-code sale, or single chatbot SaaS positioning.
