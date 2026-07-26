# RunAgentSys Architecture RFC — Protected Customer Dashboard Contract

Updated: 2026-07-23
Status: RFC APPROVED FOR STEP 1 DOCS; implementation pending
Owner: Nam Vũ / RunAgentSys

## 1. Goal

Introduce a backward-compatible protected dashboard architecture for RunAgentSys without breaking the existing demo customer portal smoke path.

This RFC covers:

- A new protected dashboard route contract.
- A data schema shape for Base Plan + modular Add-ons.
- A safe migration path from demo customer state to dynamic customer sessions.

## 2. Backward-compatibility rule

The existing demo route must remain untouched during Step 1 and early Step 2.

| Route | Status | Purpose |
|---|---|---|
| `/customer-portal` | Keep | Public/demo smoke path for `demo_khach_2` while protected dashboard is built. |
| `/dashboard` | New protected route | Authenticated customer dashboard driven by session token. |
| `/auth/google` + `/auth/google/callback` | New Google OAuth-only login | Creates/loads the user and customer from the Google profile, then issues a session token/cookie and redirects to `/dashboard`. |

The demo route can only be hidden or cleaned up after `/dashboard` passes production smoke end-to-end.

## 3. Product model

RunAgentSys is modeled as a Base Plan plus optional Add-ons.

### 3.1 Base Plan

Every paid RAS VPS customer has exactly one base plan assignment.

The Base Plan includes:

- VPS/sandbox assignment.
- Exactly 2 default RAS agents:
  - `ras1-hermes`
  - `ras2-openclaw`
- Core dashboard visibility:
  - VPS status.
  - CPU/RAM/Uptime when available.
  - Agent heartbeat/status/log summary.

### 3.2 Add-ons

Add-ons are optional modules that can be purchased, renewed, expired, cancelled, or shown as inactive upsell banners.

Initial add-ons:

| Add-on key | Purpose |
|---|---|
| `zernio` | Zernio-backed social/profile/account integration. |
| `social_automation` | Social automation widgets/actions built on connected accounts. |

Inactive add-ons must return `active: false` instead of causing missing-field crashes.

## 4. Proposed schema

The schema is additive and backward-compatible with existing customer/service-package records.

```ts
export type RasBillingCycle = 'monthly' | 'yearly';
export type RasEntitlementStatus = 'active' | 'trial' | 'past_due' | 'expired' | 'cancelled' | 'disabled';
export type RasAddonKey = 'zernio' | 'social_automation';

export interface RasBasePlanAssignment {
  id: string;
  customerId: string;
  servicePackageId?: string;
  name: string;
  billingCycle: RasBillingCycle;
  status: RasEntitlementStatus;
  priceVnd?: number;
  startsAtIso?: string;
  expiresAtIso?: string;
  sandboxId?: string;
  includedAgentKinds: AgentKind[]; // must include ras1-hermes + ras2-openclaw for Base VPS
  createdAtIso: string;
  updatedAtIso: string;
}

export interface RasCustomerAddon {
  id: string;
  customerId: string;
  key: RasAddonKey;
  name: string;
  active: boolean;
  status: RasEntitlementStatus;
  priceVnd?: number;
  billingCycle?: RasBillingCycle;
  startsAtIso?: string;
  expiresAtIso?: string;
  featureFlags?: string[];
  createdAtIso: string;
  updatedAtIso: string;
}
```

### Migration/default behavior

For existing customers:

- If no explicit base plan exists, derive a base plan from `RasCustomer.servicePackageId`, `RasServicePackage`, sandbox, and agents.
- If no add-ons exist, return known add-ons with `active: false`.
- Do not delete or rename existing `RasServicePackage`, `RasSandboxEnvironment`, `RasAgentInstance`, or `ConnectedAccount` fields during initial rollout.

## 5. Protected dashboard API contract

### Request

```http
GET /dashboard
Authorization: Bearer <session_token>
```

Cookie-based session is also allowed:

```http
Cookie: ras_session=<session_token>
```

### Auth behavior

| Condition | Response |
|---|---|
| Missing token | `401 Unauthorized` |
| Expired/invalid token | `401 Unauthorized` |
| Valid token but disabled user/customer | `403 Forbidden` |
| Valid token | `200 OK` with dashboard data for the session customer only |

The backend must derive `customerId` from the session token. The frontend must not pass or trust `customerId` from query/env for protected dashboard data.

### Response shape

```json
{
  "ok": true,
  "source": "ras-backend",
  "customer": {
    "id": "customer_123",
    "name": "Acme Shop",
    "status": "active"
  },
  "basePlan": {
    "id": "base_123",
    "name": "Base VPS",
    "status": "active",
    "billingCycle": "monthly",
    "priceVnd": 1500000,
    "startsAtIso": "2026-07-01T00:00:00.000Z",
    "expiresAtIso": "2026-08-01T00:00:00.000Z"
  },
  "vps": {
    "id": "sandbox_123",
    "provider": "vps",
    "status": "running",
    "endpoint": "https://...",
    "metrics": {
      "cpuPercent": null,
      "ramPercent": null,
      "uptimeSeconds": null
    }
  },
  "agents": [
    {
      "id": "agent_ras1",
      "kind": "ras1-hermes",
      "status": "running",
      "lastHeartbeatAtIso": "2026-07-23T00:00:00.000Z",
      "lastLogExcerpt": "ok"
    },
    {
      "id": "agent_ras2",
      "kind": "ras2-openclaw",
      "status": "running",
      "lastHeartbeatAtIso": "2026-07-23T00:00:00.000Z",
      "lastLogExcerpt": "ok"
    }
  ],
  "addons": [
    {
      "key": "zernio",
      "name": "Zernio Integration",
      "active": true,
      "status": "active",
      "expiresAtIso": "2026-08-01T00:00:00.000Z",
      "widget": {
        "type": "zernio_accounts",
        "accountsTotal": 1,
        "accountsConnected": 1,
        "accountsNeedReconnect": 0
      }
    },
    {
      "key": "social_automation",
      "name": "Social Automation",
      "active": false,
      "status": "disabled",
      "banner": {
        "title": "Kích hoạt Social Automation",
        "cta": "Nâng cấp"
      }
    }
  ]
}
```

