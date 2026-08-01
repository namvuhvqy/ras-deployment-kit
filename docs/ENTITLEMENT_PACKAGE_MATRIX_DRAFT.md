# RAS Entitlement & Service Package Matrix — Draft for Pricing Approval

Updated: 2026-08-01
Status: **internal draft — not public pricing, not a billing change**
Owner: Nam Vũ / RunAgentSys

## 1. Product rules already implemented

- RAS, not Zernio, owns package entitlement and social quota.
- Entitlement is split: `basePlan`, `connectSlots`, `addOns`.
- Base plans are `lite`, `pro`, `max`; billing cycle is monthly/yearly.
- Each core plan has one included social slot in the first month. Extra slots are `$6/slot/month`.
- Backend recomputes checkout total; client `total_amount` is not trusted.
- Inbox remains human-gated: `read → draft → explicit approval → worker send`.
- PAT access stays separate from raw provider credentials.

## 2. Proposed capability matrix

| Capability | Lite | Pro | Max | Add-on / rule |
|---|---|---|---|---|
| Managed VPS | 2 vCPU / 4 GB / 40 GB | 4 vCPU / 8 GB / 80 GB | 8 vCPU / 16 GB / 160 GB | Base plan |
| RAS agents | 2: Hermes + OpenClaw | 2: Hermes + OpenClaw | 2: Hermes + OpenClaw | Base plan |
| AI token allowance | Standard | Extra | Highest | exact allocation remains ops-configured |
| Support | Ticket/Chat | Priority 1-1 | Account manager | Base plan |
| Backup | Daily | Daily | Daily | Base plan |
| Included Connect slot | 1 first month | 1 first month | 1 first month | `connectSlots.trialSlots=1`; set expiry explicitly |
| Extra Connect slots | $6/slot/month | $6/slot/month | $6/slot/month | `connectSlots.purchasedSlots` |
| Channel management | quota-gated | quota-gated | quota-gated | requires active `zernio-connect` entitlement |
| Inbox read | planned | planned | planned | Phase 6B, scope `inbox:read` |
| Inbox draft | planned | planned | planned | Phase 6B, scope `inbox:draft` |
| Inbox approval | owner/admin only | owner/admin only | owner/admin only | Phase 6B, scope `inbox:approve` |
| PAT API | controlled | controlled | controlled | existing narrow allow-list; not raw Zernio API |

## 3. Entitlement mapping

```ts
RasEntitlement = {
  basePlan: {
    planId: 'lite' | 'pro' | 'max',
    status: 'active',
    billingCycle: 'monthly' | 'yearly',
    monthlyPriceUsd: 19 | 39 | 59,
    vps: { type: 'dedicated', size: 'small' | 'standard' | 'large' },
    agents: { included: 2, kinds: ['ras1-hermes', 'ras2-openclaw'] },
    activatedAtIso, expiresAtIso,
  },
  connectSlots: {
    status: 'active' | 'inactive',
    includedSlots: 0,
    purchasedSlots: extraConnectSlots,
    trialSlots: 1, // only first month, explicit expiry
    totalSlots: purchasedSlots + trialSlots,
    activeConnectedAccounts,
    trialExpiresAtIso,
  },
  addOns: [
    { id: 'zernio-connect', name: 'Social Connect', status: 'active' | 'inactive' },
  ],
};
```

After the free first-month slot ends, renewal behavior must be explicitly selected before public release: (A) customer buys a paid slot, or (B) existing account becomes connect-disabled but remains visible/read-only. Do not silently disconnect provider accounts.

## 4. Pricing/public-copy decisions still required

These are business decisions and therefore intentionally not changed in `/pay` yet:

1. Currency/display policy: USD-only vs VND equivalent/tax language.
2. Exact yearly discount and whether billing is annual prepay.
3. Exact monthly AI-token allowance per plan.
4. Included first-month slot conversion/renewal policy.
5. Whether Inbox read/draft is included in all tiers or tied to a `social-inbox` add-on.
6. Support SLA wording and account-manager eligibility.
7. Refund/cancellation/provisioning policy.

## 5. Public pricing release gate

Only after the seven decisions above are approved:

1. Update backend authoritative plan table and entitlement provisioning tests.
2. Update `/pay` copy/matrix in a clean frontend worktree.
3. Verify no Phone/SMS/Dedicated Number copy appears.
4. Run backend check plus frontend lint/build.
5. Stage authenticated checkout/provisioning smoke; obtain separate approval before production deploy.

## 6. Recommended next implementation order

1. Dashboard Phase 5B with existing entitlement fields.
2. Admin customer/order/package assignment Phase 5C.
3. Inbox Phase 6B UI using the human-gated contract.
4. Pricing finalization and public release only after business decisions are approved.
