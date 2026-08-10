import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();

async function withApi(run: (baseUrl: string, dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ras-security-remediation-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 23000 + Math.floor(Math.random() * 1000);
  await writeFile(dbPath, JSON.stringify({ schemaVersion: 1, migratedAtIso: now, users: [{ id: 'owner', email: 'owner@example.com', password: 'secret', role: 'owner', customerId: 'cust', status: 'active', createdAtIso: now, updatedAtIso: now }], sessions: [], customers: [{ id: 'cust', name: 'Customer', status: 'active', createdAtIso: now }], sandboxes: [], agents: [], servicePackages: [], connectedAccounts: [], jobs: [], webhookEvents: [], auditLogs: [] }));
  const mockGoogle = `const originalFetch = globalThis.fetch; globalThis.fetch = async (url, init) => { if (String(url) === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'google_access' }), { status: 200, headers: { 'content-type': 'application/json' } }); if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return new Response(JSON.stringify({ email: 'google@example.com', email_verified: true }), { status: 200, headers: { 'content-type': 'application/json' } }); return originalFetch(url, init); }; await import('./dist/apps/ras-api/src/server.js');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', mockGoogle], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), RAS_DB_PATH: dbPath, GOOGLE_OAUTH_CLIENT_ID: 'client', GOOGLE_OAUTH_CLIENT_SECRET: 'secret', GOOGLE_OAUTH_CALLBACK_URL: 'https://api.example.test/auth/google/callback', RAS_FRONTEND_ORIGINS: 'https://app.example.test', RAS_CANONICAL_ORIGIN: 'https://api.example.test', RAS_INTERNAL_API_TOKEN: 'test-internal-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 5000); child.stdout.on('data', (chunk) => { if (String(chunk).includes('ras-api listening')) { clearTimeout(timer); resolve(); } }); child.on('error', reject); });
    await run(`http://127.0.0.1:${port}`, dbPath);
  } finally { child.kill(); await new Promise<void>((resolve) => child.once('exit', resolve)); await rm(dir, { recursive: true, force: true }); }
}

test('OAuth browser handoff is opaque, origin-bound and single-use; sessions rotate and revoke', async () => {
  await withApi(async (baseUrl) => {
    const login = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'secret' }) });
    const original = (await login.json()) as { token: string };
    const rotated = await fetch(`${baseUrl}/auth/session/rotate`, { method: 'POST', headers: { authorization: `Bearer ${original.token}` } });
    assert.equal(rotated.status, 200);
    const replacement = (await rotated.json()) as { token: string };
    assert.notEqual(replacement.token, original.token);
    assert.equal((await fetch(`${baseUrl}/api/v1/me`, { headers: { authorization: `Bearer ${original.token}` } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${replacement.token}` } })).status, 204);
    assert.equal((await fetch(`${baseUrl}/api/v1/me`, { headers: { authorization: `Bearer ${replacement.token}` } })).status, 401);

    const start = await fetch(`${baseUrl}/auth/google?redirectTo=/dashboard&frontendOrigin=https://app.example.test`);
    const authUrl = new URL(((await start.json()) as { authUrl: string }).authUrl);
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://api.example.test/auth/google/callback');
    const callback = await fetch(`${baseUrl}/auth/google/callback?code=test&state=${encodeURIComponent(authUrl.searchParams.get('state') ?? '')}`, { redirect: 'manual' });
    assert.equal(callback.status, 302);
    const handoff = new URL(callback.headers.get('location') ?? '');
    assert.equal(handoff.origin, 'https://app.example.test');
    assert.equal(handoff.searchParams.get('token'), null);
    const code = handoff.searchParams.get('code');
    assert.ok(code?.startsWith('handoff_'));
    const denied = await fetch(`${baseUrl}/auth/google/exchange`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example.test' }, body: JSON.stringify({ code }) });
    assert.equal(denied.status, 403);
    const exchange = await fetch(`${baseUrl}/auth/google/exchange`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.test' }, body: JSON.stringify({ code }) });
    // This is a direct server-side fetch: acceptance is based on the bound Origin,
    // not browser CORS response headers.
    assert.equal(exchange.status, 200);
    assert.equal(exchange.headers.get('access-control-allow-origin'), null);
    assert.ok(((await exchange.json()) as { token: string }).token.startsWith('sess_'));
    const replay = await fetch(`${baseUrl}/auth/google/exchange`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.test' }, body: JSON.stringify({ code }) });
    assert.equal(replay.status, 400);
  });
});

test('PayPal capture validates raw evidence before consuming its bound checkout intent', async () => {
  await withApi(async (baseUrl, dbPath) => {
    const internalHeaders = { 'content-type': 'application/json', 'x-ras-internal-token': 'test-internal-token' };
    const login = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'secret' }) });
    const token = ((await login.json()) as { token: string }).token;
    const created = await fetch(`${baseUrl}/billing/checkout-intents`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ plan: 'lite', billing_cycle: 'monthly', extra_connect_slots: 0 }) });
    assert.equal(created.status, 201);
    const intentId = ((await created.json()) as { intent: { id: string } }).intent.id;
    const bound = await fetch(`${baseUrl}/billing/checkout-intents/bind-paypal-order`, { method: 'POST', headers: internalHeaders, body: JSON.stringify({ intent_id: intentId, customer_id: 'cust', paypal_order_id: 'ORDER-RAW-1' }) });
    assert.equal(bound.status, 200);

    const capture = async (rawCapture: unknown, transactionId = 'CAP-RAW-1') => fetch(`${baseUrl}/billing/payments/captured`, { method: 'POST', headers: internalHeaders, body: JSON.stringify({ intent_id: intentId, paypal_order_id: 'ORDER-RAW-1', transaction_id: transactionId, capture_status: 'COMPLETED', rawCapture }) });
    for (const rawCapture of [{ id: 'CAP-RAW-1', status: 'PENDING' }, { id: 'OTHER-CAPTURE', status: 'COMPLETED' }, { id: 'CAP-RAW-1', status: 'COMPLETED', evidence: 'x'.repeat(16_385) }]) {
      const rejected = await capture(rawCapture);
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json() as { error: string }).error, 'invalid_raw_capture');
      const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { checkoutIntents: Array<{ id: string; status: string }> };
      assert.equal(persisted.checkoutIntents.find((intent) => intent.id === intentId)?.status, 'bound');
    }

    const accepted = await capture({ id: 'CAP-RAW-1', status: 'COMPLETED', create_time: '2026-08-10T00:00:00Z', unsafe: { secret: 'discard' } });
    assert.equal(accepted.status, 202);
    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { checkoutIntents: Array<{ id: string; status: string }>; billingPayments: Array<{ rawCapture: Record<string, unknown> }> };
    assert.equal(persisted.checkoutIntents.find((intent) => intent.id === intentId)?.status, 'consumed');
    assert.deepEqual(persisted.billingPayments[0]?.rawCapture, { id: 'CAP-RAW-1', status: 'COMPLETED', create_time: '2026-08-10T00:00:00Z' });
    const replay = await capture({ id: 'CAP-RAW-1', status: 'COMPLETED' });
    assert.equal(replay.status, 202);
    const replayed = JSON.parse(await readFile(dbPath, 'utf8')) as { checkoutIntents: Array<{ id: string; status: string }>; billingPayments: unknown[]; jobs: unknown[] };
    assert.equal(replayed.checkoutIntents.find((intent) => intent.id === intentId)?.status, 'consumed');
    assert.equal(replayed.billingPayments.length, 1);
    assert.equal(replayed.jobs.length, 1);
  });
});