## 6. Frontend rendering rule

The protected dashboard renders three layers in order:

1. Base VPS card.
2. Two RAS Agent cards.
3. Add-on widgets if `active: true`; upgrade banners if `active: false`.

Missing optional fields must render as safe empty/unknown states, not crash.

## 7. Step-by-step rollout

1. Keep `/customer-portal` demo path unchanged.
2. Add schema/types and store defaults behind tests.
3. Add protected dashboard contract tests:
   - no token returns 401,
   - invalid token returns 401,
   - valid token returns only session customer data,
   - inactive add-ons return `active: false`.
4. Build Google OAuth-only `/login` UI: exactly one CTA, `Continue with Google`; no email field, no password field, no forgot-password flow.
5. Build `/dashboard` UI against the protected contract.
6. Smoke `/dashboard` production.
7. Only then hide or clean up the old demo route.

## 8. Login scope — Google OAuth only

RunAgentSys login is intentionally **not** an email/password product flow.

Approved scope:

- `/login` renders exactly one primary action: `Continue with Google`.
- Do not build Email, Password, Forgot Password, password reset, or local-password fallback flows in a later phase.
- User clicks Google login.
- Backend validates Google OAuth profile.
- Backend creates or loads a local `User` by Google subject/email.
- Backend creates or loads the customer mapping for that user.
- Backend issues the RunAgentSys session cookie/token.
- Backend redirects to `/dashboard`.

Required local mapping fields:

```ts
export interface RasUserIdentity {
  id: string;
  provider: 'google';
  providerSubject: string; // Google sub
  email: string;
  emailVerified: boolean;
  displayName?: string;
  avatarUrl?: string;
  customerId: string;
  status: 'active' | 'disabled';
  createdAtIso: string;
  updatedAtIso: string;
}
```

## 9. Zernio add-on provisioning model — Profile/API slot pool first

Zernio remains an internal/partner social-operations add-on behind RunAgentSys. Customers should not need to understand Zernio directly.

Approved MVP model:

- Maintain a `ProfileSlot` pool in RAS.
- Each slot maps one RAS customer to one Zernio `profileId`.
- RAS stores only external Zernio IDs and slot status; OAuth/platform tokens stay inside Zernio.
- For MVP, prepared slots are acceptable: create a small number of Zernio profiles ahead of time, mark them `available`, then assign to customers after payment/order activation.
- Do not create hundreds of unused slots up front.
- Automatic profile creation after payment can be added later through the same slot API: if no slot is available, create one via `POST /v1/profiles`, then assign it.

```ts
export type RasProfileSlotStatus = 'available' | 'reserved' | 'assigned' | 'disabled';

export interface RasProfileSlot {
  id: string;
  provider: 'zernio';
  zernioProfileId: string;
  status: RasProfileSlotStatus;
  assignedCustomerId?: string;
  planKey?: RasAddonKey;
  allowedPlatforms?: string[];
  maxConnectedAccounts?: number;
  notes?: string;
  createdAtIso: string;
  updatedAtIso: string;
}
```

Technical assumptions from current Zernio references:

- `POST /v1/profiles` supports profile creation with documented fields such as `name`, `description`, `color`, and `isDefault`.
- RAS must not depend on undocumented Zernio profile fields like `externalId`, `metadata`, or `email`.
- RAS should keep `customerId ↔ zernioProfileId` in its own database.
- Connected accounts are later handled as `Zernio accountId` records under the assigned profile.

Resolved Zernio quota/provisioning decision:

- Zernio profiles are tenant containers only. They do not have per-profile quota fields such as `slots`, `maxAccounts`, or `allowedConnections`.
- Zernio account limits/billing are enforced at the billing-owner/team level, based on the total number of active social accounts across the team.
- Customer package quota such as “5 connected accounts” is RAS-owned business logic, not Zernio configuration.
- RAS must enforce package limits locally with `ProfileSlot.allowedPlatforms`, `maxConnectedAccounts`, billing status, queue limits, and UI gating.
- On payment webhook success, RAS can create profile containers with `POST /v1/profiles` and persist the profile/API-key mapping before the customer connects any social account.
- Idle profiles are acceptable: a profile/API key can remain pending in RAS DB until the customer later connects social accounts.
- Connect flow: when the customer clicks `Connect account`, RAS calls Zernio `GET /v1/connect/{platform}?profileId=...` to obtain the OAuth `authUrl`.
- Important platform rule: one account per platform per Zernio profile. If a customer needs multiple accounts on the same platform, RAS must allocate multiple Zernio profiles; if they need different platforms, one profile can be enough.

## 10. Acceptance criteria for Step 1

- RFC/API contract is documented.
- README links to the protected dashboard contract.
- Roadmap marks Step 1 as documented, not implemented.
- Existing demo route remains explicitly preserved.
- `npm run check` passes.
