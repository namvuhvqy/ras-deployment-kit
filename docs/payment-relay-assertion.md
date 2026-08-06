# Payment relay assertion contract

`POST /billing/payments/captured` accepts only RAS's signed relay assertion in addition to `x-ras-internal-token`. This **authenticates RAS's relay assertion; it is not direct PayPal verification** and it makes no PayPal network call.

The relay must set `RAS_PAYMENT_RELAY_ASSERTION_SECRET` on both services and send `x-ras-relay-assertion-signature: sha256=<hex HMAC-SHA256>`. The HMAC input is this exact JSON object with keys in this exact order:

```json
{"intentId":"...","paypalOrderId":"...","transactionId":"...","amount":"server-derived intent amount","currency":"USD","status":"COMPLETED","issuedAtIso":"ISO-8601","expiresAtIso":"ISO-8601","nonce":"unique nonce"}
```

Put that same object in `relay_assertion`, and duplicate its order/transaction/status in the existing capture fields. RAS loads the durable intent and rejects assertions whose intent, amount, currency, status, signature, expiry (maximum 10 minutes), future issue time (maximum 60 seconds), or nonce do not match. A nonce is persisted after a successful capture: the identical same-intent replay is idempotent; a nonce reused for another capture is rejected.

## PayPal Sandbox trusted relay

`POST /billing/paypal/sandbox/capture` is the dedicated authenticated relay endpoint. A session caller may provide only `intent_id` and `paypal_order_id`; it cannot supply a payment amount, currency, capture status, customer, assertion, or destination URL. The checkout intent must belong to that session's lead or tenant and already be bound to the same PayPal order.

The relay is Sandbox-only (`PAYPAL_MODE=sandbox`). It uses server-only `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` to obtain an OAuth client-credential token from the fixed `https://api-m.sandbox.paypal.com` endpoint, then fetches the fixed PayPal order endpoint. It forwards only when the fetched order ID matches, contains a `COMPLETED` capture, and that capture's amount/currency exactly equal the durable intent. It signs the canonical assertion above with `RAS_PAYMENT_RELAY_ASSERTION_SECRET` and sends it with `RAS_INTERNAL_API_TOKEN` to the deployment-owned `RAS_INTERNAL_API_BASE_URL` (HTTPS except approved local/compose hosts). The relay does not create customers, tenants, profiles, or Zernio resources; the existing capture/outbox worker path remains the sole provisioning path.

The downstream intent/nonce transaction provides idempotency: an identical capture relay retry returns its prior payment and does not enqueue provisioning twice; conflicting duplicates are rejected. This relay itself deliberately does not make arbitrary caller-directed requests, preventing SSRF.

## Staging rollout

Before enabling, deploy the API with `PAYPAL_MODE=sandbox`, server-only PayPal Sandbox credentials, the shared `RAS_PAYMENT_RELAY_ASSERTION_SECRET`, `RAS_INTERNAL_API_TOKEN`, and a deployment-owned `RAS_INTERNAL_API_BASE_URL` that resolves back to this RAS API (or its internal service DNS). Configure the PayPal checkout creator to bind the created order to the durable checkout intent through the existing internal bind endpoint. Plain static-header-only captures are intentionally rejected.
