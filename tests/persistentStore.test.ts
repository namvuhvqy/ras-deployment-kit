import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    assert.equal(result.previousVersion, 2);
    assert.equal(result.currentVersion, 2);
    assert.match(result.sql, /CREATE TABLE IF NOT EXISTS customers/);
    assert.match(result.sql, /CREATE TABLE IF NOT EXISTS checkout_intents/);
    assert.deepEqual(state.customers, []);
    assert.deepEqual(state.jobs, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JsonRasStore upgrades a schema-v1 fixture additively and idempotently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-v1-store-'));
  try {
    const path = join(dir, 'ras-store.json');
    const fixture = {
      schemaVersion: 1, migratedAtIso: '2026-01-01T00:00:00.000Z',
      users: [{ id: 'u1', customerId: 'c1', role: 'owner', status: 'active' }], sessions: [{ id: 's1', userId: 'u1', token: 't1' }],
      customers: [{ id: 'c1', name: 'Legacy' }], billingPayments: [{ id: 'p1', customerId: 'c1', status: 'captured' }],
      jobs: [{ id: 'j1', customerId: 'c1', status: 'queued' }],
      servicePackages: [], sandboxes: [], agents: [], connectedAccounts: [], socialPosts: [], inboxConversations: [], inboxMessages: [], inboxDraftReplies: [],
      webhookEvents: [], webhookFailures: [], webhookStatus: { enabled: true, consecutiveFailures: 0 }, auditLogs: [], personalAccessTokens: [], apiRateLimitBuckets: [],
    };
    await (await import('node:fs/promises')).writeFile(path, `${JSON.stringify(fixture)}\n`);
    const store = new JsonRasStore(path);
    const upgraded = await store.migrate();
    const state = await store.load();
    assert.equal(upgraded.previousVersion, 1); assert.equal(upgraded.currentVersion, 2);
    assert.deepEqual(state.users, fixture.users); assert.deepEqual(state.sessions, fixture.sessions); assert.deepEqual(state.customers, fixture.customers);
    assert.deepEqual(state.billingPayments, fixture.billingPayments); assert.deepEqual(state.jobs, fixture.jobs); assert.deepEqual(state.checkoutIntents, []);
    const rerun = await store.migrate(); assert.equal(rerun.previousVersion, 2); assert.equal(rerun.currentVersion, 2);
    assert.deepEqual((await store.load()).checkoutIntents, []);
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

test('JsonRasStore enforces one-open intent, owner-bound bind replay, expiry, and cancel invariants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-checkout-intent-store-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    const nowIso = '2026-08-13T00:00:00.000Z';
    await store.upsertCustomer({ id: 'cust_a', name: 'Checkout Shop', status: 'active', createdAtIso: nowIso, updatedAtIso: nowIso });
    const intent = await store.createCheckoutIntent({ customerId: 'cust_a', plan: 'lite', billingCycle: 'monthly', extraConnectSlots: 1, amount: '25.00', currency: 'USD', expiresAtIso: '2026-08-13T00:30:00.000Z', nowIso });
    assert.equal(intent.status, 'created');
    await assert.rejects(
      () => store.createCheckoutIntent({ customerId: 'cust_a', plan: 'lite', billingCycle: 'monthly', extraConnectSlots: 1, amount: '25.00', currency: 'USD', expiresAtIso: '2026-08-13T00:30:00.000Z', nowIso }),
      /checkout_already_in_progress/,
    );
    const concurrent = await Promise.allSettled([
      store.createCheckoutIntent({ customerId: 'cust_a', plan: 'pro', billingCycle: 'monthly', extraConnectSlots: 1, amount: '45.00', currency: 'USD', expiresAtIso: '2026-08-13T00:30:00.000Z', nowIso }),
      store.createCheckoutIntent({ customerId: 'cust_a', plan: 'pro', billingCycle: 'monthly', extraConnectSlots: 1, amount: '45.00', currency: 'USD', expiresAtIso: '2026-08-13T00:30:00.000Z', nowIso }),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
    const concurrentResult = concurrent.find((result) => result.status === 'fulfilled');
    assert.ok(concurrentResult && concurrentResult.status === 'fulfilled');
    assert.equal((await store.getCheckoutIntent(concurrentResult.value.id, nowIso))?.status, 'created');
    // A rejected queued operation must release the FIFO gate: this distinct purchase can run next.
    const postRejection = await store.createCheckoutIntent({ customerId: 'cust_a', plan: 'max', billingCycle: 'monthly', extraConnectSlots: 0, amount: '59.00', currency: 'USD', expiresAtIso: '2026-08-13T00:30:00.000Z', nowIso });
    assert.equal(postRejection.status, 'created');
    assert.equal((await store.bindCheckoutIntentPaypalOrder({ intentId: intent.id, customerId: 'cust_b', paypalOrderId: 'ORDER-1', nowIso })).error, 'not_found');
    assert.equal((await store.bindCheckoutIntentPaypalOrder({ intentId: intent.id, customerId: 'cust_a', paypalOrderId: 'ORDER-1', nowIso })).intent?.status, 'bound');
    assert.equal((await store.bindCheckoutIntentPaypalOrder({ intentId: intent.id, customerId: 'cust_a', paypalOrderId: 'ORDER-1', nowIso })).intent?.status, 'bound');
    assert.equal((await store.bindCheckoutIntentPaypalOrder({ intentId: intent.id, customerId: 'cust_a', paypalOrderId: 'ORDER-OTHER', nowIso })).error, 'already_bound');
    assert.equal((await store.cancelCheckoutIntent({ intentId: intent.id, customerId: 'cust_b', nowIso })).error, 'not_found');
    assert.equal((await store.cancelCheckoutIntent({ intentId: intent.id, customerId: 'cust_a', nowIso })).intent?.status, 'cancelled');
    const replacement = await store.createCheckoutIntent({ customerId: 'cust_a', plan: 'lite', billingCycle: 'monthly', extraConnectSlots: 1, amount: '25.00', currency: 'USD', expiresAtIso: '2026-08-13T00:30:00.000Z', nowIso });
    assert.equal((await store.bindCheckoutIntentPaypalOrder({ intentId: replacement.id, customerId: 'cust_a', paypalOrderId: 'ORDER-1', nowIso })).error, 'paypal_order_bound');
    assert.equal((await store.bindCheckoutIntentPaypalOrder({ intentId: replacement.id, customerId: 'cust_a', paypalOrderId: 'ORDER-2', nowIso: '2026-08-13T00:31:00.000Z' })).error, 'expired');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkout sidecar isolates intents, migrates idempotently, and recovers safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-checkout-sidecar-'));
  try {
    const mainPath = join(dir, 'ras-store.json');
    const sidecarPath = join(dir, 'checkout-intents.json');
    const legacy = { id: 'checkout_legacy', customerId: 'cust_a', plan: 'lite' as const, billingCycle: 'monthly' as const, extraConnectSlots: 0, amount: '19.00', currency: 'USD' as const, status: 'created' as const, expiresAtIso: '2026-08-13T01:00:00.000Z', createdAtIso: '2026-08-13T00:00:00.000Z', updatedAtIso: '2026-08-13T00:00:00.000Z' };
    const store = new JsonRasStore(mainPath, sidecarPath);
    await store.migrate();
    await store.upsertCustomer({ id: 'cust_a', name: 'A', status: 'active' });
    const main = await store.load();
    // First migration rejects conflicting duplicate legacy IDs before it can set the durable marker.
    await writeFile(mainPath, `${JSON.stringify({ ...main, checkoutIntents: [legacy, { ...legacy, amount: '99.00' }] })}\n`);
    await assert.rejects(() => new JsonRasStore(mainPath, sidecarPath).getCheckoutIntent(legacy.id), /checkout_intent_legacy_conflict/);
    await writeFile(mainPath, `${JSON.stringify({ ...main, checkoutIntents: [legacy] })}\n`);
    assert.equal((await store.getCheckoutIntent(legacy.id, '2026-08-13T00:01:00.000Z'))?.id, legacy.id);
    const firstSidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as { legacyMigrationComplete: boolean };
    assert.equal(firstSidecar.legacyMigrationComplete, true);
    assert.deepEqual((JSON.parse(await readFile(mainPath, 'utf8')) as { checkoutIntents: unknown[] }).checkoutIntents, [legacy]);
    // Mutate the authoritative sidecar while main intentionally retains stale pre-migration data.
    assert.equal((await store.bindCheckoutIntentPaypalOrder({ intentId: legacy.id, customerId: 'cust_a', paypalOrderId: 'ORDER-LEGACY', nowIso: '2026-08-13T00:01:00.000Z' })).intent?.status, 'bound');
    assert.equal((await store.cancelCheckoutIntent({ intentId: legacy.id, customerId: 'cust_a', nowIso: '2026-08-13T00:02:00.000Z' })).intent?.status, 'cancelled');
    // Restart must honor sidecar state and marker, never re-merge/revert unchanged stale main input.
    assert.equal((await new JsonRasStore(mainPath, sidecarPath).getCheckoutIntent(legacy.id, '2026-08-13T00:03:00.000Z'))?.status, 'cancelled');
    // A worker-like stale main rewrite cannot erase the API-only sidecar record.
    await writeFile(mainPath, `${JSON.stringify({ ...main, checkoutIntents: [] })}\n`);
    assert.equal((await new JsonRasStore(mainPath, sidecarPath).getCheckoutIntent(legacy.id, '2026-08-13T00:03:00.000Z'))?.status, 'cancelled');
    // Restart persistence and backup recovery.
    const created = await store.createCheckoutIntent({ customerId: 'cust_a', plan: 'pro', billingCycle: 'monthly', extraConnectSlots: 1, amount: '45.00', currency: 'USD', expiresAtIso: '2026-08-13T01:00:00.000Z', nowIso: '2026-08-13T00:01:00.000Z' });
    await copyFile(sidecarPath, `${sidecarPath}.bak`);
    await writeFile(sidecarPath, '{truncated');
    assert.equal((await new JsonRasStore(mainPath, sidecarPath).getCheckoutIntent(created.id, '2026-08-13T00:02:00.000Z'))?.id, created.id);
    // A valid temp document is recovered when primary is absent.
    await copyFile(sidecarPath, `${sidecarPath}.tmp`); await rm(sidecarPath);
    assert.equal((await new JsonRasStore(mainPath, sidecarPath).getCheckoutIntent(created.id, '2026-08-13T00:02:00.000Z'))?.id, created.id);
    assert.equal((JSON.parse(await readFile(sidecarPath, 'utf8')) as { legacyMigrationComplete: boolean }).legacyMigrationComplete, true);
    // Existing but irrecoverably corrupt artifacts fail closed.
    await writeFile(sidecarPath, '{bad'); await writeFile(`${sidecarPath}.bak`, '{bad'); await writeFile(`${sidecarPath}.tmp`, '{bad');
    await assert.rejects(() => new JsonRasStore(mainPath, sidecarPath).getCheckoutIntent(created.id), /checkout_intent_store_unavailable/);
    assert.notEqual(firstSidecar, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('staging compose maps checkout sidecar to its approved physical volume and mounts it only into ras-api', async () => {
  const compose = await readFile(join(process.cwd(), 'docker-compose.staging.yml'), 'utf8');
  assert.match(compose, /RAS_CHECKOUT_INTENTS_PATH: \/checkout-intents\/checkout-intents\.json/);
  assert.match(compose, /ras-api:[\s\S]*?- ras-checkout-intents:\/checkout-intents/);
  assert.match(compose, /volumes:\s*[\s\S]*?ras-checkout-intents:\s*\n\s*name: ras-deployment-kit_ras-checkout-intents-staging/);
  assert.equal(/ras-worker:[\s\S]*?- ras-checkout-intents:\/checkout-intents/.test(compose), false);
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
