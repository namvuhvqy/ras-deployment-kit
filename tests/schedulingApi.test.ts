import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();
const future = new Date(Date.now() + 60 * 60_000).toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function activeEntitlement(expiresAtIso = new Date(Date.now() + 24 * 60 * 60_000).toISOString()) {
  return {
    basePlan: { planId: 'lite', status: 'active', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, expiresAtIso },
    connectSlots: { status: 'active', includedSlots: 1, purchasedSlots: 0, trialSlots: 0, totalSlots: 1, activeConnectedAccounts: 0 },
    addOns: [{ id: 'zernio', name: 'Zernio Connect', status: 'active' }],
  };
}

function state() {
  return {
    schemaVersion: 1, migratedAtIso: now,
    users: [], sessions: [], apiRateLimitBuckets: [],
    personalAccessTokens: [
      { id: 'pat_write', customerId: 'cust_a', createdByUserId: 'user_a', name: 'writer', tokenPrefix: 'writer', tokenHash: hash('writer-token'), scopes: ['posts:write'], createdAtIso: now },
      { id: 'pat_read', customerId: 'cust_a', createdByUserId: 'user_a', name: 'reader', tokenPrefix: 'reader', tokenHash: hash('reader-token'), scopes: ['posts:read'], createdAtIso: now },
      { id: 'pat_other', customerId: 'cust_b', createdByUserId: 'user_b', name: 'other', tokenPrefix: 'other', tokenHash: hash('other-token'), scopes: ['posts:read', 'posts:write'], createdAtIso: now },
    ],
    customers: [{ id: 'cust_a', name: 'A', entitlement: activeEntitlement() }, { id: 'cust_b', name: 'B' }],
    sandboxes: [], agents: [], servicePackages: [],
    connectedAccounts: [
      { id: 'acct_a', customerId: 'cust_a', platform: 'facebook', zernioAccountId: 'provider_a', zernioProfileId: 'profile_a', status: 'connected' },
      { id: 'acct_disconnected', customerId: 'cust_a', platform: 'twitter', zernioAccountId: 'provider_disconnected', zernioProfileId: 'profile_a', status: 'disconnected' },
      { id: 'acct_b', customerId: 'cust_b', platform: 'instagram', zernioAccountId: 'provider_b', zernioProfileId: 'profile_b', status: 'connected' },
    ],
    socialPosts: [], inboxConversations: [], inboxMessages: [], inboxDraftReplies: [], jobs: [],
    webhookEvents: [], webhookFailures: [], webhookStatus: { enabled: true, consecutiveFailures: 0 }, auditLogs: [], billingPayments: [], checkoutIntents: [],
  };
}

async function withApi(run: (baseUrl: string, dbPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'ras-scheduling-api-'));
  const dbPath = join(dir, 'store.json');
  const port = 20_080 + Math.floor(Math.random() * 1000);
  await writeFile(dbPath, JSON.stringify(state()));
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), RAS_DB_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('ras-api listening')) { clearTimeout(timer); resolve(); } });
      child.on('error', reject);
    });
    await run(`http://127.0.0.1:${port}`, dbPath);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

async function post(baseUrl: string, path: string, token: string, key: string | undefined, body: Record<string, unknown>) {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
}

