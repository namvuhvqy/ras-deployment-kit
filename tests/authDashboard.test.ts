import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRasStore } from '../packages/shared/src/persistentStore.js';

const now = new Date(0).toISOString();

test('dashboard requires a valid session token and returns tenant control panel data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-auth-dashboard-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();

    await store.upsertUser({
      id: 'user_1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
      customerId: 'cust_1',
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    });
    await store.upsertCustomer({ id: 'cust_1', name: 'Shop Demo', status: 'active', createdAtIso: now });
    await store.upsertSandbox({
      id: 'sandbox_1',
      customerId: 'cust_1',
      provider: 'vps',
      status: 'running',
      endpoint: 'https://tenant.example.test',
      createdAtIso: now,
      updatedAtIso: now,
    });
    await store.upsertAgent({
      id: 'agent_1',
      customerId: 'cust_1',
      sandboxId: 'sandbox_1',
      kind: 'ras1-hermes',
      status: 'running',
      updatedAtIso: now,
    });

    const session = await store.createSession({ userId: 'user_1', ttlMs: 60_000, nowIso: now });
    assert.equal(await store.getDashboardForSession('missing'), undefined);

    const dashboard = await store.getDashboardForSession(session.token, now);
    assert.equal(dashboard?.user.email, 'owner@example.com');
    assert.equal(dashboard?.customer.id, 'cust_1');
    assert.equal(dashboard?.sandboxes[0].status, 'running');
    assert.equal(dashboard?.agents[0].kind, 'ras1-hermes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('login creates session only for active configured users', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-login-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();

    await store.upsertUser({
      id: 'user_1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
      customerId: 'cust_1',
      status: 'active',
      password: 'secret',
      createdAtIso: now,
      updatedAtIso: now,
    });

    assert.equal(await store.login({ email: 'owner@example.com', password: 'wrong', nowIso: now }), undefined);
    const session = await store.login({ email: 'owner@example.com', password: 'secret', nowIso: now });
    assert.ok(session?.token.startsWith('sess_'));
    assert.equal(session?.userId, 'user_1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
