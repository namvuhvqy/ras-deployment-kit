# Payment relay assertion contract

`POST /billing/payments/captured` accepts only RAS's signed relay assertion in addition to `x-ras-internal-token`. This **authenticates RAS's relay assertion; it is not direct PayPal verification** and it makes no PayPal network call.

The relay must set `RAS_PAYMENT_RELAY_ASSERTION_SECRET` on both services and send `x-ras-relay-assertion-signature: sha256=<hex HMAC-SHA256>`. The HMAC input is this exact JSON object with keys in this exact order:

```json
{"intentId":"...","paypalOrderId":"...","transactionId":"...","amount":"server-derived intent amount","currency":"USD","status":"COMPLETED","issuedAtIso":"ISO-8601","expiresAtIso":"ISO-8601","nonce":"unique nonce"}
```

Put that same object in `relay_assertion`, and duplicate its order/transaction/status in the existing capture fields. RAS loads the durable intent and rejects assertions whose intent, amount, currency, status, signature, expiry (maximum 10 minutes), future issue time (maximum 60 seconds), or nonce do not match. A nonce is persisted after a successful capture: the identical same-intent replay is idempotent; a nonce reused for another capture is rejected.

## Staging rollout

Deploy the relay counterpart that produces this assertion and configures the shared current secret **before** enabling this API change in Staging. Plain static-header-only captures are intentionally rejected.
