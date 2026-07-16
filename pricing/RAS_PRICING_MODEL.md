# RAS Pricing Model Draft

## Product framing

RAS is a managed setup + monthly operations package. Customer pays for:

- VPS/cloud setup or managed deployment.
- RAS1 Hermes main: CSKH/social/CRM/leads/iSocial.
- RAS2 OpenClaw: content/video workflow.
- Zernio OAuth2/secrets layer.
- gog CLI / Google Workspace integration when needed.
- Setup, customization, testing, and support.

## Cost buckets

### 1. Infrastructure

Typical monthly cost range:
- VPS small: $6–12/month.
- VPS medium: $15–30/month.
- Storage/backup: $3–15/month.
- Domain/SSL: usually low or customer-owned.

### 2. Zernio / connection layer

Need actual cost confirmed. Treat as either:
- included internal tool cost, or
- external SaaS/infra cost passed through.

Placeholder: $5–30/month depending on provider/account volume.

### 3. Models / AI usage

Known user note: GPT Plus-like model cost > 450k VND/month.

For pricing model:
- Base AI/model allowance should be capped.
- Heavy content/video generation should be add-on or usage-based.
- Video generation can become expensive; do not bundle unlimited video.

Estimated baseline:
- Text/chatbot: $10–30/month depending volume/provider.
- Content/image/video: variable; charge separately or cap.

### 4. Setup labor

Real setup includes:
- server provisioning
- domains/SSL
- RAS1/RAS2 installation
- OAuth onboarding
- chatbot customization
- channel testing
- handover/training

This should not be priced as a cheap monthly-only service.

### 5. Support/maintenance

Monthly managed cost includes:
- monitoring
- bug fixes
- minor prompt updates
- connector troubleshooting
- backups
- basic support

## Recommended pricing structure

### Option A — Safer commercial model

**Setup fee + monthly fee**

- Setup: $199–499 one-time.
- Monthly managed: from $149–299/month.
- Extra channel/account: $5–20/month each depending complexity.
- Content/video add-on: from $49–199/month or usage-based.

Why: protects margin because setup labor and troubleshooting are real.

### Option B — Entry package for market testing

- Setup: $99–199 one-time.
- Monthly: from $99/month.
- Limit: 1–2 channels, chatbot + basic lead log only.
- No heavy video/content included.

Why: easier to sell, but lower margin. Good for pilots.

### Option C — Current old baseline adjusted

Earlier chatbot copy says custom deployment from `$100/month`. Keep this only as **starting from** and pair with setup fee.

Suggested customer-facing:

> Custom RAS Deployment starts from $100/month, depending on channels, accounts, workflow scope, AI usage, and support level. Setup fee may apply for VPS/cloud, OAuth connections, and custom chatbot/workflow configuration.

## Recommended offer tiers

### RAS Starter Setup

- 1 VPS/cloud deployment.
- RAS1 Hermes main.
- Customer-care chatbot template.
- 1–2 channels.
- Basic lead log.
- Basic Zernio secret/OAuth setup.
- Monthly from $100–149.
- Setup $99–199.

### RAS Growth

- RAS1 + RAS2.
- 3–5 channels/accounts.
- iSocial workflows.
- Google Workspace/gog integration.
- CRM/Sheets/follow-up.
- Basic content workflow.
- Monthly $199–399.
- Setup $299–699.

### RAS Pro / Agency

- Multi-brand/multi-account.
- Advanced iSocial workflows.
- Custom CRM/API integration.
- Content/video workflows.
- SLA/support process.
- Monthly $499+.
- Setup $799+.

## Margin rule

Do not price below:

`monthly price >= infra + zernio + model usage + support reserve + 40% margin`

Setup fee should cover at least:

`estimated setup hours × hourly target + deployment risk reserve`

## Customer-facing note

Avoid over-promising:
- no unlimited video
- no guaranteed API access for every platform
- OAuth/API depends on customer permissions and platform rules
- final price depends on scope
