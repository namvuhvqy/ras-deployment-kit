import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFile as readTextFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import AjvModule from 'ajv';
import { JsonRasStore } from '../packages/shared/src/persistentStore.js';

const now = new Date().toISOString();
const future = new Date(Date.now() + 60 * 60_000).toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function state() {
  return {
    schemaVersion: 1, migratedAtIso: now,
    users: [
      { id: 'user_system', email: 'system@test.invalid', role: 'owner', customerId: 'cust_system', status: 'active', createdAtIso: now, updatedAtIso: now },
      { id: 'user_tenant_admin', email: 'tenant-admin@test.invalid', role: 'admin', customerId: 'cust_a', status: 'active', createdAtIso: now, updatedAtIso: now },
    ],
    sessions: [
      { id: 'system_session', token: 'system-token', userId: 'user_system', createdAtIso: now, expiresAtIso: future },
      { id: 'tenant_admin_session', token: 'tenant-admin-token', userId: 'user_tenant_admin', createdAtIso: now, expiresAtIso: future },
    ], apiRateLimitBuckets: [],
    personalAccessTokens: [
      { id: 'pat_write', customerId: 'cust_a', createdByUserId: 'user_a', name: 'writer', tokenPrefix: 'writer', tokenHash: hash('writer-token'), scopes: ['posts:write'], createdAtIso: now },
      { id: 'pat_read', customerId: 'cust_a', createdByUserId: 'user_a', name: 'reader', tokenPrefix: 'reader', tokenHash: hash('reader-token'), scopes: ['posts:read'], createdAtIso: now },
      { id: 'pat_other', customerId: 'cust_b', createdByUserId: 'user_b', name: 'other', tokenPrefix: 'other', tokenHash: hash('other-token'), scopes: ['posts:read', 'posts:write'], createdAtIso: now },
    ],
    customers: [{ id: 'cust_a', name: 'A' }, { id: 'cust_b', name: 'B' }],
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

async function withApi(run: (baseUrl: string, dbPath: string) => Promise<void>, env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ras-scheduling-api-'));
  const dbPath = join(dir, 'store.json');
  const port = 20_080 + Math.floor(Math.random() * 1000);
  await writeFile(dbPath, JSON.stringify(state()));
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], { cwd: process.cwd(), env: { ...process.env, ...env, PORT: String(port), RAS_DB_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('Post V1 public contract is session/PAT-derived, opaque, and excludes legacy rows', async () => {
  await withApi(async (baseUrl, dbPath) => {
    const systemPostDenied = await fetch(`${baseUrl}/api/v1/posts/capabilities`, { headers: { authorization: 'Bearer system-token' } }); assert.equal(systemPostDenied.status, 403);
    const tenantAdminGlobalDenied = await fetch(`${baseUrl}/admin/customers`, { headers: { authorization: 'Bearer tenant-admin-token' } }); assert.equal(tenantAdminGlobalDenied.status, 403);
    const tenantAdminPostDenied = await fetch(`${baseUrl}/api/v1/posts/capabilities`, { headers: { authorization: 'Bearer tenant-admin-token' } }); assert.equal(tenantAdminPostDenied.status, 403);
    const legacyTenantAdmin = await fetch(`${baseUrl}/customers/cust_a/posts`, { headers: { authorization: 'Bearer tenant-admin-token' } }); assert.equal(legacyTenantAdmin.status, 200);
    const legacy = await post(baseUrl, '/customers/cust_a/posts/drafts', 'writer-token', 'legacy-v1-isolation', { accountId: 'acct_a', content: 'legacy', mediaUrls: [] });
    assert.equal(legacy.status, 201);
    const unauth = await fetch(`${baseUrl}/api/v1/posts/capabilities`); assert.equal(unauth.status, 401);
    const caps = await fetch(`${baseUrl}/api/v1/posts/capabilities`, { headers: { authorization: 'Bearer reader-token' } }); assert.equal(caps.status, 200);
    const capBody = await caps.json() as { connections: Array<{ connectionId: string; displayLabel: string }> }; const connectionId = capBody.connections[0]!.connectionId;
    assert.equal(capBody.connections[0]!.displayLabel, 'facebook account');
    assert.equal(JSON.stringify(capBody).match(/customerId|accountId|profileId|zernio|provider|token|url/i), null);
    const omittedMedia = await post(baseUrl, '/api/v1/posts/drafts', 'writer-token', 'omitted-media', { connectionId, text: 'safe' }); assert.equal(omittedMedia.status, 400);
    const created = await post(baseUrl, '/api/v1/posts/drafts', 'writer-token', 'public-draft', { connectionId, text: 'safe', media: [] }); assert.equal(created.status, 201);
    const draft = await created.json() as { post: { postId: string } };
    const list = await fetch(`${baseUrl}/api/v1/posts`, { headers: { authorization: 'Bearer reader-token' } }); assert.equal(list.status, 200); assert.equal((await list.json() as { posts: unknown[] }).posts.length, 1);
    const cross = await fetch(`${baseUrl}/api/v1/posts/${encodeURIComponent(draft.post.postId)}`, { headers: { authorization: 'Bearer other-token' } }); assert.equal(cross.status, 404);
    const raw = JSON.parse(await readFile(dbPath, 'utf8')) as { jobs: unknown[] }; assert.equal(raw.jobs.length, 1); // legacy only
  }, { RAS_SYSTEM_ADMIN_USER_IDS: 'user_system' });
});

test('Post V1 OpenAPI validates runtime responses and covers all emitted statuses', async () => {
  const openapi = JSON.parse(await readTextFile(join(process.cwd(), 'docs/POST_V1_OPENAPI.json'), 'utf8'));
  const tools = JSON.parse(await readTextFile(join(process.cwd(), 'docs/POST_V1_AGENT_TOOLS.json'), 'utf8'));
  assert.deepEqual(Object.keys(openapi.paths).sort(), ['/api/v1/posts', '/api/v1/posts/capabilities', '/api/v1/posts/drafts', '/api/v1/posts/{postId}']);
  const serialized = JSON.stringify({ openapi, tools });
  assert.equal(/customerId|tenantId|accountId|profileId|zernio|provider|internal.*url|raw.*error/i.test(serialized), false);
  for (const schema of Object.values(openapi.components.schemas) as Array<Record<string, unknown>>) assert.equal(schema.additionalProperties, false);
  const Ajv = (AjvModule as unknown as { default?: new (options: { strict: boolean }) => { addSchema: (schema: unknown, id: string) => void; compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown } }; }).default ?? AjvModule as unknown as new (options: { strict: boolean }) => { addSchema: (schema: unknown, id: string) => void; compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown } };
  const ajv = new Ajv({ strict: false }); ajv.addSchema({ ...openapi, $id: 'post-v1' }, 'post-v1');
  const validateCapability = ajv.compile({ $ref: 'post-v1#/components/schemas/CapabilitiesEnvelope' });
  const validateDraft = ajv.compile({ $ref: 'post-v1#/components/schemas/PostEnvelope' });
  await withApi(async (baseUrl) => {
    const caps = await fetch(`${baseUrl}/api/v1/posts/capabilities`, { headers: { authorization: 'Bearer reader-token' } });
    const capBody = await caps.json(); assert.equal(caps.status, 200); assert.equal(validateCapability(capBody), true, JSON.stringify(validateCapability.errors));
    const connectionId = capBody.connections[0].connectionId;
    const created = await post(baseUrl, '/api/v1/posts/drafts', 'writer-token', 'schema-draft', { connectionId, text: 'safe', media: [] });
    const postBody = await created.json(); assert.equal(created.status, 201); assert.equal(validateDraft(postBody), true, JSON.stringify(validateDraft.errors));
  });
  const expectedStatuses: Record<string, string[]> = {
    listPostCapabilities: ['200', '401', '403', '429', '503'],
    createDraft: ['200', '201', '400', '401', '403', '404', '409', '429', '503'],
    listDrafts: ['200', '401', '403', '429', '503'],
    getDraft: ['200', '401', '403', '404', '429', '503'],
  };
  for (const operation of Object.values(openapi.paths).flatMap((path: any) => Object.values(path) as any[])) assert.deepEqual(Object.keys(operation.responses).sort(), expectedStatuses[operation.operationId]);
  assert.deepEqual(openapi.components.schemas.Connection.required, ['connectionId', 'displayLabel', 'platform', 'availability', 'contentLimit', 'allowedModes', 'media']);
  assert.deepEqual(openapi.components.schemas.Connection.properties.reasonCode.enum, ['connection_unavailable', 'posting_unavailable']);
  assert.deepEqual(openapi.components.schemas.DraftCreateRequest.required, ['connectionId', 'text', 'media']);
});

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
