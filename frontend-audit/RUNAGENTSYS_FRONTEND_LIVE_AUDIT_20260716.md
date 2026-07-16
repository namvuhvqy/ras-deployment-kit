# RunAgentSys Live Frontend Audit — 2026-07-16

Source checked: `https://runagentsys.com` via web fetch.

## Summary

The top/architecture sections mostly match the updated RAS positioning, but the pricing section still has old SaaS-style plans and claims that conflict with the current product strategy.

## Good / already aligned

- Page title/hero says Managed AI Agent Service — RAS1 + RAS2.
- It explains RAS1 as Social/Chatbot/Ads Agent.
- It explains RAS2 as Content/Video/Workflow Agent.
- It says RAS is not VPS rental; cloud is foundation behind automation.
- It mentions OAuth2/no passwords.
- It mentions PayPal/card and invoice.
- It includes Custom RAS Deployment from `$100/month`.
- Quick contact positioning appears customer-facing.

## Issues to fix

### 1. Old SaaS plans still visible

The page still shows:

- Starter `$19/month`
- Growth `$49/month`
- 14-day free trial
- Start Free Trial CTA

This conflicts with current RAS package positioning: customer buys setup package on VPS/cloud with RAS1/RAS2/Zernio/gog/iSocial, not cheap SaaS self-serve plans.

Recommendation:
- Remove Starter/Growth sections, or mark them as deprecated/unavailable.
- Replace with package-based pricing: Starter Setup, Growth Deployment, Pro/Agency.

### 2. Custom RAS price needs setup-fee framing

Current custom deployment starts at `$100/month`, which is okay as “from”, but it should mention setup fee and scope dependency.

Recommended copy:

> Custom RAS Deployment starts from $100/month. Setup fee applies depending on VPS/cloud, channels/accounts, OAuth connections, chatbot customization, RAS2 content/video workflows and support scope.

### 3. Security claims may be too strong without legal proof

The page says:

- OAuth 2.0 Certified
- GDPR Compliant
- TLS 1.3

If there is no formal certification/compliance documentation, soften wording.

Recommended:

- “OAuth2-first connection flow” instead of “OAuth 2.0 Certified”.
- “Designed with GDPR-style data minimization and permission control” instead of “GDPR Compliant”, unless legally verified.
- “SSL/TLS encryption where deployed” instead of absolute TLS 1.3 unless verified.

### 4. “One Connection for All” may overpromise

The page says connect once and unlock all features. In reality, each platform/API may require separate permissions and approval.

Recommended:

> Connect supported accounts through secure OAuth/API flows. Available features depend on each platform’s permissions and your account access.

### 5. Outcome metrics need caveats

The page uses 85%, 2s, 40h. These can be kept as examples but should be framed as example outcomes, not guaranteed.

Recommended:

> Example outcomes from mature workflows; final results depend on FAQ quality, volume, platform access and process design.

## Recommended pricing blocks

### RAS Starter Setup

- Setup fee: from $99–199.
- Monthly: from $100–149.
- 1–2 channels.
- RAS1 CSKH chatbot.
- Basic lead log.
- Zernio secret/OAuth setup.
- No heavy video/content included.

### RAS Growth Deployment

- Setup fee: from $299–699.
- Monthly: from $199–399.
- RAS1 + RAS2.
- 3–5 channels/accounts.
- gog/Google Workspace option.
- CRM/Sheets/follow-up.
- Basic content workflow.

### RAS Pro / Agency

- Setup fee: from $799+.
- Monthly: from $499+.
- Multi-brand/multi-account.
- Advanced iSocial.
- Custom CRM/API.
- Content/video workflows.
- SLA/support by agreement.

## Frontend action list

1. Replace old Starter/Growth SaaS cards.
2. Keep Custom RAS Deployment but add setup-fee/scope note.
3. Add explicit “Full VPS/cloud package includes” section:
   - RAS1 Hermes Main
   - RAS2 OpenClaw
   - Zernio OAuth/secrets
   - gog CLI / Google Workspace
   - iSocial workflows
   - chatbot CSKH template
4. Soften legal/security claims unless verified.
5. Keep quick contact widget customer-facing.
6. Add “platform/API access depends on customer permissions” note.
