# Zernio Official Source Manifest

**Verified:** `2026-08-15` (UTC)  
**Policy:** This manifest pins external official documentation references used for RAS Post V1 contract work. It stores URLs and their intended use only; it does not vendor or copy Zernio documentation.

| # | Official URL | Intended use in RAS Post V1 |
|---|---|---|
| 1 | https://docs.zernio.com/openapi.yaml | Operation-level API contract; `POST /v1/posts` is authoritative for the canonical Posts enum and request/response shape. |
| 2 | https://docs.zernio.com/platforms | Cross-platform publishing/connection capability overview and platform naming cross-check. |
| 3 | https://docs.zernio.com/guides/platform-settings | Platform-specific posting settings reference; input for the future P2 allowlist, not a public RAS DTO contract by itself. |
| 4 | https://docs.zernio.com/multi-tenant | Tenant/profile/account isolation model reference. |
| 5 | https://docs.zernio.com/multi-tenant/publishing | Tenant publishing, idempotency, queue, and lifecycle design reference. |
| 6 | https://docs.zernio.com/media/uploads | Provider media-upload flow reference for the future P3 boundary. |
| 7 | https://docs.zernio.com/guides/rate-limits | Provider rate-limit and throttling reference for the future P5 boundary. |
| 8 | https://docs.zernio.com/webhooks | Webhook signature, delivery, deduplication, and event reference for lifecycle work. |
| 9 | https://docs.zernio.com/llms-full.txt | Official documentation index/reference corpus used only for source discovery and cross-checking. |

## Pinning rule

For any conflict, the operation-level OpenAPI schema for the relevant endpoint governs implementation. Source changes must be evaluated through the Post V1 contract/parity tests before they alter RAS behavior.