test('scheduling API creates drafts/schedules atomically, idempotently, and tenant-scoped without accepting publishNow', async () => {
  await withApi(async (baseUrl, dbPath) => {
    const missingKey = await post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', undefined, { accountId: 'acct_a', content: 'hello' });
    assert.equal(missingKey.status, 400);
    const publishNow = await post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'reject-now', { accountId: 'acct_a', content: 'hello', publishNow: false });
    assert.equal(publishNow.status, 400);
    const wrongScope = await post(baseUrl, '/customers/cust_a/posts/drafts', 'reader-token', 'wrong-scope', { accountId: 'acct_a', content: 'hello' });
    assert.equal(wrongScope.status, 403);
    const foreignAccount = await post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'foreign', { accountId: 'acct_b', content: 'hello' });
    assert.equal(foreignAccount.status, 404);
    const disconnected = await post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'disconnected', { accountId: 'acct_disconnected', content: 'hello' });
    assert.equal(disconnected.status, 409);

    const draftBody = { accountId: 'acct_a', content: '  hello  ', mediaUrls: ['https://cdn.test/a.png'] };
    const draft = await post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'draft-1', draftBody);
    assert.equal(draft.status, 201);
    const first = await draft.json() as { post: { status: string; isDraft: boolean; platform: string; content: string } };
    assert.equal(first.post.isDraft, true);
    assert.equal(first.post.status, 'draft');
    assert.equal(first.post.platform, 'facebook');
    assert.equal(first.post.content, 'hello');
    assert.deepEqual(Object.keys(first.post).sort(), ['accountId', 'content', 'createdAtIso', 'isDraft', 'mediaUrls', 'monitorId', 'platform', 'status', 'updatedAtIso']);
    const repeat = await post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'draft-1', { mediaUrls: ['https://cdn.test/a.png'], content: '  hello  ', accountId: 'acct_a' });
    assert.equal(repeat.status, 200);
    assert.deepEqual((await repeat.json() as { post: unknown }).post, first.post);
    const conflict = await post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'draft-1', { accountId: 'acct_a', content: 'different' });
    assert.equal(conflict.status, 409);

    const invalidPast = await post(baseUrl, '/customers/cust_a/posts/schedules', 'writer-token', 'past', { accountId: 'acct_a', content: 'later', scheduleAtIso: '2020-01-01T00:00:00.000Z' });
    assert.equal(invalidPast.status, 400);
    const scheduled = await post(baseUrl, '/customers/cust_a/posts/schedules', 'writer-token', 'schedule-1', { accountId: 'acct_a', content: 'later', scheduleAtIso: future });
    assert.equal(scheduled.status, 201);
    const scheduledPayload = await scheduled.json() as { post: Record<string, unknown>; job: Record<string, unknown> };
    assert.equal(scheduledPayload.post.status, 'scheduled');
    assert.equal(scheduledPayload.post.isDraft, false);
    assert.equal(scheduledPayload.post.scheduleAtIso, future);
    assert.match(String(scheduledPayload.post.monitorId), /^post_/);
    assert.equal(scheduledPayload.job.runAfterIso, undefined);
    assert.deepEqual(Object.keys(scheduledPayload.job).sort(), ['id', 'status', 'type']);
    assert.equal(scheduledPayload.post.idempotencyKey, undefined);
    assert.equal(scheduledPayload.post.idempotencyPayloadHash, undefined);

    const forbiddenList = await fetch(`${baseUrl}/customers/cust_a/posts`, { headers: { authorization: 'Bearer writer-token' } });
    assert.equal(forbiddenList.status, 403);
    const crossTenant = await fetch(`${baseUrl}/customers/cust_a/posts`, { headers: { authorization: 'Bearer other-token' } });
    assert.equal(crossTenant.status, 403);
    const list = await fetch(`${baseUrl}/customers/cust_a/posts`, { headers: { authorization: 'Bearer reader-token' } });
    assert.equal(list.status, 200);
    const listed = await list.json() as { posts: Array<Record<string, unknown>> };
    assert.equal(listed.posts.length, 2);
    assert.ok(listed.posts.every((row) => !['customerId', 'profileId', 'jobId', 'idempotencyKey', 'idempotencyPayloadHash', 'errorMessage'].some((key) => key in row)));

    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { socialPosts: unknown[]; jobs: Array<{ payload: Record<string, unknown> }> };
    assert.equal(persisted.socialPosts.length, 2);
    assert.equal(persisted.jobs.length, 2);
    assert.ok(persisted.jobs.every((job) => job.payload.publishNow === undefined && job.payload.platform === 'facebook' && job.payload.providerAccountId === 'provider_a'));
  });
});

test('scheduling API canonicalizes timestamps, caps inputs and serializes concurrent idempotency', async () => {
  await withApi(async (baseUrl, dbPath) => {
    const nonCanonical = new Date(Date.now() + 2 * 60 * 60_000).toISOString().replace('.000Z', 'Z');
    const requests = await Promise.all(Array.from({ length: 4 }, () => post(baseUrl, '/customers/cust_a/posts/schedules', 'writer-token', 'same-key', { accountId: 'acct_a', content: 'later', scheduleAtIso: nonCanonical })));
    assert.equal(requests.filter((response) => response.status === 201).length, 1);
    assert.ok(requests.every((response) => response.status === 200 || response.status === 201));
    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { socialPosts: Array<{ scheduleAtIso?: string }>; jobs: Array<{ payload: Record<string, unknown> }> };
    assert.equal(persisted.socialPosts.length, 1);
    assert.equal(persisted.jobs.length, 1);
    assert.equal(persisted.socialPosts[0]?.scheduleAtIso, new Date(nonCanonical).toISOString());
    assert.equal(persisted.jobs[0]?.payload.scheduleAtIso, new Date(nonCanonical).toISOString());
    const invalid = [
      post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'k'.repeat(257), { accountId: 'acct_a', content: 'ok' }),
      post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'content-long', { accountId: 'acct_a', content: 'x'.repeat(10001) }),
      post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'too-many-media', { accountId: 'acct_a', content: 'ok', mediaUrls: Array(11).fill('https://cdn.test/a') }),
      post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'bad-media', { accountId: 'acct_a', content: 'ok', mediaUrls: ['file:///etc/passwd'] }),
      post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'long-media', { accountId: 'acct_a', content: 'ok', mediaUrls: [`https://x.test/${'a'.repeat(2048)}`] }),
    ];
    assert.deepEqual(await Promise.all(invalid).then((rows) => rows.map((row) => row.status)), [400, 400, 400, 400, 400]);
  });
});
