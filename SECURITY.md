# Security policy

Report vulnerabilities privately to the repository maintainers. Do not open public issues for exploitable findings. Include reproduction steps, affected version/commit, and impact. We will acknowledge reports within five business days.

## Deployment requirements

Production must set `RAS_CANONICAL_ORIGIN`, `GOOGLE_OAUTH_CALLBACK_URL`, and the comma-separated exact `RAS_FRONTEND_ORIGINS`. Configure `RAS_INTERNAL_API_TOKENS` with one or more rotating internal relay credentials; do not log these values.

OAuth callbacks now send `code` (not a bearer session token) to `/api/auth/google/callback`. The frontend must POST `{ "code": "..." }` to `/auth/google/exchange` with its allowed `Origin` header, then store the returned session token according to its normal security policy.
