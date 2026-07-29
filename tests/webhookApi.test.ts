import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();

async function withApi<T>(state: Record<string, unknown>, env: Record<string, string>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ras-webhook-api-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 20_080 + Math.floor(Math.random() * 1000);
  await writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`);
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, PORT: String(port), RAS_DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('ras-api listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
    });
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

function emptyState(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    migratedAtIso: now,
    users: [],
    sessions: [],
    customers: [],
    sandboxes: [],
    agents: [],
    servicePackages: [],
    connectedAccounts: [],
    jobs: [],
    webhookEvents: [],
    auditLogs: [],
  };
}

function signature(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

test('zernio master webhook verifies payload.id/event, schema, HMAC, audit and dedupe', async () => {
  const state = emptyState();
  state.customers = [{ id: 'cust_1', name: 'Customer', zernioProfileId: 'profile_1' }];
  const rawBody = JSON.stringify({ id: 'evt_1', event: 'account.connected', account: { accountId: 'acct_1', profileId: 'profile_1', platform: 'facebook', username: 'ag' }, timestamp: now });
  await withApi(state, { ZERNIO_WEBHOOK_SECRET: 'topsecret' }, async (baseUrl) => {
    const headers = { 'content-type': 'application/json', 'x-zernio-signature': signature('topsecret', rawBody) };
    const first = await fetch(`${baseUrl}/api/v1/webhooks/zernio`, { method: 'POST', headers, body: rawBody });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, deduped: false, eventId: 'evt_1', signature: 'verified' });
    const duplicate = await fetch(`${baseUrl}/webhooks/zernio`, { method: 'POST', headers, body: rawBody });
    assert.equal(duplicate.status, 200);
    const logs = await fetch(`${baseUrl}/webhooks/zernio/status`);
    const payload = (await logs.json()) as { status: { recentEvents: Array<{ id: string; eventType: string }>; } };
    assert.deepEqual(payload.status.recentEvents.map((event) => [event.id, event.eventType]), [['evt_1', 'account.connected']]);
  });
});

test('zernio master webhook is fail-closed for bad signature and invalid schema', async () => {
  const rawBody = JSON.stringify({ id: 'evt_bad', event: 'account.connected', timestamp: now });
  await withApi(emptyState(), { ZERNIO_WEBHOOK_SECRET: 'topsecret' }, async (baseUrl) => {
    const badSignature = await fetch(`${baseUrl}/webhooks/zernio`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zernio-signature': 'bad' }, body: rawBody });
    assert.equal(badSignature.status, 401);
    const schemaInvalid = await fetch(`${baseUrl}/webhooks/zernio`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-zernio-signature': signature('topsecret', rawBody) }, body: rawBody });
    assert.equal(schemaInvalid.status, 422);
  });
});

test('zernio master webhook refuses delivery when the server secret is absent', async () => {
  const rawBody = JSON.stringify({ id: 'evt_secret', event: 'webhook.test', message: 'test', timestamp: now });
  await withApi(emptyState(), { ZERNIO_WEBHOOK_SECRET: '' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/zernio`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody });
    assert.equal(response.status, 400);
  });
});

test('PayPal Sandbox webhook is fail-closed without explicitly enabled Sandbox verification config', async () => {
  await withApi(emptyState(), { PAYPAL_MODE: 'sandbox', PAYPAL_WEBHOOK_ID_SANDBOX: '' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/paypal/sandbox`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'paypal-transmission-id': 'sandbox-event-1',
        'paypal-transmission-time': now,
        'paypal-transmission-sig': 'not-a-valid-signature',
        'paypal-cert-url': 'https://api-m.sandbox.paypal.com/certs/CERT-1',
        'paypal-auth-algo': 'SHA256withRSA',
      },
      body: JSON.stringify({ id: 'WH-EVENT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED' }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'paypal_sandbox_webhook_not_configured' });
  });
});

test('PayPal Sandbox webhook rejects missing PayPal transmission headers before processing', async () => {
  await withApi(emptyState(), { PAYPAL_MODE: 'sandbox', PAYPAL_WEBHOOK_ID_SANDBOX: 'sandbox-webhook-id', PAYPAL_CLIENT_ID: 'sandbox-client', PAYPAL_CLIENT_SECRET: 'sandbox-secret' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/paypal/sandbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'WH-EVENT-2', event_type: 'PAYMENT.CAPTURE.COMPLETED' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'missing_paypal_transmission_headers' });
  });
});

test('PayPal Sandbox webhook never records an event when PayPal signature verification fails', async () => {
  await withApi(emptyState(), { PAYPAL_MODE: 'sandbox', PAYPAL_WEBHOOK_ID_SANDBOX: 'sandbox-webhook-id', PAYPAL_CLIENT_ID: 'invalid-client', PAYPAL_CLIENT_SECRET: 'invalid-secret' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/paypal/sandbox`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'paypal-transmission-id': 'sandbox-event-invalid',
        'paypal-transmission-time': now,
        'paypal-transmission-sig': 'invalid',
        'paypal-cert-url': 'https://api-m.sandbox.paypal.com/certs/CERT-1',
        'paypal-auth-algo': 'SHA256withRSA',
      },
      body: JSON.stringify({ id: 'WH-EVENT-3', event_type: 'PAYMENT.CAPTURE.COMPLETED' }),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: 'invalid_paypal_webhook_signature' });
  });
});
