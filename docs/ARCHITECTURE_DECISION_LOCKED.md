# RunAgentSys / RAS — Locked Architecture Decision

Updated: 2026-07-22
Owner: Nam Vũ / RunAgentSys
Status: LOCKED FOR MVP IMPLEMENTATION

## 1. Decision summary

RunAgentSys MVP is locked as **two commercial service lines managed by one shared RunAgentSys backend/control panel**.

```text
Service A — RunAgentSys Webapp / Zernio Integration
  Customer gets a web account on runagentsys.com.
  Customer connects supported platforms through the dashboard.
  RunAgentSys backend maps the customer to prepared Zernio profile/account slots.

Service B — Managed RAS VPS 2-Agent Setup
  Customer gets a dedicated VPS/sandbox prepared by the team.
  VPS contains RAS1 + RAS2 agents.
  Customer may receive SSH access, but normal business users operate via runagentsys.com.
```

Both services share the same customer/order/package/onboarding backend. Do **not** create two unrelated backends for MVP.

## 2. MVP customer flow

```text
Lead/customer arrives
  ├─ via runagentsys.com registration/contact form
  └─ or via sale/manual conversation
        ↓
Sale/Admin creates or activates customer account
        ↓
Admin assigns package
  ├─ zernio_webapp
  ├─ ras_vps_2_agent
  └─ hybrid
        ↓
Admin assigns prepared resources
  ├─ Zernio profile/account slot for webapp integrations
  └─ VPS/sandbox record for managed 2-agent setup, if included
        ↓
Customer logs in to runagentsys.com
        ↓
Customer connects Telegram/WhatsApp/Facebook/Zalo/other platforms allowed by package
        ↓
RunAgentSys backend calls Zernio/API layer behind the scenes
        ↓
Dashboard shows real integration/agent/onboarding status
```

Customer-facing language should not require the customer to understand Zernio. Say “secure social/platform integration” unless discussing technical architecture.

## 3. Product positioning

RunAgentSys is **not**:

- A landing-page-only project.
- A VPS rental-only product.
- Source-code resale.
- A Zernio clone.
- A product where Zernio is the entire backend.
- A product where business customers must use SSH for normal setup.

RunAgentSys **is**:

- A webapp/control panel where customers register, get an account, and connect platforms.
- A shared customer/order/onboarding backend.
- A managed setup service for VPS deployments with two agents when the package requires it.
- A Zernio-integrated social/platform operations layer hidden behind RunAgentSys UX.

## 4. Shared backend responsibilities

The backend must manage the minimum objects needed for the two service lines:

| Object | MVP purpose |
|---|---|
| Customer | Who bought or is onboarding |
| Order/Package | What service was sold: webapp, VPS 2-agent, or hybrid |
| ProfileSlot | Prepared Zernio/API slot: available/assigned/disabled |
| Integration | Customer platform connection state |
| VpsAssignment | Which VPS/sandbox belongs to which customer, if any |
| AgentStatus | RAS1/RAS2 health/status/log summary, if any |
| Audit/OnboardingStatus | Who assigned what, next step, errors |

MVP can start with JSON/local persistence if tests are strong. Do not overbuild billing, auto provisioning, or enterprise multi-tenancy before the sales/onboarding flow works.

## 5. Zernio role

Zernio is the **social/platform integration backend/add-on**, not the full RAS core backend.

Responsibilities:

- Connected social accounts.
- Media/posts/drafts/scheduling where supported.
- Platform lifecycle/webhook events where supported.
- Social account verification and reconnect state.

RAS stores local mapping:

```text
RAS customer/profile slot/integration  <->  Zernio profile._id / SocialAccount._id
```

Confirmed integration rules:

- `POST /v1/profiles` documents `name`, `description`, `color`, `isDefault` only.
- Do not send undocumented profile fields such as `externalId`, `metadata`, or `email`.
- `POST /v1/posts` does not accept root `profileId`.
- `platforms` must be an array of objects like `{ platform, accountId }`, not strings.
- Platform-specific settings belong in `platforms[].platformSpecificData`.
- Webhooks are at-least-once; dedup by payload/event id and verify signature when configured.
- 429 handling must honor `Retry-After` and global/team rate limits.

## 6. RAS VPS 2-Agent service

For the managed VPS service, each assigned VPS/sandbox contains:

```text
Tenant VPS / Cloud Sandbox
  ├── RAS1 — Hermes Main
  │     ├── CSKH / sales chatbot
  │     ├── Telegram / Zalo / WhatsApp / Facebook inbox handling
  │     ├── Lead capture / CRM-lite logging
  │     └── Requests content/campaign work from RAS2
  │
  └── RAS2 — Worker Agent
        ├── Content planning
        ├── Caption/post generation
        ├── Image/video workflow
        ├── Campaign asset preparation
        └── Drafts returned to RAS1 / human review
```

MVP provisioning is manual/admin-assisted:

1. Team prepares VPS + 2 agents.
2. Admin records VPS assignment in backend.
3. Customer sees service/agent status in dashboard.
4. SSH key can be handed over for technical customers, but dashboard remains the normal integration path.

## 7. MVP scope

### Must include now

- Customer account creation by sale/admin, with web registration/contact as lead source.
- Package type: `zernio_webapp`, `ras_vps_2_agent`, `hybrid`.
- Prepared ProfileSlot pool: available/assigned/disabled.
- Assign profile slot to customer.
- Customer integration dashboard using assigned profile slot.
- Real connection state: `not_connected`, `connecting`, `connected`, `needs_reconnection`, `failed`, `lastVerifiedAt`.
- Admin customer/profile/VPS/onboarding view.
- Zernio webhook receiver with dedup/signature/failure logging.
- Tests for customer/profile assignment and integration status.

### Explicitly later

- Fully automated VPS creation.
- Auto install/rotate SSH keys.
- Complex billing/subscription automation.
- Live social publishing without human gate.
- Enterprise multi-tenant/RBAC complexity.

## 8. Repo/testing direction

Short term, two repos are acceptable only if API contracts stay locked and tests cover the boundary.

For faster MVP end-to-end testing, prefer migrating toward one monorepo:

```text
runagentsys/
  apps/web
  apps/api
  apps/worker
  packages/shared
  packages/zernio-adapter
  docs
  tests
```

Do not migrate just for cleanliness; migrate when it reduces broken end-to-end testing between web dashboard and backend.

## 9. Guardrails

- Keep code simple and business-flow-first.
- Do not fake `Connected` state in frontend.
- Keep Zernio IDs as external references, not RAS primary IDs.
- Production/VPS mutations require explicit approval.
- Live credentials and live publishing require explicit human gate.
- Every integration change needs a read-back/smoke verification.
