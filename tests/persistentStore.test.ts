import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { JsonRasStore } from '../packages/shared/src/persistentStore.js';
import { addPeriod, evaluateSubscriptionLifecycle } from '../packages/shared/src/subscriptionPolicy.js';

test('subscription lifecycle policy derives dates solely from supplied server dates', () => {
  const expiry = '2026-08-20T00:00:00.000Z';

  assert.equal(evaluateSubscriptionLifecycle(expiry, '2026-08-12T00:00:00.000Z').state, 'active');
  assert.equal(evaluateSubscriptionLifecycle(expiry, '2026-08-13T00:00:00.000Z').state, 'expiring_soon');
  assert.equal(evaluateSubscriptionLifecycle(expiry, expiry).state, 'past_due');
  assert.equal(evaluateSubscriptionLifecycle(expiry, '2026-08-27T00:00:00.000Z').state, 'expired');
  assert.equal(evaluateSubscriptionLifecycle('not-a-date', '2026-08-20T00:00:00.000Z').state, 'unknown');
  assert.equal(evaluateSubscriptionLifecycle(undefined, '2026-08-20T00:00:00.000Z').state, 'unknown');
  assert.deepEqual(
    evaluateSubscriptionLifecycle(expiry, '2026-08-13T00:00:00.000Z'),
    evaluateSubscriptionLifecycle(expiry, '2026-08-13T00:00:00.000Z'),
  );
});

test('subscription lifecycle policy rejects normalized-invalid ISO calendar dates', () => {
  const invalidIso = '2026-02-30T00:00:00.000Z';

  assert.equal(evaluateSubscriptionLifecycle(invalidIso, '2026-02-20T00:00:00.000Z').state, 'unknown');
  assert.equal(addPeriod(invalidIso, 'monthly'), undefined);
  assert.equal(evaluateSubscriptionLifecycle('2026-02-28T01:00:00.000+01:00', '2026-02-28T00:00:00.000Z').state, 'past_due');
});

test('subscription calendar periods clamp monthly and yearly boundary dates', () => {
  assert.equal(addPeriod('2024-01-31T12:00:00.000Z', 'monthly'), '2024-02-29T12:00:00.000Z');
  assert.equal(addPeriod('2023-01-31T12:00:00.000Z', 'monthly'), '2023-02-28T12:00:00.000Z');
  assert.equal(addPeriod('2024-02-29T12:00:00.000Z', 'yearly'), '2025-02-28T12:00:00.000Z');
});

