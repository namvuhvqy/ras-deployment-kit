# RAS Post V1 — Platform Contract Decision (P0)

**Status:** `P0 PASS — Owner-approved contract baseline`

**Authority:** Owner decision dated 2026-08-15, based on direct Zernio confirmation. For posting, the operation-level schema for `POST /v1/posts` is authoritative over overview, marketing, or other descriptive documentation.

## Canonical Zernio Posts provider enum

The canonical provider identifiers for `POST /v1/posts` are exactly:

```text
twitter, instagram, tiktok, youtube, facebook, linkedin, bluesky, threads,
reddit, pinterest, telegram, snapchat, googlebusiness, discord, slack
```

- **Slack:** supported by Zernio Posts and is in scope for RAS Post V1.
- **WhatsApp:** intentionally excluded from RAS Post V1. It belongs to Zernio Messaging/Broadcast/Inbox domain, not the Zernio Posts operation contract.
- The prior apparent Slack/WhatsApp discrepancy is resolved and is not an open architecture blocker.

## RAS public identifier policy

RAS retains its existing public normalized identifier:

```text
google_business
```

This avoids an unnecessary public API/UI refactor. The identifier policy has three levels:

1. **RAS public identifier:** `google_business` — the only identifier exposed in customer-safe RAS API DTOs, UI, capability/settings/validation input, and opaque-connection projections.
2. **RAS internal canonical identifier:** `google_business` — persisted and used by Post V1 core, registry, validation, worker, and tenant mapping code.
3. **Zernio provider-wire identifier:** `googlebusiness` — used only while constructing/parsing the Zernio adapter request/response boundary.

The adapter boundary conversion is:

```text
google_business -> googlebusiness
```

No Zernio provider identifier is to leak upward from that boundary into public RAS DTOs, opaque connection IDs, customer UI, or persisted Post V1 core contracts solely because of this mapping.

## WhatsApp Post V1 exclusion policy

WhatsApp is intentionally outside Zernio Posts and RAS Post V1. It belongs to the Messaging/Broadcast/Inbox domain. It must be absent from **all** Post V1 surfaces: platform registry, capability DTOs, public and internal Post V1 request/response DTOs, platform-settings schemas, validation allowlists, text/media constraints, adapter post-target conversion, worker post execution, lifecycle/platform-result projection, fixtures, and tests. This exclusion does not restrict WhatsApp work in its separate Messaging domain.

## Required P1 contract tests

P1 must add a single centralized, versioned **Platform Contract Registry** and tests that prove:

1. the RAS Post V1 public enum is exactly the approved RAS public set, including `google_business` and `slack`, and excluding `whatsapp`;
2. the provider post enum is exactly the canonical Zernio list above;
3. conversion at the adapter boundary maps only `google_business` to `googlebusiness` and preserves every other approved identifier;
4. no provider identifier is exposed from customer-safe public RAS projections;
5. the registry is pinned to the operation-level OpenAPI snapshot/parity test.
6. WhatsApp is rejected/absent across every Post V1 capability, DTO, settings, validation, adapter, fixture, and lifecycle surface.

## Change policy

Zernio has stated a preference for additive changes and advance notice of breaking changes. RAS V1 therefore pins the operation-level OpenAPI contract and maintains snapshot/parity tests. It does not introduce a speculative compatibility/versioning layer unless a concrete official contract change requires one.

## Lifecycle and release boundary

Completion of P7 (Contract completeness verification) is a contract-verification result only. It is not Staging, production, provider E2E, canary, or release approval. Any provider E2E/canary remains a separate Owner-authorized lane after P7.
