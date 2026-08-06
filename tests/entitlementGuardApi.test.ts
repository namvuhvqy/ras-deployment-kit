import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();
function entitlement(expiresAtIso: string) {
  return { basePlan: { planId: 'lite', status: 'active', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, expiresAtIso }, connectSlots: { status: 'active', includedSlots: 1, purchasedSlots: 0, trialSlots: 0, totalSlots: 1, activeConnectedAccounts: 0 }, addOns: [{ id: 'zernio', name: 'Zernio Connect', status: 'active' }] };
}
async function withApi(state: Record<string, unknown>, run: (url: string, path: string) => Promise<void>, env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ras-entitlement-guard-')); const path = join(dir, 'store.json'); const port = 22_000 + Math.floor(Math.random() * 1000);
  await writeFile(path, JSON.stringify(state));
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], { cwd: process.cwd(), env: { ...process.env, ...env, PORT: String(port), RAS_DB_PATH: path }, stdio: ['ignore', 'pipe', 'pipe'] });
  try { await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 5000); child.stdout.on('data', (data) => { if (String(data).includes('ras-api listening')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); }); await run(`http://127.0.0.1:${port}`, path); } finally { child.kill(); await new Promise<void>((resolve) => child.once('exit', resolve)); await rm(dir, { recursive: true, force: true }); }
}
function state(expiresAtIso: string) { return { schemaVersion: 1, migratedAtIso: now, users: [{ id: 'user', email: 'a@test', role: 'owner', customerId: 'cust', status: 'active', createdAtIso: now, updatedAtIso: now }], sessions: [{ id: 'session', token: 'token', userId: 'user', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3_600_000).toISOString() }], personalAccessTokens: [], customers: [{ id: 'cust', name: 'A', zernioProfileId: 'profile', zernioProfileIds: ['profile'], entitlement: entitlement(expiresAtIso) }], sandboxes: [], agents: [], servicePackages: [], connectedAccounts: [{ id: 'account', customerId: 'cust', platform: 'facebook', zernioAccountId: 'provider', zernioProfileId: 'profile', status: 'connected' }], socialPosts: [], inboxConversations: [{ id: 'conversation', customerId: 'cust', accountId: 'account', platform: 'facebook', providerConversationId: 'conversation', status: 'open', lastMessageAtIso: now, unreadCount: 0, createdAtIso: now, updatedAtIso: now }], inboxMessages: [], inboxDraftReplies: [{ id: 'draft', customerId: 'cust', conversationId: 'conversation', text: 'reply', status: 'pending_review', sendAttempted: false, createdByUserId: 'user', createdAtIso: now }], jobs: [], webhookEvents: [], webhookFailures: [], webhookStatus: { enabled: true, consecutiveFailures: 0 }, auditLogs: [], billingPayments: [], checkoutIntents: [], apiRateLimitBuckets: [] }; }

