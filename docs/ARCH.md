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
| `/auth/login` | Existing/future login API | Issues a session token/cookie for customer dashboard access. |

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
4. Build `/login` UI.
5. Build `/dashboard` UI against the protected contract.
6. Smoke `/dashboard` production.
7. Only then hide or clean up the old demo route.

## 8. Acceptance criteria for Step 1

- RFC/API contract is documented.
- README links to the protected dashboard contract.
- Roadmap marks Step 1 as documented, not implemented.
- Existing demo route remains explicitly preserved.
- `npm run check` passes.
