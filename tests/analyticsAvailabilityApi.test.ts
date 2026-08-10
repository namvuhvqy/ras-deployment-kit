import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();

async function withApi<T>(state: Record<string, unknown>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ras-analytics-availability-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 22_000 + Math.floor(Math.random() * 1000);
  await writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`);
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), RAS_DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('ras-api listening')) { clearTimeout(timer); resolve(); }
      });
      child.on('error', reject);
    });
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

function state() {
  return {
    schemaVersion: 1, migratedAtIso: now,
    users: [
      { id: 'user_a', email: 'a@example.test', role: 'owner', customerId: 'cust_a', status: 'active', createdAtIso: now, updatedAtIso: now },
      { id: 'user_b', email: 'b@example.test', role: 'owner', customerId: 'cust_b', status: 'active', createdAtIso: now, updatedAtIso: now },
    ],
    sessions: [
      { id: 'sess_a', token: 'token_a', userId: 'user_a', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
      { id: 'sess_b', token: 'token_b', userId: 'user_b', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
    ],
    customers: [
      { id: 'cust_a', name: 'A', status: 'active', zernioProfileIds: ['profile_a'], packageStatus: 'active', addOnStatus: { analytics: 'active' } },
      { id: 'cust_b', name: 'B', status: 'active', zernioProfileIds: ['profile_b'], packageStatus: 'active', addOnStatus: { analytics: 'active' } },
    ],
    connectedAccounts: [
      { id: 'acct_a', customerId: 'cust_a', platform: 'facebook', zernioAccountId: 'provider_a', zernioProfileId: 'profile_a', status: 'connected', lastVerifiedAtIso: now },
      { id: 'acct_b', customerId: 'cust_b', platform: 'facebook', zernioAccountId: 'provider_b', zernioProfileId: 'profile_b', status: 'connected', lastVerifiedAtIso: now },
    ],
    sandboxes: [], agents: [], servicePackages: [], orders: [], profileSlots: [], socialPosts: [], inboxConversations: [], inboxMessages: [], inboxDraftReplies: [], jobs: [], webhookEvents: [], webhookFailures: [], webhookStatus: { enabled: true, consecutiveFailures: 0 }, auditLogs: [], billingPayments: [], checkoutIntents: [], googleOAuthStates: [], personalAccessTokens: [], apiRateLimitBuckets: [],
  };
}

test('analytics availability is read-only, tenant-scoped, and returns only verified permitted account references', async () => {
  await withApi(state(), async (baseUrl) => {
    const own = await fetch(`${baseUrl}/customers/cust_a/analytics/availability`, { headers: { authorization: 'Bearer token_a' } });
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { ok: true, availability: { feature: 'analytics', mode: 'read_only', permittedAccounts: [{ id: 'acct_a', platform: 'facebook' }] } });

    const crossTenant = await fetch(`${baseUrl}/customers/cust_a/analytics/availability`, { headers: { authorization: 'Bearer token_b' } });
    assert.equal(crossTenant.status, 403);
    const write = await fetch(`${baseUrl}/customers/cust_a/analytics/availability`, { method: 'POST', headers: { authorization: 'Bearer token_a' } });
    assert.equal(write.status, 405);
  });
});

test('analytics fails closed when entitlement, verified account, or permitted profile mapping is absent', async () => {
  const scenarios: Array<{ mutate: (value: ReturnType<typeof state>) => void; reason: string }> = [
    { reason: 'analytics_entitlement_inactive', mutate: (value) => { value.customers[0].addOnStatus.analytics = 'inactive'; } },
    { reason: 'verified_account_required', mutate: (value) => { (value.connectedAccounts[0] as { lastVerifiedAtIso?: string }).lastVerifiedAtIso = undefined; } },
    { reason: 'permitted_profile_mapping_required', mutate: (value) => { value.connectedAccounts[0].zernioProfileId = 'profile_unmapped'; } },
  ];
  for (const scenario of scenarios) {
    const fixture = state(); scenario.mutate(fixture);
    await withApi(fixture, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/customers/cust_a/analytics/availability`, { headers: { authorization: 'Bearer token_a' } });
      assert.equal(response.status, 501);
      assert.deepEqual(await response.json(), { ok: false, error: 'analytics_not_available', reason: scenario.reason });
    });
  }
});