test('expired or malformed entitlement denies every paid mutation before durable state changes', async () => {
  for (const expiry of ['2020-01-01T00:00:00.000Z', 'malformed']) await withApi(state(expiry), async (baseUrl, dbPath) => {
    const headers = { authorization: 'Bearer token', 'content-type': 'application/json', 'idempotency-key': 'post' };
    const responses = await Promise.all([
      fetch(`${baseUrl}/customers/cust/posts/drafts`, { method: 'POST', headers, body: JSON.stringify({ accountId: 'account', content: 'nope' }) }),
      fetch(`${baseUrl}/customers/cust/connect/instagram`, { headers: { authorization: 'Bearer token' } }),
      fetch(`${baseUrl}/customers/cust/inbox/conversations/conversation/drafts`, { method: 'POST', headers, body: JSON.stringify({ text: 'nope' }) }),
      fetch(`${baseUrl}/customers/cust/inbox/drafts/draft/approve`, { method: 'POST', headers: { authorization: 'Bearer token' } }),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [403, 403, 403, 403]);
    assert.deepEqual(await Promise.all(responses.map((response) => response.json())).then((rows) => rows.map((row) => (row as { error: string }).error)), Array(4).fill(expiry === 'malformed' ? 'entitlement_unavailable' : 'entitlement_expired'));
    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { socialPosts: unknown[]; jobs: unknown[]; inboxDraftReplies: Array<{ status: string }>; connectedAccounts: Array<{ status: string }> };
    assert.equal(persisted.socialPosts.length, 0); assert.equal(persisted.jobs.length, 0); assert.equal(persisted.inboxDraftReplies.length, 1); assert.equal(persisted.inboxDraftReplies[0]?.status, 'pending_review'); assert.equal(persisted.connectedAccounts[0]?.status, 'connected');
  });
});

test('disconnect denies inactive, expired, and malformed entitlements before adapter call or durable mutation', async () => {
  for (const [expiry, expectedError] of [['2020-01-01T00:00:00.000Z', 'entitlement_expired'], ['malformed', 'entitlement_unavailable']] as const) {
    const calls: Array<{ method?: string; url?: string }> = [];
    const provider = createServer((req, res) => { calls.push({ method: req.method, url: req.url }); res.statusCode = 204; res.end(); });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const providerPort = (provider.address() as { port: number }).port;
    try {
      await withApi(state(expiry), async (baseUrl, dbPath) => {
        const response = await fetch(`${baseUrl}/customers/cust/connections/account`, { method: 'DELETE', headers: { authorization: 'Bearer token' } });
        assert.equal(response.status, 403);
        assert.equal((await response.json() as { error: string }).error, expectedError);
        const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { connectedAccounts: Array<{ status: string }> };
        assert.equal(persisted.connectedAccounts[0]?.status, 'connected');
      }, { ZERNIO_MODE: 'live', ZERNIO_API_KEY: 'test-only-key', ZERNIO_BASE_URL: `http://127.0.0.1:${providerPort}` });
      assert.deepEqual(calls, []);
    } finally { await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve())); }
  }
  const calls: Array<{ method?: string; url?: string }> = [];
  const provider = createServer((req, res) => { calls.push({ method: req.method, url: req.url }); res.statusCode = 204; res.end(); });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = (provider.address() as { port: number }).port;
  const inactive = state(new Date(Date.now() + 3_600_000).toISOString()) as { customers: Array<{ entitlement: ReturnType<typeof entitlement> }> };
  inactive.customers[0]!.entitlement.basePlan.status = 'inactive';
  try {
    await withApi(inactive, async (baseUrl, dbPath) => {
      const response = await fetch(`${baseUrl}/customers/cust/connections/account`, { method: 'DELETE', headers: { authorization: 'Bearer token' } });
      assert.equal(response.status, 403);
      assert.equal((await response.json() as { error: string }).error, 'entitlement_inactive');
      const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { connectedAccounts: Array<{ status: string }> };
      assert.equal(persisted.connectedAccounts[0]?.status, 'connected');
    }, { ZERNIO_MODE: 'live', ZERNIO_API_KEY: 'test-only-key', ZERNIO_BASE_URL: `http://127.0.0.1:${providerPort}` });
    assert.deepEqual(calls, []);
  } finally { await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve())); }
});

test('past_due grace permits disconnect and retains existing provider behavior', async () => {
  const calls: Array<{ method?: string; url?: string }> = [];
  const provider = createServer((req, res) => { calls.push({ method: req.method, url: req.url }); res.statusCode = 204; res.end(); });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = (provider.address() as { port: number }).port;
  try {
    await withApi(state(new Date(Date.now() - 60_000).toISOString()), async (baseUrl, dbPath) => {
      const response = await fetch(`${baseUrl}/customers/cust/connections/account`, { method: 'DELETE', headers: { authorization: 'Bearer token' } });
      assert.equal(response.status, 200);
      const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { connectedAccounts: Array<{ status: string }> };
      assert.equal(persisted.connectedAccounts[0]?.status, 'disconnected');
    }, { ZERNIO_MODE: 'live', ZERNIO_API_KEY: 'test-only-key', ZERNIO_BASE_URL: `http://127.0.0.1:${providerPort}` });
    assert.deepEqual(calls, [{ method: 'DELETE', url: '/accounts/provider' }]);
  } finally { await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve())); }
});

test('past_due grace permits a paid post while a disconnected provider remains a provider-specific error', async () => {
  const fixture = state(new Date(Date.now() - 60_000).toISOString()) as { connectedAccounts: Array<{ status: string }> };
  await withApi(fixture, async (baseUrl) => {
    const post = await fetch(`${baseUrl}/customers/cust/posts/drafts`, { method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json', 'idempotency-key': 'grace' }, body: JSON.stringify({ accountId: 'account', content: 'allowed' }) });
    assert.equal(post.status, 201);
    fixture.connectedAccounts[0]!.status = 'disconnected';
  });
  const disconnectedFixture = state(new Date(Date.now() - 60_000).toISOString()) as { connectedAccounts: Array<{ status: string }> };
  disconnectedFixture.connectedAccounts[0]!.status = 'disconnected';
  await withApi(disconnectedFixture, async (baseUrl) => {
    const disconnected = await fetch(`${baseUrl}/customers/cust/posts/drafts`, { method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json', 'idempotency-key': 'provider' }, body: JSON.stringify({ accountId: 'account', content: 'provider failure' }) });
    assert.equal(disconnected.status, 409);
    assert.equal((await disconnected.json() as { error: string }).error, 'connected_account_inactive');
  });
});
