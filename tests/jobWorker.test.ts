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
  async listAccounts() {
    throw new Error('not used');
  },
  async getAccount() {
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
