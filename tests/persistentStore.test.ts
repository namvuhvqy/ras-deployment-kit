import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRasStore } from '../packages/shared/src/persistentStore.js';

test('JsonRasStore migrates an empty store with current schema metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-'));
  try {
    const path = join(dir, 'ras-store.json');
    const store = new JsonRasStore(path);
    const result = await store.migrate();
    const state = JSON.parse(await readFile(path, 'utf8'));

    assert.equal(result.created, true);
    assert.equal(result.previousVersion, 1);
    assert.equal(result.currentVersion, 1);
    assert.match(result.sql, /CREATE TABLE IF NOT EXISTS customers/);
    assert.deepEqual(state.customers, []);
    assert.deepEqual(state.jobs, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JsonRasStore persists customer, account, queue, webhook idempotency, and audit log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();

    await store.upsertCustomer({
      id: 'cust_1',
      name: 'Shop Demo',
      email: 'demo@runagentsys.com',
      zernioProfileId: 'profile_1',
      status: 'active',
    });
    await store.upsertConnectedAccount({
      id: 'acct_1',
      customerId: 'cust_1',
      zernioAccountId: 'zacct_1',
      profileId: 'profile_1',
      platform: 'facebook',
      username: 'shop-demo',
      status: 'connected',
      capabilities: ['publish'],
    });
    await store.enqueueJob({
      id: 'job_1',
      customerId: 'cust_1',
      profileId: 'profile_1',
      accountId: 'zacct_1',
      platform: 'facebook',
      type: 'publish_post',
      priority: 'P1',
      payload: { content: 'hello' },
      status: 'queued',
      retryCount: 0,
      createdAtIso: new Date().toISOString(),
    });
    await store.appendAuditLog({
      id: 'audit_1',
      customerId: 'cust_1',
      action: 'customer.created',
      targetType: 'customer',
      targetId: 'cust_1',
      metadata: { source: 'test' },
      createdAtIso: new Date().toISOString(),
    });

    const firstWebhook = await store.recordWebhookEvent({
      id: 'event_1',
      source: 'zernio',
      profileId: 'profile_1',
      accountId: 'zacct_1',
      eventType: 'message.created',
      payload: { message: 'hi' },
      createdAtIso: new Date().toISOString(),
    });
    const duplicateWebhook = await store.recordWebhookEvent({
      id: 'event_1',
      source: 'zernio',
      eventType: 'message.created',
      payload: { message: 'duplicate' },
      createdAtIso: new Date().toISOString(),
    });

    const state = await store.load();
    const queued = await store.getQueuedJobs();
    assert.equal(state.customers.length, 1);
    assert.equal(state.connectedAccounts.length, 1);
    assert.equal(state.socialPosts.length, 1);
    assert.equal(state.socialPosts[0]?.id, 'job_1');
    assert.equal(state.socialPosts[0]?.jobId, 'job_1');
    assert.equal(state.socialPosts[0]?.platform, 'facebook');
    assert.equal(state.socialPosts[0]?.status, 'queued');
    assert.equal(queued.length, 1);
    assert.equal(state.auditLogs.length, 1);
    assert.equal(firstWebhook.inserted, true);
    assert.equal(duplicateWebhook.inserted, false);
    assert.equal(state.webhookEvents.length, 1);
    assert.equal(state.webhookEvents[0].payload.message, 'hi');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JsonRasStore persists PayPal capture before provisioning and keeps pending retry state on provision failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();

    const captured = await store.recordBillingPaymentCapture({
      provider: 'paypal',
      customerId: 'cust_paid',
      paypalOrderId: 'ORDER-123',
      transactionId: 'CAPTURE-123',
      status: 'captured',
      amount: '39',
      currency: 'USD',
      plan: 'pro',
      billingCycle: 'monthly',
      extraConnectSlots: 0,
      rawCapture: { status: 'COMPLETED' },
      createdAtIso: '2026-07-26T00:00:00.000Z',
      updatedAtIso: '2026-07-26T00:00:00.000Z',
    });

    assert.equal(captured.status, 'captured');
    assert.equal(captured.provisionStatus, 'pending');

    const failed = await store.markBillingPaymentProvisionFailed('paypal:ORDER-123', 'Customer not found', '2026-07-26T00:01:00.000Z');

    assert.equal(failed?.status, 'captured');
    assert.equal(failed?.provisionStatus, 'pending_retry');
    assert.equal(failed?.retryCount, 1);
    assert.equal(failed?.lastError, 'Customer not found');

    const state = await store.load();
    assert.equal(state.billingPayments.length, 1);
    assert.equal(state.billingPayments[0].transactionId, 'CAPTURE-123');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JsonRasStore summarizes sandbox and required RAS agent lifecycle blockers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.upsertCustomer({
      id: 'cust_1',
      name: 'Shop Demo',
      status: 'active',
      sandboxId: 'sandbox_1',
      createdAtIso: new Date().toISOString(),
    });
    await store.upsertSandbox({
      id: 'sandbox_1',
      customerId: 'cust_1',
      provider: 'vps',
      status: 'running',
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    });
    await store.upsertAgent({
      id: 'agent_1',
      customerId: 'cust_1',
      sandboxId: 'sandbox_1',
      kind: 'ras1-hermes',
      status: 'running',
      updatedAtIso: new Date().toISOString(),
    });

    const lifecycle = await store.getCustomerLifecycleStatus('cust_1');
    assert.equal(lifecycle?.healthy, false);
    assert.deepEqual(lifecycle?.blockers, ['missing_ras2-openclaw']);

    await store.upsertAgent({
      id: 'agent_2',
      customerId: 'cust_1',
      sandboxId: 'sandbox_1',
      kind: 'ras2-openclaw',
      status: 'running',
      updatedAtIso: new Date().toISOString(),
    });

    const healthyLifecycle = await store.getCustomerLifecycleStatus('cust_1');
    assert.equal(healthyLifecycle?.healthy, true);
    assert.deepEqual(healthyLifecycle?.blockers, []);
    assert.equal(await store.getCustomerLifecycleStatus('missing'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
