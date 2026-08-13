import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();

async function withServer(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void | Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function withApi<T>(state: Record<string, unknown>, env: Record<string, string>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ras-connection-refresh-cache-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 21_100 + Math.floor(Math.random() * 1_000);
  await writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`);
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, PORT: String(port), RAS_DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 5_000);
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

function state(): Record<string, unknown> {
  return {
    schemaVersion: 1, migratedAtIso: now, sandboxes: [], agents: [], servicePackages: [], jobs: [], webhookEvents: [], auditLogs: [],
    users: [{ id: 'user_1', email: 'one@example.test', role: 'owner', customerId: 'cust_1', status: 'active', createdAtIso: now, updatedAtIso: now }],
    sessions: [{ id: 'session_1', token: 'token_1', userId: 'user_1', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3_600_000).toISOString() }],
    customers: [{ id: 'cust_1', name: 'Customer', zernioProfileId: 'profile_1', status: 'active', createdAtIso: now, updatedAtIso: now }],
    connectedAccounts: [],
  };
}

test('connection summary caches a successful provider account refresh per customer/profile and reports it', async () => {
  let accountListCalls = 0;
  const provider = await withServer((request, response) => {
    if (request.url === '/accounts?profileId=profile_1') {
      accountListCalls += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{ id: 'z_account_1', platform: 'facebook', status: 'connected' }]));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  try {
    await withApi(state(), { ZERNIO_MODE: 'live', ZERNIO_API_KEY: 'test-key', ZERNIO_BASE_URL: provider.baseUrl }, async (baseUrl) => {
      const first = await fetch(`${baseUrl}/customers/cust_1/connection-summary`, { headers: { authorization: 'Bearer token_1' } });
      assert.equal(first.status, 200);
      assert.deepEqual((await first.json() as { sync: unknown }).sync, { refreshed: true, cached: false, accountCount: 1 });

      const second = await fetch(`${baseUrl}/customers/cust_1/connection-summary`, { headers: { authorization: 'Bearer token_1' } });
      assert.equal(second.status, 200);
      assert.deepEqual((await second.json() as { sync: unknown }).sync, { refreshed: false, cached: true, accountCount: 1 });
      assert.equal(accountListCalls, 1);
    });
  } finally {
    await provider.close();
  }
});

test('connection summary does not cache failed provider account refreshes', async () => {
  let accountListCalls = 0;
  const provider = await withServer((request, response) => {
    if (request.url === '/accounts?profileId=profile_1') {
      accountListCalls += 1;
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'unavailable' }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  try {
    await withApi(state(), { ZERNIO_MODE: 'live', ZERNIO_API_KEY: 'test-key', ZERNIO_BASE_URL: provider.baseUrl }, async (baseUrl) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${baseUrl}/customers/cust_1/connection-summary`, { headers: { authorization: 'Bearer token_1' } });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json() as { sync: unknown }).sync, { refreshed: false, cached: false, reason: 'zernio_sync_failed_503' });
      }
      assert.equal(accountListCalls, 2);
    });
  } finally {
    await provider.close();
  }
});
