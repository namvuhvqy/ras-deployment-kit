import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFile as readTextFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRasStore } from '../packages/shared/src/persistentStore.js';

const now = new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function state() {
  return {
    schemaVersion: 2, migratedAtIso: now,
    users: [
      { id: 'user_a', email: 'a@test.invalid', role: 'owner', customerId: 'cust_a', status: 'active', createdAtIso: now, updatedAtIso: now },
      { id: 'user_b', email: 'b@test.invalid', role: 'owner', customerId: 'cust_b', status: 'active', createdAtIso: now, updatedAtIso: now },
      { id: 'user_system', email: 'system@test.invalid', role: 'admin', customerId: 'cust_system', status: 'active', createdAtIso: now, updatedAtIso: now },
    ],
    sessions: [
      { id: 's_a', token: 'session-a', userId: 'user_a', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3_600_000).toISOString() },
      { id: 's_b', token: 'session-b', userId: 'user_b', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3_600_000).toISOString() },
      { id: 's_system', token: 'session-system', userId: 'user_system', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3_600_000).toISOString() },
    ],
    apiRateLimitBuckets: [],
    personalAccessTokens: [
      { id: 'pat_write', customerId: 'cust_a', createdByUserId: 'user_a', name: 'writer', tokenPrefix: 'writer', tokenHash: hash('writer-token'), scopes: ['posts:write'], createdAtIso: now },
      { id: 'pat_read', customerId: 'cust_a', createdByUserId: 'user_a', name: 'reader', tokenPrefix: 'reader', tokenHash: hash('reader-token'), scopes: ['posts:read'], createdAtIso: now },
      { id: 'pat_other', customerId: 'cust_b', createdByUserId: 'user_b', name: 'other', tokenPrefix: 'other', tokenHash: hash('other-token'), scopes: ['posts:read', 'posts:write'], createdAtIso: now },
    ],
    customers: [
      { id: 'cust_a', name: 'A' }, { id: 'cust_b', name: 'B' }, { id: 'cust_system', name: 'System', isSystemPrincipal: true },
    ],
    sandboxes: [], agents: [], servicePackages: [], orders: [], profileSlots: [],
    connectedAccounts: [
      { id: 'acct_a', customerId: 'cust_a', platform: 'facebook', zernioAccountId: 'provider_a', zernioProfileId: 'profile_a', handle: '@safe', status: 'connected' },
      { id: 'acct_disabled', customerId: 'cust_a', platform: 'twitter', zernioAccountId: 'provider_disabled', zernioProfileId: 'profile_a', status: 'disconnected' },
      { id: 'acct_b', customerId: 'cust_b', platform: 'instagram', zernioAccountId: 'provider_b', zernioProfileId: 'profile_b', status: 'connected' },
    ],
    socialPosts: [], inboxConversations: [], inboxMessages: [], inboxDraftReplies: [], jobs: [],
    webhookEvents: [], webhookFailures: [], webhookStatus: { enabled: true, consecutiveFailures: 0 }, auditLogs: [], billingPayments: [], checkoutIntents: [], googleOAuthStates: [],
  };
}

async function withApi(run: (baseUrl: string, dbPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'ras-post-core-api-'));
  const dbPath = join(dir, 'store.json'); const port = 20_080 + Math.floor(Math.random() * 1000);
  await writeFile(dbPath, JSON.stringify(state()));
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), RAS_DB_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 5000); child.stdout.on('data', (chunk) => { if (String(chunk).includes('ras-api listening')) { clearTimeout(timer); resolve(); } }); child.on('error', reject); });
    await run(`http://127.0.0.1:${port}`, dbPath);
  } finally { child.kill(); await new Promise<void>((resolve) => child.once('exit', () => resolve())); await rm(dir, { recursive: true, force: true }); }
}

async function apiPost(baseUrl: string, path: string, token: string, key: string | undefined, body: Record<string, unknown>) {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
}

