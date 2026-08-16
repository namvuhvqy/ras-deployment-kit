# RAS Roadmap

## Post V1 — official contract delivery plan

**Current state:** P0, P1, and P2 are complete. Post V1 is **not** yet eligible to be described as complete for all official provider capabilities; P3 is the next planned phase.

**P0 authority:** [`docs/POST_V1_PLATFORM_CONTRACT.md`](docs/POST_V1_PLATFORM_CONTRACT.md). Official source URLs and their intended use are pinned in [`docs/ZERNIO_OFFICIAL_SOURCE_MANIFEST.md`](docs/ZERNIO_OFFICIAL_SOURCE_MANIFEST.md). For Zernio Posts, the operation-level schema for `POST /v1/posts` is authoritative over overview or marketing copy.

| Phase | Scope | State |
|---|---|---|
| P0 Contract baseline & roadmap correction | Record canonical Zernio Posts enum; resolve Slack/WhatsApp scope; define three-level `google_business` / `googlebusiness` identifier policy; pin operation-level OpenAPI snapshot/parity policy | `PASS` |
| P1 Static Platform Contract Registry + connection availability | Central versioned registry for canonical provider contract; separate it from connection-specific availability/capability; adapter mapping tests and public DTO non-leak tests | `PASS` |
| P2 Typed platform-settings framework | Capability-gated, typed, allowlisted `platformSpecificData` validation and UI/BFF projection; Slack is Post V1 supported; WhatsApp is intentionally excluded to Messaging/Broadcast/Inbox | `PASS` |
| P3 Media foundation | Tenant-scoped presign/direct-upload boundary, ownership/expiry, validation, typed media DTO, and per-platform media preflight | `NEXT` |
| P4 Multi-target Post Core | One durable Post Core across multiple tenant-owned connections, target-level result/history, safe duplicate reconciliation | `PLANNED` |
| P5 Provider scheduling & shared throttling | Distinguish exact `scheduledFor`/`timezone` from `queuedFromProfile`; shared team limiter honoring provider rate-limit headers, `Retry-After`, and velocity controls | `PLANNED` |
| P6 Complete lifecycle & reconciliation | Explicit official lifecycle handling/safe decisions, webhook-first result projection, bounded reconciliation and observability | `PLANNED` |
| P7 Contract completeness verification | Operation-level OpenAPI and Agent Tool parity, registry fixtures, tenant/mapping/negative tests, full build and independent review | `PLANNED` |

### Canonical Post V1 platform scope

**RAS public normalized identifiers:**

```text
twitter, instagram, tiktok, youtube, facebook, linkedin, bluesky, threads,
reddit, pinterest, telegram, snapchat, google_business, discord, slack
```

**Zernio provider identifiers:**

```text
twitter, instagram, tiktok, youtube, facebook, linkedin, bluesky, threads,
reddit, pinterest, telegram, snapchat, googlebusiness, discord, slack
```

- Three-level Google Business policy: public RAS identifier `google_business`; internal Post V1 canonical identifier `google_business`; Zernio adapter-wire identifier `googlebusiness`. The conversion is adapter-boundary-only.
- Slack is supported for Post V1.
- WhatsApp belongs to Messaging/Broadcast/Inbox and must be absent from every Post V1 capability, DTO, settings, validation, adapter post-target, worker/lifecycle, fixture, and test surface.

### Phase boundaries

- P2 closure evidence: backend contract `e19c45531d942db327224ea18626c645139b3e04`; frontend Preview `7390cbab49013fea4dfd320bfe93a4f275cdf350`, deployment `dpl_DuEoR75BtNESxPzMuJAd84Zs7Eiu`, verified through the stable `feat/post-v1-slice-2` Preview alias with an Owner-confirmed tenant-test session. Desktop/mobile screenshots and redacted read-only QA evidence are retained outside the repository. No provider, tenant-data, Production, connect/disconnect, publish, or schedule mutation was performed for closure.

- P1 separates a static/versioned platform contract registry from connection-specific availability. Do not duplicate full provider contract data into every connection record without a concrete need.
- Capability, settings, media, cross-posting, queues, lifecycle, and rate limits remain fail-closed until their named phase has passed tests/review.
- Pin the operation-level `POST /v1/posts` OpenAPI contract with snapshot/parity tests. Do not build a speculative compatibility/versioning layer; Zernio’s stated policy is additive changes with advance notice of breaking changes.
- P7 PASS is **not** release approval, Staging authorization, Production approval, or provider E2E proof.

### Provider E2E / release lane

`NOT AUTHORIZED — separate post-P7 Owner gate required.`

No canary, provider mutation, webhook subscription change, provisioning, Staging live-mode change, or Production release is implied by this roadmap.

## Payment Slice A

`PASS — Backend Staging checkpoint preserved. STOPPED.` Follow-up capture/outbox/provider work requires a separate Owner approval.

## Other lanes

Inbox, Ads, and Production remain outside Post V1 and unchanged.
