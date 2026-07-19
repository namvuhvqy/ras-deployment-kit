import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRasStore } from '../packages/shared/src/persistentStore.js';
import { RasJobWorker } from '../packages/worker/src/jobWorker.js';
import type { RasJob } from '../packages/shared/src/types.js';
import type { ZernioAdapter } from '../packages/zernio-adapter/src/index.js';

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
  async createPost(input) {
    return { zernioPostId: `live_${input.accountId}`, status: input.scheduleAtIso ? 'scheduled' : 'queued' };
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
    const adapter = { ...noopAdapter, async createPost(input) { seenDraft = input.isDraft; return { zernioPostId: 'draft_1', status: 'draft' }; } } satisfies ZernioAdapter;
    const worker = new RasJobWorker(store, adapter, { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false });

    const result = await worker.runOnce();
    const job = (await store.load()).jobs[0];

    assert.deepEqual(result, { processed: 1, completed: 1, failed: 0, requeued: 0 });
    assert.equal(seenDraft, true);
    assert.equal(job.result?.status, 'draft');
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
