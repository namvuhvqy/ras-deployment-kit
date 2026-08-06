import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayPaypalSandboxCapture } from '../apps/ras-api/src/paypalTrustedRelay.js';

const intent = { id: 'intent_1', paypalOrderId: 'ORDER-1', amount: '19', currency: 'USD' };
const config = { paypalMode: 'sandbox', paypalClientId: 'client', paypalClientSecret: 'secret', assertionSecret: 'assertion', internalApiToken: 'internal', rasInternalBaseUrl: 'http://127.0.0.1:8080' };
const response = (ok: boolean, status: number, body: unknown) => ({ ok, status, json: async () => body });
const paypalOrder = (overrides: Record<string, unknown> = {}) => ({ id: 'ORDER-1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { value: '19', currency_code: 'USD' } }] } }], ...overrides });

test('PayPal relay forwards only a verified bound completed capture once with canonical assertion data', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/token')) return response(true, 200, { access_token: 'access' });
    if (url.includes('/v2/checkout/orders/')) return response(true, 200, paypalOrder());
    return response(true, 202, { ok: true, provisioning: { queued: true } });
  };
  const result = await relayPaypalSandboxCapture({ intent, paypalOrderId: 'ORDER-1' }, config, fetcher);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  const forwarded = JSON.parse(String(calls[2]?.init?.body)) as { intent_id: string; transaction_id: string; relay_assertion: { amount: string; currency: string; status: string } };
  assert.deepEqual(forwarded.relay_assertion.amount, '19');
  assert.equal(forwarded.relay_assertion.currency, 'USD');
  assert.equal(forwarded.relay_assertion.status, 'COMPLETED');
  assert.equal(forwarded.transaction_id, 'CAP-1');
  assert.equal(forwarded.intent_id, 'intent_1');
  assert.match(String(calls[2]?.init?.headers && (calls[2]?.init?.headers as Record<string, string>)['x-ras-relay-assertion-signature']), /^sha256=[a-f0-9]{64}$/);
});

test('PayPal relay rejects unbound order before network access', async () => {
  let calls = 0;
  const result = await relayPaypalSandboxCapture({ intent, paypalOrderId: 'OTHER' }, config, async () => { calls++; return response(true, 200, {}); });
  assert.deepEqual(result, { ok: false, status: 409, error: 'checkout_intent_not_bound_to_paypal_order' });
  assert.equal(calls, 0);
});

test('PayPal relay rejects OAuth failures and never forwards', async () => {
  let calls = 0;
  const result = await relayPaypalSandboxCapture({ intent, paypalOrderId: 'ORDER-1' }, config, async () => { calls++; return response(false, 401, {}); });
  assert.deepEqual(result, { ok: false, status: 502, error: 'paypal_oauth_failed' });
  assert.equal(calls, 1);
});

for (const [name, order] of [
  ['wrong order', paypalOrder({ id: 'OTHER' })],
  ['wrong currency', paypalOrder({ purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { value: '19', currency_code: 'EUR' } }] } }] })],
  ['wrong amount', paypalOrder({ purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { value: '1', currency_code: 'USD' } }] } }] })],
  ['non-completed capture', paypalOrder({ purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'PENDING', amount: { value: '19', currency_code: 'USD' } }] } }] })],
]) {
  test(`PayPal relay rejects ${name} without forwarding`, async () => {
    let calls = 0;
    const result = await relayPaypalSandboxCapture({ intent, paypalOrderId: 'ORDER-1' }, config, async (url) => { calls++; return url.endsWith('/token') ? response(true, 200, { access_token: 'access' }) : response(true, 200, order); });
    assert.deepEqual(result, { ok: false, status: 422, error: 'paypal_order_not_completed_or_mismatched' });
    assert.equal(calls, 2);
  });
}

test('PayPal relay rejects non-sandbox configuration and unsafe RAS target', async () => {
  assert.equal((await relayPaypalSandboxCapture({ intent, paypalOrderId: 'ORDER-1' }, { ...config, paypalMode: 'live' }, async () => response(true, 200, {}))).status, 503);
  const unsafe = await relayPaypalSandboxCapture({ intent, paypalOrderId: 'ORDER-1' }, { ...config, rasInternalBaseUrl: 'http://example.test' }, async () => response(true, 200, {}));
  assert.deepEqual(unsafe, { ok: false, status: 503, error: 'invalid_ras_internal_base_url' });
});