test('JsonRasStore evaluates base-plan expiry without changing provider health', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-subscription-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.upsertCustomer({
      id: 'cust_subscription', name: 'Subscription customer', status: 'active',
      entitlement: {
        basePlan: { planId: 'pro', status: 'active', billingCycle: 'monthly', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, expiresAtIso: '2026-08-20T00:00:00.000Z' },
        connectSlots: { status: 'active', includedSlots: 1, purchasedSlots: 0, trialSlots: 0, totalSlots: 1, activeConnectedAccounts: 1 }, addOns: [],
      },
    });
    await store.upsertConnectedAccount({ id: 'acct_subscription', customerId: 'cust_subscription', zernioAccountId: 'zacct_subscription', platform: 'facebook', status: 'connected' });

    assert.equal((await store.getSubscriptionLifecycle('cust_subscription', '2026-08-20T00:00:00.000Z'))?.state, 'past_due');
    assert.equal((await store.load()).connectedAccounts[0]?.status, 'connected');
    assert.equal((await store.getSubscriptionLifecycle('missing', '2026-08-20T00:00:00.000Z')), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('JsonRasStore sweeps lifecycle reminders and transitions once without changing provider records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-subscription-sweep-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    const expiry = '2026-08-20T00:00:00.000Z';
    await store.upsertCustomer({
      id: 'cust_sweep', name: 'Sweep customer', status: 'active', packageStatus: 'active', addOnStatus: { zernio: 'active' },
      entitlement: {
        basePlan: { planId: 'pro', status: 'active', billingCycle: 'monthly', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, aiTokens: { monthlyLimit: 100, used: 25 }, expiresAtIso: expiry },
        connectSlots: { status: 'active', includedSlots: 1, purchasedSlots: 2, trialSlots: 0, totalSlots: 3, activeConnectedAccounts: 1 },
        addOns: [{ id: 'zernio-connect', name: 'Zernio Connect Slots', status: 'active', slots: 3 }],
      },
    });
    await store.upsertConnectedAccount({ id: 'acct_sweep', customerId: 'cust_sweep', zernioAccountId: 'zacct_sweep', platform: 'facebook', status: 'connected' });
    const before = await store.load();

    assert.deepEqual((await store.sweepSubscriptionLifecycle('2026-08-13T00:00:00.000Z')).map((event) => event.lifecycleState), ['expiring_soon']);
    assert.deepEqual(await store.sweepSubscriptionLifecycle('2026-08-13T00:00:00.000Z'), []);
    assert.deepEqual((await store.sweepSubscriptionLifecycle(expiry)).map((event) => event.lifecycleState), ['past_due']);
    assert.deepEqual(await store.sweepSubscriptionLifecycle(expiry), []);
    assert.deepEqual((await store.sweepSubscriptionLifecycle('2026-08-27T00:00:00.000Z')).map((event) => event.lifecycleState), ['expired']);
    assert.deepEqual(await store.sweepSubscriptionLifecycle('2026-08-28T00:00:00.000Z'), []);

    const after = await store.load();
    assert.deepEqual(after.subscriptionLifecycleEvents.map((event) => [event.kind, event.lifecycleState, event.expiresAtIso]), [
      ['reminder', 'expiring_soon', expiry], ['transition', 'past_due', expiry], ['transition', 'expired', expiry],
    ]);
    assert.deepEqual(after.auditLogs.map((log) => [log.action, log.targetType, log.targetId]), [
      ['subscription.lifecycle.reminder', 'subscription', 'cust_sweep'],
      ['subscription.lifecycle.transition', 'subscription', 'cust_sweep'],
      ['subscription.lifecycle.transition', 'subscription', 'cust_sweep'],
    ]);
    assert.equal(after.customers[0]?.entitlement?.basePlan.status, 'expired');
    assert.equal(after.customers[0]?.entitlement?.connectSlots.status, 'inactive');
    assert.equal(after.customers[0]?.entitlement?.addOns[0]?.status, 'inactive');
    assert.equal(after.customers[0]?.packageStatus, 'expired');
    assert.equal(after.customers[0]?.addOnStatus?.zernio, 'inactive');
    assert.deepEqual(after.connectedAccounts, before.connectedAccounts);
    assert.deepEqual(after.sandboxes, before.sandboxes);
    assert.deepEqual(after.agents, before.agents);
    assert.deepEqual(after.billingPayments, before.billingPayments);
    assert.deepEqual(after.customers[0]?.entitlement?.basePlan.aiTokens, before.customers[0]?.entitlement?.basePlan.aiTokens);
    assert.equal(after.customers[0]?.entitlement?.connectSlots.totalSlots, before.customers[0]?.entitlement?.connectSlots.totalSlots);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('JsonRasStore sweep skips customers with missing or invalid base-plan expiry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-subscription-invalid-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    for (const [id, expiresAtIso] of [['missing', undefined], ['invalid', '2026-02-30T00:00:00.000Z']] as const) {
      await store.upsertCustomer({ id, name: id, packageStatus: 'active', entitlement: { basePlan: { planId: 'lite', status: 'active', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, expiresAtIso }, connectSlots: { status: 'active', includedSlots: 1, purchasedSlots: 0, trialSlots: 0, totalSlots: 1, activeConnectedAccounts: 0 }, addOns: [] } });
    }
    assert.deepEqual(await store.sweepSubscriptionLifecycle('2026-08-27T00:00:00.000Z'), []);
    const state = await store.load();
    assert.deepEqual(state.subscriptionLifecycleEvents, []);
    assert.deepEqual(state.auditLogs, []);
    assert.equal(state.customers[0]?.packageStatus, 'active');
    assert.equal(state.customers[1]?.packageStatus, 'active');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('JsonRasStore serializes concurrent lifecycle sweeps to one durable transition', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-subscription-concurrent-'));
  try {
    const path = join(dir, 'ras-store.json');
    const first = new JsonRasStore(path); const second = new JsonRasStore(path);
    await first.migrate();
    await first.upsertCustomer({ id: 'cust_concurrent', name: 'Concurrent', entitlement: { basePlan: { planId: 'lite', status: 'active', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, expiresAtIso: '2026-08-20T00:00:00.000Z' }, connectSlots: { status: 'active', includedSlots: 0, purchasedSlots: 0, trialSlots: 0, totalSlots: 0, activeConnectedAccounts: 0 }, addOns: [] } });
    const results = await Promise.all([first.sweepSubscriptionLifecycle('2026-08-20T00:00:00.000Z'), second.sweepSubscriptionLifecycle('2026-08-20T00:00:00.000Z')]);
    const state = await first.load();
    assert.equal(results.flat().length, 1);
    assert.equal(state.subscriptionLifecycleEvents.length, 1);
    assert.equal(state.auditLogs.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('JsonRasStore migrates an empty store with current schema metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-'));
  try {
    const path = join(dir, 'ras-store.json');
    const store = new JsonRasStore(path);
    const result = await store.migrate();
    const state = JSON.parse(await readFile(path, 'utf8'));

    assert.equal(result.created, true);
    assert.equal(result.previousVersion, 3);
    assert.equal(result.currentVersion, 3);
    assert.match(result.sql, /CREATE TABLE IF NOT EXISTS customers/);
    assert.deepEqual(state.customers, []);
    assert.deepEqual(state.jobs, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two store instances preserve concurrent schedule and audit mutations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-lock-'));
  try {
    const path = join(dir, 'ras-store.json'); const api = new JsonRasStore(path); const worker = new JsonRasStore(path);
    await api.migrate(); const now = new Date().toISOString();
    const post = { id: 'post_1', jobId: 'job_1', customerId: 'cust_1', platform: 'facebook' as const, status: 'scheduled' as const, idempotencyKey: 'same', idempotencyPayloadHash: 'hash', createdAtIso: now, updatedAtIso: now };
    const job = { id: 'job_1', customerId: 'cust_1', profileId: 'profile_1', type: 'publish_post' as const, priority: 'P2' as const, status: 'queued' as const, retryCount: 0, payload: { postId: 'post_1' }, createdAtIso: now };
    await Promise.all([api.createPostAndJobIdempotently({ post, job }), worker.appendAuditLog({ id: 'audit_1', action: 'schedule.observed', targetType: 'post', metadata: {}, createdAtIso: now })]);
    await Promise.all([worker.markJobProcessing('job_1'), api.attachZernioPostId('job_1', 'zernio_1')]);
    await Promise.all([worker.completeJob('job_1', { status: 'scheduled' }), api.updateSocialPostStatus({ postId: 'post_1', status: 'scheduled' })]);
    const state = await api.load();
    assert.equal(state.socialPosts[0]?.zernioPostId, 'zernio_1'); assert.equal(state.jobs[0]?.status, 'completed'); assert.equal(state.auditLogs.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('same key concurrent creates across store instances yield one post and job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-lock-'));
  try {
    const path = join(dir, 'ras-store.json'); const a = new JsonRasStore(path); const b = new JsonRasStore(path); await a.migrate(); const now = new Date().toISOString();
    const make = (suffix: string) => ({ post: { id: `post_${suffix}`, jobId: `job_${suffix}`, customerId: 'cust_1', platform: 'facebook' as const, status: 'scheduled' as const, idempotencyKey: 'same', idempotencyPayloadHash: 'hash', createdAtIso: now, updatedAtIso: now }, job: { id: `job_${suffix}`, customerId: 'cust_1', profileId: 'profile_1', type: 'publish_post' as const, priority: 'P2' as const, status: 'queued' as const, retryCount: 0, payload: {}, createdAtIso: now } });
    const results = await Promise.all([a.createPostAndJobIdempotently(make('a')), b.createPostAndJobIdempotently(make('b'))]); const state = await a.load();
    assert.equal(results.filter((result) => result.created).length, 1); assert.equal(state.socialPosts.length, 1); assert.equal(state.jobs.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const owner of [undefined, '{malformed']) {
  test(`store recovers an aged orphan lock with ${owner === undefined ? 'no' : 'malformed'} owner`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ras-store-orphan-lock-'));
    try {
      const path = join(dir, 'ras-store.json'); const store = new JsonRasStore(path); await store.migrate();
      const lockPath = `${path}.lock`; await mkdir(lockPath);
      if (owner !== undefined) await writeFile(join(lockPath, 'owner.json'), owner);
      const old = new Date(Date.now() - 2_000); await utimes(lockPath, old, old);
      await store.appendAuditLog({ id: 'after_orphan', action: 'recovered', targetType: 'test', metadata: {}, createdAtIso: new Date().toISOString() });
      const state = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(state.auditLogs[0]?.id, 'after_orphan'); assert.equal(state.schemaVersion, 3);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('claim lease reclaims only expired processing jobs and fences an old claimant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-lease-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json')); await store.migrate();
    const stale = { id: 'stale', customerId: 'c', profileId: 'p', type: 'smoke_test' as const, priority: 'P1' as const, status: 'processing' as const, retryCount: 0, payload: {}, createdAtIso: '2020-01-01T00:00:00.000Z', processingStartedAtIso: '2020-01-01T00:00:00.000Z', claimToken: 'old' };
    const active = { ...stale, id: 'active', processingStartedAtIso: '2030-01-01T00:00:00.000Z', claimToken: 'active' };
    await store.enqueueJob(stale); await store.enqueueJob(active);
    const reclaimed = await store.claimQueuedJob('stale', 'new', 60_000, '2026-01-01T00:00:00.000Z');
    assert.equal(reclaimed?.claimToken, 'new');
    assert.equal(await store.claimQueuedJob('active', 'other', 60_000, '2026-01-01T00:00:00.000Z'), undefined);
    assert.equal(await store.completeJob('stale', {}, 'old'), undefined);
    assert.equal(await store.failJob('stale', 'old failure', 'old'), undefined);
    assert.equal((await store.completeJob('stale', { ok: true }, 'new'))?.status, 'completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('independent node processes preserve all concurrent audit mutations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-process-lock-'));
  try {
    const path = join(dir, 'ras-store.json'); await new JsonRasStore(path).migrate();
    const script = `import { JsonRasStore } from './dist/packages/shared/src/persistentStore.js'; const [path,prefix,count] = process.argv.slice(1); const store = new JsonRasStore(path); await Promise.all(Array.from({length:Number(count)},(_,i)=>store.appendAuditLog({id:prefix+i,action:'child',targetType:'test',metadata:{},createdAtIso:new Date().toISOString()})));`;
    const run = (prefix: string) => new Promise<void>((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', script, path, prefix, '20'], { cwd: process.cwd(), stdio: 'inherit' }); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`))); child.once('error', reject); });
    await Promise.all([run('a'), run('b'), run('c')]);
    const state = await new JsonRasStore(path).load();
    assert.equal(state.auditLogs.length, 60); assert.equal(new Set(state.auditLogs.map((row) => row.id)).size, 60);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PAT is stored only as a hash and resolves/revokes as a tenant-bound principal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-pat-store-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    const created = await store.createPersonalAccessToken({ customerId: 'cust_a', createdByUserId: 'user_a', name: 'n8n', scopes: ['accounts:read'] });
    const state = await store.load();
    assert.equal(state.personalAccessTokens.length, 1);
    assert.notEqual(state.personalAccessTokens[0].tokenHash, created.plaintext);
    assert.equal((await store.resolvePrincipal(created.plaintext))?.customerId, 'cust_a');
    assert.deepEqual((await store.resolvePrincipal(created.plaintext))?.scopes, ['accounts:read']);
    assert.equal(await store.revokePersonalAccessToken({ customerId: 'cust_a', tokenId: created.token.id }), true);
    assert.equal(await store.resolvePrincipal(created.plaintext), undefined);
    assert.equal('tokenHash' in (await store.listPersonalAccessTokens('cust_a'))[0], false);
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

test('JsonRasStore persists inbound inbox messages once and isolates conversations by tenant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.upsertCustomer({ id: 'cust_a', name: 'Shop A', zernioProfileId: 'profile_a', status: 'active' });
    await store.upsertCustomer({ id: 'cust_b', name: 'Shop B', zernioProfileId: 'profile_b', status: 'active' });

    const first = await store.recordInboxMessage({
      id: 'msg_1', customerId: 'cust_a', accountId: 'acct_a', platform: 'facebook', conversationId: 'conv_shared',
      direction: 'inbound', text: 'Xin chào', providerMessageId: 'provider_msg_1', receivedAtIso: '2026-07-30T00:00:00.000Z',
    });
    const duplicate = await store.recordInboxMessage({
      id: 'msg_duplicated', customerId: 'cust_a', accountId: 'acct_a', platform: 'facebook', conversationId: 'conv_shared',
      direction: 'inbound', text: 'Xin chào duplicate', providerMessageId: 'provider_msg_1', receivedAtIso: '2026-07-30T00:00:01.000Z',
    });
    await store.recordInboxMessage({
      id: 'msg_2', customerId: 'cust_b', accountId: 'acct_b', platform: 'facebook', conversationId: 'conv_shared',
      direction: 'inbound', text: 'Khách B', providerMessageId: 'provider_msg_2', receivedAtIso: '2026-07-30T00:00:02.000Z',
    });

    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal((await store.listInboxConversations('cust_a')).length, 1);
    assert.equal((await store.listInboxMessages('cust_a', 'conv_shared')).length, 1);
    assert.equal((await store.listInboxMessages('cust_b', 'conv_shared')).length, 1);
    assert.equal((await store.listInboxMessages('cust_a', 'conv_shared'))[0]?.text, 'Xin chào');
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

test('JsonRasStore dedupes a payment provisioning outbox job by payment id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    const job = { id: 'provision_payment_paypal:ORDER-1', customerId: 'cust_1', profileId: '', type: 'provision_entitlement' as const, priority: 'P0' as const, status: 'queued' as const, payload: { paymentId: 'paypal:ORDER-1' }, retryCount: 0, createdAtIso: '2026-08-02T00:00:00.000Z' };
    assert.equal((await store.enqueueJobIfAbsent(job)).inserted, true);
    assert.equal((await store.enqueueJobIfAbsent(job)).inserted, false);
    assert.equal((await store.load()).jobs.length, 1);
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


test('JsonRasStore checkout intents bind one PayPal order and consume exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-store-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    const intent = await store.createCheckoutIntent({ customerId: 'cust_a', plan: 'lite', billingCycle: 'monthly', extraConnectSlots: 1, amount: '25', currency: 'USD', expiresAtIso: '2030-01-01T00:00:00.000Z' });
    assert.equal((await store.bindCheckoutIntentPaypalOrder({ intentId: intent.id, customerId: 'cust_b', paypalOrderId: 'ORDER-1' })).error, 'identity_mismatch');
    assert.equal((await store.bindCheckoutIntentPaypalOrder({ intentId: intent.id, customerId: 'cust_a', paypalOrderId: 'ORDER-1' })).intent?.status, 'bound');
    assert.equal((await store.bindCheckoutIntentPaypalOrder({ intentId: intent.id, customerId: 'cust_a', paypalOrderId: 'ORDER-2' })).error, 'already_bound');
    assert.equal((await store.consumeCheckoutIntentAfterCapture({ intentId: intent.id, customerId: 'cust_a', paypalOrderId: 'ORDER-1', transactionId: 'CAP-1' })).intent?.status, 'consumed');
    assert.equal((await store.consumeCheckoutIntentAfterCapture({ intentId: intent.id, customerId: 'cust_a', paypalOrderId: 'ORDER-1', transactionId: 'CAP-2' })).error, 'already_consumed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
