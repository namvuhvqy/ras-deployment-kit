import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRasStore } from '../packages/shared/src/persistentStore.js';
import { RasJobWorker, workerOptionsFromEnv } from '../packages/worker/src/jobWorker.js';
import type { ZernioAdapter } from '../packages/zernio-adapter/src/index.js';

const adapter: ZernioAdapter = {
  async createProfile() { throw new Error('not used'); },
  async getConnectUrl() { throw new Error('not used'); },
  async listFacebookPages() { throw new Error('not used'); },
  async selectFacebookPage() { throw new Error('not used'); },
  async listAccounts() { throw new Error('not used'); },
  async getAccount() { throw new Error('not used'); },
  async disconnectAccount() { throw new Error('not used'); },
  async createPost(input) { return { zernioPostId: `post_${input.accountId}`, status: 'queued' }; },
  async sendInboxMessage() { return { providerMessageId: 'not-used' }; },
};

const options = { batchSize: 1, idleMs: 1, maxRetries: 1, baseRetryMs: 1, singleRun: true, dryRun: false };

test('worker single-run sweeps durable T-7/T0/T+7 lifecycle state before draining jobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-lifecycle-'));
  try {
    const store = new JsonRasStore(join(dir, 'store.json'));
    await store.migrate();
    await store.upsertCustomer({
      id: 'expired', name: 'Expired', packageStatus: 'active', addOnStatus: { zernio: 'active' }, maxConnectedAccounts: 1,
      entitlement: { basePlan: { planId: 'lite', status: 'active', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, expiresAtIso: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString() }, connectSlots: { status: 'active', includedSlots: 1, purchasedSlots: 0, trialSlots: 0, totalSlots: 1, activeConnectedAccounts: 0 }, addOns: [] },
    });

    await new RasJobWorker(store, adapter, options).runOnce();
    const state = await store.load();
    assert.deepEqual(state.subscriptionLifecycleEvents.map((event) => event.lifecycleState), ['expiring_soon', 'past_due', 'expired']);
    assert.equal(state.customers[0]?.packageStatus, 'expired');
    assert.equal(state.customers[0]?.entitlement?.basePlan.status, 'expired');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker CLI single-run invokes lifecycle sweep before exiting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-lifecycle-cli-'));
  try {
    const dbPath = join(dir, 'store.json');
    const store = new JsonRasStore(dbPath);
    await store.migrate();
    await store.upsertCustomer({
      id: 'expired-cli', name: 'Expired CLI', packageStatus: 'active', addOnStatus: { zernio: 'active' }, maxConnectedAccounts: 1,
      entitlement: { basePlan: { planId: 'lite', status: 'active', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, expiresAtIso: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString() }, connectSlots: { status: 'active', includedSlots: 1, purchasedSlots: 0, trialSlots: 0, totalSlots: 1, activeConnectedAccounts: 0 }, addOns: [] },
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['dist/apps/ras-worker/src/worker.js'], { cwd: process.cwd(), env: { ...process.env, RAS_DB_PATH: dbPath, RAS_WORKER_SINGLE_RUN: 'true' }, stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0);
    assert.deepEqual((await store.load()).subscriptionLifecycleEvents.map((event) => event.lifecycleState), ['expiring_soon', 'past_due', 'expired']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker lifecycle sweep does not prevent normal queued job draining when it has no work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-lifecycle-'));
  try {
    const store = new JsonRasStore(join(dir, 'store.json'));
    await store.migrate();
    await store.enqueueJob({ id: 'job', customerId: 'customer', profileId: 'profile', platform: 'facebook', type: 'publish_post', priority: 'P1', status: 'queued', retryCount: 0, payload: { content: 'hello', platform: 'facebook', accountId: 'account' }, createdAtIso: new Date().toISOString() });
    assert.deepEqual(await new RasJobWorker(store, adapter, options).runOnce(), { processed: 1, completed: 1, failed: 0, requeued: 0 });
    assert.equal((await store.load()).jobs[0]?.status, 'completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker catches lifecycle sweep failures and still drains jobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-worker-lifecycle-'));
  try {
    const store = new JsonRasStore(join(dir, 'store.json'));
    await store.migrate();
    await store.enqueueJob({ id: 'job', customerId: 'customer', profileId: 'profile', platform: 'facebook', type: 'publish_post', priority: 'P1', status: 'queued', retryCount: 0, payload: { content: 'hello', platform: 'facebook', accountId: 'account' }, createdAtIso: new Date().toISOString() });
    (store as unknown as { sweepSubscriptionLifecycle: (nowIso: string) => Promise<never> }).sweepSubscriptionLifecycle = async () => { throw new Error('transient lifecycle store error'); };
    assert.deepEqual(await new RasJobWorker(store, adapter, options).runOnce(), { processed: 1, completed: 1, failed: 0, requeued: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('lifecycle sweep cadence uses a strict bounded environment value with safe fallback', () => {
  assert.equal(workerOptionsFromEnv({ SUBSCRIPTION_LIFECYCLE_SWEEP_MS: '60000' }).lifecycleSweepMs, 60_000);
  for (const value of ['', '1e5', '60000.5', '59999', '86400001', 'oops']) assert.equal(workerOptionsFromEnv({ SUBSCRIPTION_LIFECYCLE_SWEEP_MS: value }).lifecycleSweepMs, 15 * 60_000);
});
