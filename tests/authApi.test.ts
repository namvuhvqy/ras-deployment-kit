import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();

test('API login returns a bearer token that unlocks dashboard payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-auth-api-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 18_080 + Math.floor(Math.random() * 1000);
  const state = {
    schemaVersion: 1,
    migratedAtIso: now,
    users: [
      {
        id: 'user_1',
        email: 'owner@example.com',
        displayName: 'Owner',
        role: 'owner',
        customerId: 'cust_1',
        status: 'active',
        password: 'secret',
        createdAtIso: now,
        updatedAtIso: now,
      },
    ],
    sessions: [],
    customers: [{ id: 'cust_1', name: 'Shop Demo', status: 'active', createdAtIso: now }],
    sandboxes: [
      {
        id: 'sandbox_1',
        customerId: 'cust_1',
        provider: 'vps',
        status: 'running',
        endpoint: 'https://tenant.example.test',
        createdAtIso: now,
        updatedAtIso: now,
      },
    ],
    agents: [
      {
        id: 'agent_1',
        customerId: 'cust_1',
        sandboxId: 'sandbox_1',
        kind: 'ras1-hermes',
        status: 'running',
        updatedAtIso: now,
      },
    ],
    servicePackages: [],
    connectedAccounts: [],
    jobs: [],
    webhookEvents: [],
    auditLogs: [],
  };

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
        if (String(chunk).includes('ras-api listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
    });

    const denied = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(denied.status, 401);

    const login = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'secret' }),
    });
    assert.equal(login.status, 200);
    const loginPayload = (await login.json()) as { token: string };
    assert.ok(loginPayload.token.startsWith('sess_'));

    const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { authorization: `Bearer ${loginPayload.token}` },
    });
    assert.equal(dashboard.status, 200);
    const payload = (await dashboard.json()) as { dashboard: { customer: { id: string }; agents: Array<{ kind: string }> } };
    assert.equal(payload.dashboard.customer.id, 'cust_1');
    assert.equal(payload.dashboard.agents[0].kind, 'ras1-hermes');
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
