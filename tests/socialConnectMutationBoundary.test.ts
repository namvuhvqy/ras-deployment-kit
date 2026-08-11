import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();
const supportedPlatforms = ['facebook', 'instagram', 'youtube', 'twitter', 'linkedin', 'tiktok', 'threads', 'bluesky'];

async function withApi<T>(state: Record<string, unknown>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ras-social-connect-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 20_100 + Math.floor(Math.random() * 1000);
  await writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`);
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), RAS_DB_PATH: dbPath, RAS_INTERNAL_API_TOKEN: 'test-internal-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('ras-api listening')) { clearTimeout(timer); resolve(); } });
      child.on('error', reject);
    });
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

function connectState() {
  return {
    schemaVersion: 1, migratedAtIso: now, sandboxes: [], agents: [], servicePackages: [], jobs: [], webhookEvents: [], auditLogs: [],
    users: [{ id: 'user_a', email: 'a@example.test', role: 'owner', customerId: 'cust_a', status: 'active', createdAtIso: now, updatedAtIso: now }],
    sessions: [{ id: 'session_a', token: 'token_a', userId: 'user_a', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() }],
    customers: [{ id: 'cust_a', name: 'A Shop', email: 'a@example.test', status: 'active', createdAtIso: now, updatedAtIso: now, maxConnectedAccounts: 3, activeConnectedAccounts: 0, packageStatus: 'active', addOnStatus: { zernio: 'active' } }],
    connectedAccounts: [],
  };
}

test('GET common social connect is read-only and cannot create a Zernio profile', async () => {
  const state = connectState();
  await withApi(state, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/customers/cust_a/connect/instagram`, { headers: { authorization: 'Bearer token_a' } });
    assert.equal(response.status, 405);
    const mappingResponse = await fetch(`${baseUrl}/customers/cust_a/mapping`, { headers: { authorization: 'Bearer token_a' } });
    assert.equal(mappingResponse.status, 200);
    const payload = await mappingResponse.json() as { mapping?: { customer?: { zernioProfileId?: string; zernioProfileIds?: string[] } } };
    assert.equal(payload.mapping?.customer?.zernioProfileId, undefined);
    assert.deepEqual(payload.mapping?.customer?.zernioProfileIds ?? [], []);
  });
});

test('POST common connect requires customer authz, validates every supported platform, and provisions retry-safely', async () => {
  const state = connectState();
  await withApi(state, async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/customers/cust_a/connect/instagram`, { method: 'POST' });
    assert.equal(unauthenticated.status, 401);
    const crossTenant = await fetch(`${baseUrl}/customers/cust_b/connect/instagram`, { method: 'POST', headers: { authorization: 'Bearer token_a' } });
    assert.equal(crossTenant.status, 403);

    for (const platform of supportedPlatforms) {
      const response = await fetch(`${baseUrl}/customers/cust_a/connect/${platform}?redirectUrl=https://preview.example.test/connect/callback`, { method: 'POST', headers: { authorization: 'Bearer token_a' } });
      assert.equal(response.status, 200, platform);
      const payload = await response.json() as { profileId?: string; authUrl?: string };
      assert.ok(payload.profileId, platform);
      assert.match(payload.authUrl ?? '', new RegExp(`/connect/${platform}`));
    }

    const retry = await fetch(`${baseUrl}/customers/cust_a/connect/instagram?redirectUrl=https://preview.example.test/connect/callback`, { method: 'POST', headers: { authorization: 'Bearer token_a' } });
    assert.equal(retry.status, 200);
    const after = await fetch(`${baseUrl}/customers/cust_a/mapping`, { headers: { authorization: 'Bearer token_a' } });
    const mappingPayload = await after.json() as { mapping?: { customer?: { zernioProfileIds?: string[] } } };
    assert.equal(mappingPayload.mapping?.customer?.zernioProfileIds?.length, 1, 'retries must reuse the durable customer profile');
  });
});