function containsForbidden(value: unknown): boolean {
  const forbidden = /customerId|accountId|profileId|zernio|provider|token|credential|url/i;
  if (Array.isArray(value)) return value.some(containsForbidden);
  if (value && typeof value === 'object') return Object.entries(value).some(([key, child]) => forbidden.test(key) || containsForbidden(child));
  return false;
}

test('Post Core persists one opaque connectionId across store reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-post-core-store-'));
  const dbPath = join(dir, 'store.json');
  try {
    await writeFile(dbPath, JSON.stringify(state()));
    const firstStore = new JsonRasStore(dbPath); await firstStore.migrate(); const first = (await firstStore.load()).connectedAccounts[0]!.publicConnectionId;
    assert.match(String(first), /^conn_[A-Za-z0-9_-]{20,}$/);
    const secondStore = new JsonRasStore(dbPath); await secondStore.migrate(); const second = (await secondStore.load()).connectedAccounts[0]!.publicConnectionId;
    assert.equal(second, first);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Post Core OpenAPI and Agent Tool schemas exactly cover implemented draft capability', async () => {
  const root = process.cwd();
  const openapi = JSON.parse(await readTextFile(join(root, 'docs/POST_V1_OPENAPI.json'), 'utf8')) as { paths: Record<string, unknown> };
  const tools = JSON.parse(await readTextFile(join(root, 'docs/POST_V1_AGENT_TOOLS.json'), 'utf8')) as { tools: Array<{ name: string }> };
  assert.deepEqual(Object.keys(openapi.paths).sort(), [
    '/customers/{customerId}/posts',
    '/customers/{customerId}/posts/capabilities',
    '/customers/{customerId}/posts/drafts',
    '/customers/{customerId}/posts/{postId}',
  ]);
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['ras_posts_create_draft', 'ras_posts_get_draft', 'ras_posts_list_capabilities', 'ras_posts_list_drafts']);
  assert.equal(JSON.stringify({ openapi, tools }).includes('publishNow'), false);
  assert.equal(JSON.stringify({ openapi, tools }).includes('scheduleAtIso'), false);
});

test('Post Core capabilities are customer-safe, stable across restart, and scope protected', async () => {
  await withApi(async (baseUrl) => {
    const unauth = await fetch(`${baseUrl}/customers/cust_a/posts/capabilities`); assert.equal(unauth.status, 401);
    const denied = await fetch(`${baseUrl}/customers/cust_a/posts/capabilities`, { headers: { authorization: 'Bearer writer-token' } }); assert.equal(denied.status, 403);
    const system = await fetch(`${baseUrl}/customers/cust_system/posts/capabilities`, { headers: { authorization: 'Bearer session-system' } }); assert.equal(system.status, 403);
    const first = await fetch(`${baseUrl}/customers/cust_a/posts/capabilities`, { headers: { authorization: 'Bearer reader-token' } }); assert.equal(first.status, 200);
    const payload = await first.json() as { connections: Array<{ connectionId: string; platform: string; availability: boolean; contentLimit: number; allowedModes: string[]; media: { supported: boolean } }> };
    assert.equal(payload.connections.length, 2); assert.match(payload.connections[0]!.connectionId, /^conn_[A-Za-z0-9_-]{20,}$/);
    assert.equal(payload.connections[0]!.platform, 'facebook'); assert.equal(payload.connections[0]!.availability, true); assert.deepEqual(payload.connections[0]!.allowedModes, ['draft']); assert.deepEqual(payload.connections[0]!.media, { supported: false });
    assert.equal(containsForbidden(payload), false);
    const second = await fetch(`${baseUrl}/customers/cust_a/posts/capabilities`, { headers: { authorization: 'Bearer reader-token' } });
    assert.equal((await second.json() as { connections: Array<{ connectionId: string }> }).connections[0]!.connectionId, payload.connections[0]!.connectionId);
  });
});

