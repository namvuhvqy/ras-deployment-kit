# RAS Deployment Architecture — VPS/Cloud Package

Updated: 2026-07-16
Owner: namfive / RunAgentSys

## 1. Product Definition

RAS is sold as a **managed setup package** deployed on the customer's VPS/cloud, not as a single chatbot API.

A customer buys a ready-to-run system containing:

- **RAS1 — Hermes Main**: social/customer-care/CRM/lead/operations agent.
- **RAS2 — OpenClaw**: content/video/campaign workflow agent.
- **Zernio**: secure OAuth2/secrets/connection layer used by RAS skills/integrations.
- **gog CLI**: Google Workspace integration layer where needed.
- **iSocial / multi-platform workflows**: social inbox/comment/channel management.
- **Customer-care chatbot template**: based on Hermes-CSKH behavior, customized per customer.

Important correction: `hermes-cskh-api` is only a chatbot CSKH/sales prototype/template. It is not the central Zernio backend.

## 2. High-Level Diagram

```text
Customer VPS / Cloud

┌─────────────────────────────────────────────────────────────────┐
│                         RAS Deployment                           │
│                                                                 │
│  ┌───────────────────────────┐      ┌────────────────────────┐  │
│  │ RAS1 — Hermes Main         │      │ RAS2 — OpenClaw         │  │
│  │ - CSKH chatbot             │◄────►│ - content generation    │  │
│  │ - social inbox/comment     │ task │ - image/video plugins   │  │
│  │ - CRM/leads/follow-up      │      │ - campaign assets       │  │
│  │ - iSocial management       │      │ - publishing drafts     │  │
│  └─────────────┬─────────────┘      └───────────┬────────────┘  │
│                │                                │               │
│                ▼                                ▼               │
│  ┌───────────────────────────┐      ┌────────────────────────┐  │
│  │ Zernio Secure Layer        │      │ gog CLI / Google WS     │  │
│  │ - OAuth2 sessions          │      │ - Gmail/Sheets/Drive    │  │
│  │ - secret references        │      │ - Calendar/Docs         │  │
│  │ - refresh/revoke           │      │ - per-customer account  │  │
│  │ - connection registry      │      └────────────────────────┘  │
│  └─────────────┬─────────────┘                                   │
│                │                                                 │
│                ▼                                                 │
│   External channels/platforms                                    │
│   Telegram / Zalo / Facebook / Instagram / TikTok / WhatsApp /   │
│   LINE / Google / YouTube / LinkedIn / API-based systems         │
└─────────────────────────────────────────────────────────────────┘
```

## 3. RAS1 — Hermes Main Responsibilities

RAS1 is the operations/customer-care agent.

Core responsibilities:

- Receive messages from connected channels.
- Run customer-care chatbot logic customized per customer.
- Classify intent: sales, support, legal/contact, payment/invoice, spam, unknown.
- Manage inbox/comment workflows.
- Capture leads and support cases.
- Follow up through CRM/Sheets/internal store.
- Coordinate with iSocial workflows.
- Request secure connections/secrets through Zernio, not through plaintext prompts.
- Use gog CLI for Google Workspace tasks when the customer connects Google.
- Ask RAS2/OpenClaw for content/video/campaign tasks.

## 4. RAS2 — OpenClaw Responsibilities

RAS2 is the content/media/workflow agent.

Core responsibilities:

- Generate content plans, captions, product posts, campaign copy.
- Generate images/videos through installed OpenClaw plugins/providers.
- Prepare campaign assets and draft calendars.
- Support publishing workflows by passing outputs back to RAS1/iSocial.
- Never receive raw OAuth secrets unless strictly required; prefer secret references or scoped task execution.

## 5. Zernio Role

Zernio is the secure connection layer inside the RAS package.

It should provide:

```python
zernio.create_oauth_session(customer_id, provider, scopes)
zernio.list_connections(customer_id)
zernio.get_connection(customer_id, provider, account_id=None)
zernio.refresh_token(connection_id)
zernio.revoke_connection(connection_id)
zernio.store_secret(customer_id, key, value)
zernio.get_secret_ref(customer_id, key)
zernio.call_provider(connection_id, action, payload)
```

Rules:

- Do not expose Zernio in customer-facing sales/chatbot copy unless intentionally explaining technical setup.
- Do not log OAuth tokens/API keys.
- Do not place secrets inside LLM prompts.
- Use secret references such as `zernio://customer/provider/account`.
- Support revoke/offboarding.

## 6. gog CLI Role

Use gog CLI for Google Workspace tasks after customer OAuth/account setup.

Use cases:

- Gmail monitoring/responding/summarization.
- Google Sheets lead log / CRM-lite.
- Drive/Docs content assets.
- Calendar tasks/reminders.

Need per-customer account isolation. Do not mix customer Google auth with owner/internal accounts.

## 7. Customer Deployment Unit

Suggested filesystem layout:

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

Secrets should not live here as plaintext; use Zernio/vault references.

## 8. MVP Deployment Order

1. Create clean `ras-product` repo skeleton.
2. Add documentation, customer config template, docker compose skeleton, deploy script skeleton.
3. Extract Hermes-CSKH prompt/behavior into reusable chatbot template.
4. Add Zernio adapter interface with dry-run/mock implementation.
5. Add gog CLI checklist and per-customer auth guide.
6. Deploy Telegram CSKH live for one test customer.
7. Add lead/support logging.
8. Add RAS1 → RAS2 task contract.
9. Add content/video workflow sample.
10. Expand iSocial connectors: Zalo/Facebook/Instagram/WhatsApp/LINE depending on API access.

## 9. RAS1 ↔ RAS2 Task Contract

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

RAS2 response:

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

## 10. Security Baseline

- OAuth/API via Zernio where possible.
- No customer password collection unless no official alternative and customer explicitly accepts.
- No plaintext token logs.
- No secrets in repo.
- `.env.example` only, never `.env`.
- Per-customer config isolation.
- Backups exclude raw secrets.
- Offboarding: revoke OAuth, rotate tokens, export/delete customer data as contracted.

## 11. Current Local Findings

Observed on 2026-07-16:

- `hermes-cskh-api` is running on local port `9121` as chatbot CSKH prototype.
- `hermes` container is running and represents Hermes main runtime area.
- `zalo-crm-*`, `zalocrm-cskh-webhook`, `n8n`, `flow2api`, `telegram-hermes-bridge` are running.
- No dedicated `ras-product` repo exists yet.
- Existing `projects/namvu-agents` repo is very small (`infrastructure/agents.md`, `secrets_reference.md`).
- GitHub CLI auth is currently invalid for account `chunchin211877-web`; creating a new GitHub repo requires re-auth or another token.
- Hermes/Hermes-CSKH runtime folders contain secrets/logs/backups and should not be copied wholesale into a product repo.

## 12. Next Engineering Steps

- Build repo skeleton under workspace first.
- Add clean templates only.
- Add `.gitignore` covering secrets/logs/runtime state.
- Add frontend/product page audit and pricing model.
- After owner confirms repo name + GitHub auth, create remote repo and push clean skeleton.
