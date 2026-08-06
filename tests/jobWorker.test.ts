import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRasStore } from '../packages/shared/src/persistentStore.js';
import { RasJobWorker } from '../packages/worker/src/jobWorker.js';
import type { RasJob } from '../packages/shared/src/types.js';
import { ZernioApiError, type ZernioAdapter } from '../packages/zernio-adapter/src/index.js';

const noopAdapter: ZernioAdapter = {
  async createProfile() {
    throw new Error('not used');
  },
  async getConnectUrl() {
    throw new Error('not used');
  },
  async listFacebookPages() {
    throw new Error('not used');
  },
  async selectFacebookPage() {
    throw new Error('not used');
  },
  async listAccounts() {
    throw new Error('not used');
  },
  async getAccount() {
    throw new Error('not used');
  },
  async disconnectAccount() {
    throw new Error('not used');
  },
  async createPost(input) {
    return { zernioPostId: `live_${input.accountId}`, status: input.scheduleAtIso ? 'scheduled' : 'queued' };
  },
  async sendInboxMessage() {
    return { providerMessageId: 'message_live_test' };
  },
};

test('RasJobWorker drains due queued jobs fairly and persists completion metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.enqueueJob(makePublishJob('job_a1', 'profile_a', 'P1'));
    await store.enqueueJob(makePublishJob('job_a2', 'profile_a', 'P2'));
    await store.enqueueJob(makePublishJob('job_b1', 'profile_b', 'P1'));

    const sent: Array<{ topicId: number; message: string }> = [];
    const worker = new RasJobWorker(store, noopAdapter, {
      batchSize: 2,
      idleMs: 1,
      maxRetries: 1,
      baseRetryMs: 1,
      singleRun: true,
      dryRun: false,
      notifier: { async send(topicId, message) { sent.push({ topicId, message }); } },
    });

    const result = await worker.runOnce();
    const state = await store.load();

    assert.deepEqual(result, { processed: 2, completed: 2, failed: 0, requeued: 0 });
    assert.equal(state.jobs.find((job) => job.id === 'job_a1')?.status, 'completed');
    assert.equal(state.jobs.find((job) => job.id === 'job_b1')?.status, 'completed');
    assert.equal(state.jobs.find((job) => job.id === 'job_a2')?.status, 'queued');
    assert.equal(sent.length, 2);
    assert.ok(sent.every((item) => item.topicId === 29));
    assert.equal((state.jobs.find((job) => job.id === 'job_a1')?.result as Record<string, unknown>).status, 'queued');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RasJobWorker creates and persists a queued tenant/platform connect profile exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.upsertCustomer({ id: 'cust_connect', name: 'Connect tenant', email: 'connect@example.test', maxConnectedAccounts: 2, packageStatus: 'active', addOnStatus: { zernio: 'active' } });
    const created: string[] = [];
    const adapter = { ...noopAdapter, async createProfile(input) { created.push(input.customerId); return { id: input.customerId, name: input.name, email: input.email, zernioProfileId: 'profile_connect_2' }; } } satisfies ZernioAdapter;
    const job = { id: 'provision_profile:cust_connect:facebook:same_platform_connect', customerId: 'cust_connect', profileId: '', platform: 'facebook' as const, type: 'create_profile' as const, priority: 'P0' as const, status: 'queued' as const, retryCount: 0, payload: { reason: 'same_platform_connect', platform: 'facebook' }, createdAtIso: new Date().toISOString() };
    assert.equal((await store.enqueueJobIfAbsent(job)).inserted, true);
    assert.equal((await store.enqueueJobIfAbsent(job)).inserted, false);
    const worker = new RasJobWorker(store, adapter, { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false });
    assert.deepEqual(await worker.runOnce(), { processed: 1, completed: 1, failed: 0, requeued: 0 });
    assert.deepEqual(created, ['cust_connect']);
    const completed = await store.load();
    assert.deepEqual(completed.customers[0]?.zernioProfileIds, ['profile_connect_2']);
    assert.equal(completed.jobs[0]?.status, 'completed');
    await store.enqueueJob({ ...job, id: 'provision_profile_retry:cust_connect:facebook', status: 'queued', retryCount: 0, createdAtIso: new Date().toISOString() });
    assert.deepEqual(await worker.runOnce(), { processed: 1, completed: 1, failed: 0, requeued: 0 });
    assert.deepEqual(created, ['cust_connect'], 'a retry observes the persisted mapping and cannot create another profile');
    assert.equal((await store.load()).jobs[1]?.result?.idempotent, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('RasJobWorker provisions a captured payment from a durable outbox job exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.upsertCustomer({ id: 'cust_paid', name: 'Paid tenant', email: 'paid@example.test', maxConnectedAccounts: 2, packageStatus: 'active', addOnStatus: { zernio: 'active' }, entitlement: { basePlan: { planId: 'lite', status: 'active', billingCycle: 'monthly', vps: { type: 'dedicated' }, agents: { included: 2, kinds: ['ras1-hermes', 'ras2-openclaw'] }, activatedAtIso: '2026-08-01T00:00:00.000Z' }, connectSlots: { status: 'active', includedSlots: 1, purchasedSlots: 1, trialSlots: 0, totalSlots: 2, activeConnectedAccounts: 1 }, addOns: [] } });
    const timestamp = new Date().toISOString();
    await store.recordBillingPaymentCapture({ provider: 'paypal', customerId: 'cust_paid', paypalOrderId: 'ORDER-OUTBOX-1', transactionId: 'CAPTURE-OUTBOX-1', status: 'captured', amount: '6', currency: 'USD', plan: 'lite', billingCycle: 'monthly', extraConnectSlots: 1, createdAtIso: timestamp, updatedAtIso: timestamp });
    await store.enqueueJob({ id: 'provision_payment_paypal:ORDER-OUTBOX-1', customerId: 'cust_paid', profileId: '', type: 'provision_entitlement', priority: 'P0', status: 'queued', retryCount: 0, payload: { paymentId: 'paypal:ORDER-OUTBOX-1' }, createdAtIso: timestamp });
    const adapter = { ...noopAdapter, async createProfile(input) { return { id: input.customerId, name: input.name, email: input.email, zernioProfileId: 'profile_paid' }; } } satisfies ZernioAdapter;
    const worker = new RasJobWorker(store, adapter, { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false });

    assert.deepEqual(await worker.runOnce(), { processed: 1, completed: 1, failed: 0, requeued: 0 });
    const state = await store.load();
    assert.equal(state.billingPayments[0]?.provisionStatus, 'provisioned');
    assert.equal(state.customers[0]?.maxConnectedAccounts, 3);
    assert.equal(state.customers[0]?.entitlement?.connectSlots.purchasedSlots, 2);
    assert.equal(state.customers[0]?.entitlement?.connectSlots.totalSlots, 3);
    assert.equal(state.customers[0]?.zernioProfileId, 'profile_paid');
    assert.equal(state.jobs[0]?.status, 'completed');

    await store.enqueueJob({ id: 'provision_payment_retry_same_capture', customerId: 'cust_paid', profileId: '', type: 'provision_entitlement', priority: 'P0', status: 'queued', retryCount: 0, payload: { paymentId: 'paypal:ORDER-OUTBOX-1' }, createdAtIso: timestamp });
    assert.deepEqual(await worker.runOnce(), { processed: 1, completed: 1, failed: 0, requeued: 0 });
    const retried = await store.load();
    assert.equal(retried.customers[0]?.maxConnectedAccounts, 3);
    assert.equal(retried.customers[0]?.entitlement?.connectSlots.purchasedSlots, 2);
    assert.equal(retried.customers[0]?.entitlement?.connectSlots.totalSlots, 3);
    assert.equal((retried.jobs[1]?.result as Record<string, unknown>).idempotent, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RasJobWorker forwards safe draft flag into publish payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    const draftJob = makePublishJob('job_draft', 'profile_a', 'P1');
    draftJob.payload = { ...draftJob.payload, isDraft: true };
    await store.enqueueJob(draftJob);
    let seenDraft;
    let seenRequestId;
    const adapter = { ...noopAdapter, async createPost(input) { seenDraft = input.isDraft; seenRequestId = input.requestId; return { zernioPostId: 'draft_1', status: 'draft' }; } } satisfies ZernioAdapter;
    const worker = new RasJobWorker(store, adapter, { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false });

    const result = await worker.runOnce();
    const job = (await store.load()).jobs[0];

    assert.deepEqual(result, { processed: 1, completed: 1, failed: 0, requeued: 0 });
    assert.equal(seenDraft, true);
    assert.equal(seenRequestId, 'job_draft');
    assert.equal(job.result?.status, 'draft');
    assert.equal((await store.load()).socialPosts[0]?.zernioPostId, 'draft_1');
    assert.equal((await store.load()).socialPosts[0]?.status, 'draft');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dry-run publish preserves post status, completes job, and attaches no fake provider id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-dry-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json')); await store.migrate(); const job = makePublishJob('job_dry', 'profile_a', 'P1');
    job.payload = { ...job.payload, postId: 'job_dry', scheduleAtIso: '2026-09-01T00:00:00.000Z' }; await store.enqueueJob(job);
    const worker = new RasJobWorker(store, noopAdapter, { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: true });
    assert.deepEqual(await worker.runOnce(), { processed: 1, completed: 1, failed: 0, requeued: 0 }); const state = await store.load();
    assert.equal(state.jobs[0]?.status, 'completed'); assert.equal(state.socialPosts[0]?.status, 'queued'); assert.equal(state.socialPosts[0]?.zernioPostId, undefined); assert.equal(state.jobs[0]?.result?.status, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('RasJobWorker requeues transient failures before failing permanently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.enqueueJob(makePublishJob('job_fail', 'profile_a', 'P1'));
    const failingAdapter = { ...noopAdapter, async createPost() { throw new Error('zernio 429'); } };

    const worker = new RasJobWorker(store, failingAdapter, {
      batchSize: 1,
      idleMs: 1,
      maxRetries: 1,
      baseRetryMs: 1,
      singleRun: true,
      dryRun: false,
    });

    const result = await worker.runOnce();
    const job = (await store.load()).jobs[0];

    assert.deepEqual(result, { processed: 1, completed: 0, failed: 0, requeued: 1 });
    assert.equal(job.status, 'queued');
    assert.equal(job.retryCount, 1);
    assert.equal(job.lastError, 'zernio 429');
    assert.ok(job.runAfterIso);
    assert.equal((await store.load()).socialPosts[0]?.status, 'queued');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RasJobWorker fails fast for permanent Zernio 400 validation errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.enqueueJob(makePublishJob('job_zernio_400', 'profile_a', 'P1'));
    const invalidPayloadAdapter = {
      ...noopAdapter,
      async createPost() {
        throw new ZernioApiError('Zernio API 400 for /posts', 400, { error: 'invalid payload' });
      },
    } satisfies ZernioAdapter;
    const worker = new RasJobWorker(store, invalidPayloadAdapter, {
      batchSize: 1, idleMs: 1, maxRetries: 5, baseRetryMs: 1, singleRun: true, dryRun: false,
    });

    const result = await worker.runOnce();
    const job = (await store.load()).jobs[0];

    assert.deepEqual(result, { processed: 1, completed: 0, failed: 1, requeued: 0 });
    assert.equal(job.status, 'failed');
    assert.equal(job.retryCount, 1);
    assert.equal(job.lastError, 'Zernio API 400 for /posts');
    assert.equal(job.runAfterIso, undefined);
    assert.equal((await store.load()).socialPosts[0]?.status, 'failed');
    assert.equal((await store.load()).socialPosts[0]?.errorMessage, 'Zernio API 400 for /posts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RasJobWorker requeues Zernio 429 rate limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.enqueueJob(makePublishJob('job_zernio_429', 'profile_a', 'P1'));
    const throttledAdapter = {
      ...noopAdapter,
      async createPost() {
        throw new ZernioApiError('Zernio API 429 for /posts', 429, { error: 'rate limited' });
      },
    } satisfies ZernioAdapter;
    const worker = new RasJobWorker(store, throttledAdapter, {
      batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false,
    });

    const result = await worker.runOnce();
    const job = (await store.load()).jobs[0];

    assert.deepEqual(result, { processed: 1, completed: 0, failed: 0, requeued: 1 });
    assert.equal(job.status, 'queued');
    assert.equal(job.retryCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RasJobWorker persists an inbound message in draft-only mode without sending a reply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.enqueueJob({
      id: 'inbox_webhook_1', customerId: 'cust_inbox', profileId: 'profile_inbox', accountId: 'acct_inbox', platform: 'facebook',
      type: 'inbox_process', priority: 'P0', status: 'queued', retryCount: 0, createdAtIso: new Date().toISOString(),
      payload: { eventType: 'message.received', webhookPayload: { message: { id: 'msg_1', conversationId: 'conv_1', platform: 'facebook', platformMessageId: 'provider_1', direction: 'incoming', text: 'Xin chào', sender: { id: 'sender_1', name: 'Anh Nam' }, sentAt: '2026-07-30T00:00:00.000Z' }, conversation: { id: 'conv_1', participantId: 'sender_1' } } },
    });
    const worker = new RasJobWorker(store, noopAdapter, { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false });

    const result = await worker.runOnce();
    const state = await store.load();

    assert.deepEqual(result, { processed: 1, completed: 1, failed: 0, requeued: 0 });
    assert.equal(state.inboxMessages.length, 1);
    assert.equal(state.inboxMessages[0]?.text, 'Xin chào');
    assert.equal(state.jobs[0]?.result?.mode, 'draft_only');
    assert.equal(state.jobs[0]?.result?.outboundSendAttempted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RasJobWorker persists an outbound delivery lifecycle message without sending a reply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.enqueueJob({
      id: 'delivery_webhook_1', customerId: 'cust_inbox', profileId: 'profile_inbox', accountId: 'acct_inbox', platform: 'facebook',
      type: 'inbox_process', priority: 'P0', status: 'queued', retryCount: 0, createdAtIso: new Date().toISOString(),
      payload: { eventType: 'message.delivered', webhookPayload: { message: { id: 'msg_out_1', conversationId: 'conv_1', platform: 'facebook', platformMessageId: 'provider_out_1', direction: 'outgoing', text: 'Đã giao', sender: { id: 'acct_inbox', name: 'Shop' }, sentAt: '2026-07-30T00:00:00.000Z' }, conversation: { id: 'conv_1' }, account: { accountId: 'acct_inbox' } } },
    });
    const worker = new RasJobWorker(store, noopAdapter, { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false });

    assert.deepEqual(await worker.runOnce(), { processed: 1, completed: 1, failed: 0, requeued: 0 });
    const state = await store.load();
    assert.equal(state.inboxMessages.length, 1);
    assert.equal(state.inboxMessages[0]?.direction, 'outbound');
    assert.equal(state.inboxMessages[0]?.providerMessageId, 'provider_out_1');
    assert.equal(state.jobs[0]?.result?.eventType, 'message.delivered');
    assert.equal(state.jobs[0]?.result?.outboundSendAttempted, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('RasJobWorker sends an approved inbox reply once and persists provider delivery evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    const now = new Date().toISOString();
    await store.recordInboxMessage({ id: 'in_1', customerId: 'cust_1', accountId: 'acct_1', platform: 'facebook', conversationId: 'conv_1', providerMessageId: 'provider_in_1', direction: 'inbound', text: 'Xin chào', receivedAtIso: now });
    const draft = await store.createInboxDraftReply({ customerId: 'cust_1', conversationId: 'conv_1', text: 'Đã nhận ạ', createdByUserId: 'user_1' });
    const approval = await store.approveInboxDraftReply({ customerId: 'cust_1', draftId: draft.id, approvedByUserId: 'user_1' });
    let calls = 0;
    const adapter = { ...noopAdapter, async sendInboxMessage(input) { calls += 1; assert.deepEqual(input, { conversationId: 'conv_1', accountId: 'acct_1', text: 'Đã nhận ạ', requestId: approval.job.id }); return { providerMessageId: 'provider_out_1' }; } } satisfies ZernioAdapter;
    const worker = new RasJobWorker(store, adapter, { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false });
    assert.deepEqual(await worker.runOnce(), { processed: 1, completed: 1, failed: 0, requeued: 0 });
    const saved = await store.load();
    assert.equal(calls, 1);
    assert.deepEqual(saved.inboxDraftReplies[0] && { status: saved.inboxDraftReplies[0].status, sendAttempted: saved.inboxDraftReplies[0].sendAttempted, providerMessageId: saved.inboxDraftReplies[0].providerMessageId }, { status: 'sent', sendAttempted: true, providerMessageId: 'provider_out_1' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('RasJobWorker maps a published webhook by platformPostId when Zernio post id is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.upsertSocialPost({
      id: 'post_1', jobId: 'job_1', customerId: 'customer_profile_a', platform: 'facebook',
      platformPostId: 'facebook_42', status: 'queued', updatedAtIso: new Date(0).toISOString(),
    });
    await store.enqueueJob({
      ...makePublishJob('webhook_1', 'profile_a', 'P0'), type: 'webhook_process',
      payload: { eventType: 'post.platform.published', webhookPayload: { platform: { platformPostId: 'facebook_42', publishedAt: '2026-07-29T00:00:00.000Z' } } },
    });
    const worker = new RasJobWorker(store, noopAdapter, { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false });

    const result = await worker.runOnce();
    const post = (await store.load()).socialPosts[0];

    assert.deepEqual(result, { processed: 1, completed: 1, failed: 0, requeued: 0 });
    assert.equal(post?.status, 'published');
    assert.equal(post?.publishedAtIso, '2026-07-29T00:00:00.000Z');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RasJobWorker verifies an account-connected webhook from the profile list when getAccount returns 405', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.upsertCustomer({ id: 'cust_1', name: 'Tenant', zernioProfileId: 'profile_1' });
    await store.enqueueJob({
      id: 'webhook_account_405', customerId: 'cust_1', profileId: 'profile_1', accountId: 'acct_1', platform: 'facebook',
      type: 'webhook_process', priority: 'P0', status: 'queued', retryCount: 0, createdAtIso: new Date().toISOString(),
      payload: { eventType: 'account.connected', account: { accountId: 'acct_1', profileId: 'profile_1', platform: 'facebook' } },
    });
    const adapter = {
      ...noopAdapter,
      async getAccount() { throw new ZernioApiError('Zernio API 405 for /accounts/acct_1', 405, { error: 'method not allowed' }); },
      async listAccounts(profileId) { return [{ id: 'external_1', customerId: '', zernioAccountId: 'acct_1', profileId, zernioProfileId: profileId, platform: 'facebook', username: 'page', status: 'connected', capabilities: [] }]; },
    } satisfies ZernioAdapter;
    const worker = new RasJobWorker(store, adapter, { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false });

    assert.deepEqual(await worker.runOnce(), { processed: 1, completed: 1, failed: 0, requeued: 0 });
    const state = await store.load();
    assert.equal(state.connectedAccounts[0]?.status, 'connected');
    assert.equal(state.jobs[0]?.result?.verificationSource, 'profile_list_fallback');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two workers sharing a store atomically claim a queued job exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-claim-'));
  try {
    const path = join(dir, 'ras-store.json');
    const firstStore = new JsonRasStore(path); const secondStore = new JsonRasStore(path);
    await firstStore.migrate(); await firstStore.enqueueJob(makePublishJob('job_once', 'profile_a', 'P1'));
    let calls = 0;
    const adapter = { ...noopAdapter, async createPost() { calls += 1; await new Promise((resolve) => setTimeout(resolve, 25)); return { zernioPostId: 'once', status: 'queued' as const }; } } satisfies ZernioAdapter;
    const options = { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false };
    const results = await Promise.all([new RasJobWorker(firstStore, adapter, options).runOnce(), new RasJobWorker(secondStore, adapter, options).runOnce()]);
    assert.equal(calls, 1);
    assert.equal(results.reduce((sum, result) => sum + result.processed, 0), 1);
    assert.equal((await firstStore.load()).jobs[0]?.status, 'completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('RasJobWorker reclaims and completes a stale processing job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-stale-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json')); await store.migrate();
    await store.enqueueJob({ ...makePublishJob('stale_job', 'profile_a', 'P1'), status: 'processing', processingStartedAtIso: '2020-01-01T00:00:00.000Z', claimToken: 'dead' });
    let calls = 0; const adapter = { ...noopAdapter, async createPost() { calls += 1; return { zernioPostId: 'reclaimed', status: 'queued' as const }; } } satisfies ZernioAdapter;
    const result = await new RasJobWorker(store, adapter, { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false, claimLeaseMs: 1_000 }).runOnce();
    assert.deepEqual(result, { processed: 1, completed: 1, failed: 0, requeued: 0 }); assert.equal(calls, 1); assert.equal((await store.load()).jobs[0]?.status, 'completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function makePublishJob(id: string, profileId: string, priority: RasJob['priority']): RasJob {
  return {
    id,
    customerId: `customer_${profileId}`,
    profileId,
    accountId: `account_${profileId}`,
    type: 'publish_post',
    priority,
    payload: {
      platform: 'facebook',
      content: `hello ${id}`,
    },
    status: 'queued',
    retryCount: 0,
    createdAtIso: new Date(0).toISOString(),
  };
}