test('Post Core draft create/list/detail has opaque tenancy, idempotency, media fail-closed, and no job enqueue', async () => {
  await withApi(async (baseUrl, dbPath) => {
    const caps = await fetch(`${baseUrl}/customers/cust_a/posts/capabilities`, { headers: { authorization: 'Bearer reader-token' } });
    const connectionId = (await caps.json() as { connections: Array<{ connectionId: string }> }).connections[0]!.connectionId;
    const missingKey = await apiPost(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', undefined, { connectionId, text: 'hello' }); assert.equal(missingKey.status, 400);
    const wrongScope = await apiPost(baseUrl, '/customers/cust_a/posts/drafts', 'reader-token', 'scope', { connectionId, text: 'hello' }); assert.equal(wrongScope.status, 403);
    const foreign = await apiPost(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'foreign', { connectionId: 'conn_foreign', text: 'hello' }); assert.equal(foreign.status, 404);
    const media = await apiPost(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'media', { connectionId, text: 'hello', media: ['https://example.test/x'] }); assert.equal(media.status, 400);
    const scheduled = await apiPost(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'schedule', { connectionId, text: 'hello', scheduleAtIso: now }); assert.equal(scheduled.status, 400);
    const created = await apiPost(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'draft-1', { connectionId, text: '  hello  ', media: [] }); assert.equal(created.status, 201);
    const first = await created.json() as { post: { postId: string; connectionId: string; text: string; status: string; media: unknown[]; revision: number } };
    assert.match(first.post.postId, /^post_/); assert.equal(first.post.connectionId, connectionId); assert.equal(first.post.text, 'hello'); assert.equal(first.post.status, 'draft'); assert.deepEqual(first.post.media, []); assert.equal(first.post.revision, 1); assert.equal(containsForbidden(first), false);
    const replay = await apiPost(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'draft-1', { connectionId, text: 'hello', media: [] }); assert.equal(replay.status, 200); assert.deepEqual((await replay.json() as { post: unknown }).post, first.post);
    const conflict = await apiPost(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'draft-1', { connectionId, text: 'changed', media: [] }); assert.equal(conflict.status, 409);
    const detail = await fetch(`${baseUrl}/customers/cust_a/posts/${encodeURIComponent(first.post.postId)}`, { headers: { authorization: 'Bearer reader-token' } }); assert.equal(detail.status, 200); assert.deepEqual((await detail.json() as { post: unknown }).post, first.post);
    const cross = await fetch(`${baseUrl}/customers/cust_b/posts/${encodeURIComponent(first.post.postId)}`, { headers: { authorization: 'Bearer other-token' } }); assert.equal(cross.status, 404);
    const list = await fetch(`${baseUrl}/customers/cust_a/posts`, { headers: { authorization: 'Bearer reader-token' } }); assert.equal(list.status, 200); assert.equal((await list.json() as { posts: unknown[] }).posts.length, 1);
    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { socialPosts: unknown[]; jobs: unknown[] }; assert.equal(persisted.socialPosts.length, 1); assert.equal(persisted.jobs.length, 0);
  });
});

test('Post Core enforces platform limits, disconnected capability, and concurrent idempotent draft creation', async () => {
  await withApi(async (baseUrl, dbPath) => {
    const caps = await fetch(`${baseUrl}/customers/cust_a/posts/capabilities`, { headers: { authorization: 'Bearer reader-token' } });
    const connections = (await caps.json() as { connections: Array<{ connectionId: string; platform: string }> }).connections;
    const facebook = connections.find((row) => row.platform === 'facebook')!.connectionId;
    const disconnected = connections.find((row) => row.platform === 'twitter')!.connectionId;
    const unavailable = await apiPost(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'off', { connectionId: disconnected, text: 'hello' }); assert.equal(unavailable.status, 409);
    const tooLong = await apiPost(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'long', { connectionId: facebook, text: 'x'.repeat(63_207) }); assert.equal(tooLong.status, 400);
    const responses = await Promise.all(Array.from({ length: 4 }, () => apiPost(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'concurrent', { connectionId: facebook, text: 'once', media: [] })));
    assert.equal(responses.filter((row) => row.status === 201).length, 1); assert.ok(responses.every((row) => row.status === 200 || row.status === 201));
    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { socialPosts: unknown[]; jobs: unknown[] }; assert.equal(persisted.socialPosts.length, 1); assert.equal(persisted.jobs.length, 0);
  });
});
