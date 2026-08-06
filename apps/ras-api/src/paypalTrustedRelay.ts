import { createHmac, randomUUID } from 'node:crypto';

export const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';

type CheckoutIntent = { id: string; paypalOrderId?: string; amount: string; currency: string };
type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type PaypalTrustedRelayConfig = {
  paypalMode?: string;
  paypalClientId?: string;
  paypalClientSecret?: string;
  assertionSecret?: string;
  internalApiToken?: string;
  /** Deployment-owned URL only; never obtained from the caller. */
  rasInternalBaseUrl: string;
};

export type RelayResult = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string };

function canonicalAssertion(value: Record<string, string>): string {
  return JSON.stringify({ intentId: value.intentId, paypalOrderId: value.paypalOrderId, transactionId: value.transactionId, amount: value.amount, currency: value.currency, status: value.status, issuedAtIso: value.issuedAtIso, expiresAtIso: value.expiresAtIso, nonce: value.nonce });
}

function configuredRasCaptureUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    // Production must use TLS. HTTP is deliberately limited to local compose/development.
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', 'ras-api'].includes(url.hostname))) return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return new URL('/billing/payments/captured', url).toString();
  } catch { return undefined; }
}

function completedCapture(order: unknown, orderId: string, amount: string, currency: string): { id: string } | undefined {
  if (!order || typeof order !== 'object' || Array.isArray(order)) return undefined;
  const value = order as Record<string, unknown>;
  if (value.id !== orderId || value.status !== 'COMPLETED' || !Array.isArray(value.purchase_units)) return undefined;
  for (const unit of value.purchase_units) {
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) continue;
    const captures = (unit as { payments?: { captures?: unknown } }).payments?.captures;
    if (!Array.isArray(captures)) continue;
    for (const capture of captures) {
      if (!capture || typeof capture !== 'object' || Array.isArray(capture)) continue;
      const row = capture as { id?: unknown; status?: unknown; amount?: { value?: unknown; currency_code?: unknown } };
      if (typeof row.id === 'string' && row.status === 'COMPLETED' && row.amount?.value === amount && row.amount.currency_code === currency) return { id: row.id };
    }
  }
  return undefined;
}

/**
 * Server-side PayPal Sandbox verification boundary. The only caller controlled
 * values are the already-authenticated intent and PayPal order identifiers.
 */
export async function relayPaypalSandboxCapture(input: { intent: CheckoutIntent; paypalOrderId: string }, config: PaypalTrustedRelayConfig, fetcher: FetchLike = fetch): Promise<RelayResult> {
  if (config.paypalMode !== 'sandbox') return { ok: false, status: 503, error: 'paypal_sandbox_relay_not_configured' };
  if (!config.paypalClientId || !config.paypalClientSecret || !config.assertionSecret || !config.internalApiToken) return { ok: false, status: 503, error: 'paypal_sandbox_relay_not_configured' };
  const captureUrl = configuredRasCaptureUrl(config.rasInternalBaseUrl);
  if (!captureUrl) return { ok: false, status: 503, error: 'invalid_ras_internal_base_url' };
  if (input.intent.paypalOrderId !== input.paypalOrderId) return { ok: false, status: 409, error: 'checkout_intent_not_bound_to_paypal_order' };

  const basic = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString('base64');
  let tokenResponse: Awaited<ReturnType<FetchLike>>;
  try { tokenResponse = await fetcher(`${PAYPAL_SANDBOX_API}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' }); } catch { return { ok: false, status: 502, error: 'paypal_oauth_request_failed' }; }
  if (!tokenResponse.ok) return { ok: false, status: 502, error: 'paypal_oauth_failed' };
  let accessToken: unknown;
  try { accessToken = (await tokenResponse.json() as { access_token?: unknown }).access_token; } catch { return { ok: false, status: 502, error: 'paypal_oauth_failed' }; }
  if (typeof accessToken !== 'string' || !accessToken) return { ok: false, status: 502, error: 'paypal_oauth_failed' };

  let orderResponse: Awaited<ReturnType<FetchLike>>;
  try { orderResponse = await fetcher(`${PAYPAL_SANDBOX_API}/v2/checkout/orders/${encodeURIComponent(input.paypalOrderId)}`, { headers: { authorization: `Bearer ${accessToken}` } }); } catch { return { ok: false, status: 502, error: 'paypal_order_request_failed' }; }
  if (!orderResponse.ok) return { ok: false, status: 502, error: 'paypal_order_fetch_failed' };
  let capture: { id: string } | undefined;
  try { capture = completedCapture(await orderResponse.json(), input.paypalOrderId, input.intent.amount, input.intent.currency); } catch { return { ok: false, status: 502, error: 'paypal_order_fetch_failed' }; }
  if (!capture) return { ok: false, status: 422, error: 'paypal_order_not_completed_or_mismatched' };

  const issuedAtIso = new Date().toISOString();
  const assertion = { intentId: input.intent.id, paypalOrderId: input.paypalOrderId, transactionId: capture.id, amount: input.intent.amount, currency: input.intent.currency, status: 'COMPLETED', issuedAtIso, expiresAtIso: new Date(Date.now() + 5 * 60_000).toISOString(), nonce: randomUUID() };
  const signature = createHmac('sha256', config.assertionSecret).update(canonicalAssertion(assertion)).digest('hex');
  let rasResponse: Awaited<ReturnType<FetchLike>>;
  try { rasResponse = await fetcher(captureUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ras-internal-token': config.internalApiToken, 'x-ras-relay-assertion-signature': `sha256=${signature}` }, body: JSON.stringify({ intent_id: input.intent.id, paypal_order_id: input.paypalOrderId, transaction_id: capture.id, capture_status: 'COMPLETED', relay_assertion: assertion, rawCapture: { paypalOrderId: input.paypalOrderId } }) }); } catch { return { ok: false, status: 502, error: 'ras_capture_forward_failed' }; }
  const body = await rasResponse.json().catch(() => ({}));
  return rasResponse.ok ? { ok: true, status: rasResponse.status, body } : { ok: false, status: 502, error: 'ras_capture_rejected' };
}

export function paypalRelayConfigFromEnv(env: NodeJS.ProcessEnv, localRasBaseUrl: string): PaypalTrustedRelayConfig {
  return { paypalMode: env.PAYPAL_MODE, paypalClientId: env.PAYPAL_CLIENT_ID, paypalClientSecret: env.PAYPAL_CLIENT_SECRET, assertionSecret: env.RAS_PAYMENT_RELAY_ASSERTION_SECRET, internalApiToken: env.RAS_INTERNAL_API_TOKEN, rasInternalBaseUrl: env.RAS_INTERNAL_API_BASE_URL ?? localRasBaseUrl };
}
