import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();

async function withApi<T>(state: Record<string, unknown>, run: (baseUrl: string, dbPath: string) => Promise<T>, environment: NodeJS.ProcessEnv = {}): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ras-mapping-api-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 19_080 + Math.floor(Math.random() * 1000);
  await writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`);
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, PORT: String(port), RAS_DB_PATH: dbPath, RAS_INTERNAL_API_TOKEN: 'test-internal-token', RAS_PAYMENT_RELAY_ASSERTION_SECRET: 'test-relay-assertion-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('ras-api listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
    });
    return await run(`http://127.0.0.1:${port}`, dbPath);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

function relayHeaders(assertion: Record<string, string>): Record<string, string> {
  const canonical = JSON.stringify(assertion);
  return { 'x-ras-internal-token': 'test-internal-token', 'x-ras-relay-assertion-signature': `sha256=${createHmac('sha256', 'test-relay-assertion-secret').update(canonical).digest('hex')}`, 'content-type': 'application/json' };
}

function emptyState(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    migratedAtIso: now,
    users: [],
    sessions: [],
    customers: [],
    sandboxes: [],
    agents: [],
    servicePackages: [],
    connectedAccounts: [],
    jobs: [],
    webhookEvents: [],
    auditLogs: [],
  };
}

test('PayPal sandbox capture rejects malformed JSON before relaying or mutating state', async () => {
  const state = emptyState();
  state.users = [{ id: 'user_payment', email: 'payment@example.test', role: 'owner', customerId: 'cust_payment', status: 'active', createdAtIso: now, updatedAtIso: now }];
  state.sessions = [{ id: 'session_payment', token: 'payment-token', userId: 'user_payment', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3_600_000).toISOString() }];
  state.customers = [{ id: 'cust_payment', name: 'Payment tenant', status: 'active', createdAtIso: now, updatedAtIso: now, maxConnectedAccounts: 1, activeConnectedAccounts: 1, packageStatus: 'active', addOnStatus: { zernio: 'active' } }];
  await withApi(state, async (baseUrl, dbPath) => {
    const response = await fetch(`${baseUrl}/billing/paypal/sandbox/capture`, {
      method: 'POST',
      headers: { authorization: 'Bearer payment-token', 'content-type': 'application/json' },
      body: '{"intent_id":',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'invalid_json' });
    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { checkoutIntents?: unknown[]; auditLogs: unknown[] };
    assert.deepEqual(persisted.checkoutIntents ?? [], []);
    assert.deepEqual(persisted.auditLogs, []);
  });
});

test('captured payment endpoint rejects session callers without the trusted server relay token', async () => {
  const state = emptyState();
  state.customers = [{ id: 'cust_payment', name: 'Payment tenant', status: 'active', maxConnectedAccounts: 1, packageStatus: 'active', addOnStatus: { zernio: 'active' } }];
  await withApi(state, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/billing/payments/captured`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: 'cust_payment', plan: 'lite', billingCycle: 'monthly', extraConnectSlots: 1, totalAmount: 25, paypalOrderId: 'order_1', transactionId: 'capture_1', captureStatus: 'COMPLETED' }),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error: string }).error, 'internal_payment_relay_required');
  });
});

test('retired demo provisioners are inert without authentication, including in live Zernio mode', async () => {
  const state = emptyState();
  await withApi(state, async (baseUrl, dbPath) => {
    for (const route of ['/demo/customer-zernio-profile', '/dry-run/customer']) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId: 'attacker', zernioProfileId: 'provider-profile' }),
      });
      assert.equal(response.status, 410);
      assert.deepEqual(await response.json(), { ok: false, error: 'legacy_demo_provisioning_route_retired' });
    }
    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { customers: unknown[]; auditLogs: unknown[] };
    assert.deepEqual(persisted.customers, []);
    assert.deepEqual(persisted.auditLogs, []);
  }, { ZERNIO_MODE: 'live', ZERNIO_API_KEY: 'test-only-key', ZERNIO_BASE_URL: 'http://127.0.0.1:1' });
});

test('internal access rejects tokens with differing byte lengths without throwing', async () => {
  const state = emptyState();
  await withApi(state, async (baseUrl) => {
    for (const token of ['test', 'test-internal-token-extra']) {
      const response = await fetch(`${baseUrl}/mappings/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ras-internal-token': token },
        body: JSON.stringify({ customerId: 'cust', email: 'user@example.test' }),
      });
      assert.equal(response.status, 401);
    }
  });
});

test('internal user provisioning creates a tenant-bound login identity', async () => {
  const state = emptyState();
  state.customers = [{ id: 'ras-smoke', name: 'RAS Smoke', status: 'active', createdAtIso: now, updatedAtIso: now, maxConnectedAccounts: 1, activeConnectedAccounts: 1, packageStatus: 'active', addOnStatus: { zernio: 'active' } }];
  await withApi(state, async (baseUrl) => {
    const forbidden = await fetch(`${baseUrl}/mappings/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customerId: 'ras-smoke', email: 'inbox-e2e@ras.test', password: 'test-password' }) });
    assert.equal(forbidden.status, 401);
    const provision = await fetch(`${baseUrl}/mappings/users`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ras-internal-token': 'test-internal-token' }, body: JSON.stringify({ customerId: 'ras-smoke', email: 'inbox-e2e@ras.test', displayName: 'Inbox E2E', password: 'test-password' }) });
    assert.equal(provision.status, 201);
    const login = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'inbox-e2e@ras.test', password: 'test-password' }) });
    assert.equal(login.status, 200);
    const token = ((await login.json()) as { token: string }).token;
    const access = await fetch(`${baseUrl}/customers/ras-smoke/inbox/conversations`, { headers: { authorization: `Bearer ${token}` } });
    assert.notEqual(access.status, 401);
    assert.notEqual(access.status, 403);
  });
});

test('customer-scoped read endpoints require a matching session bearer token', async () => {
  const state = emptyState();
  Object.assign(state, {
    users: [
      { id: 'user_a', email: 'a@example.test', role: 'owner', customerId: 'cust_a', status: 'active', createdAtIso: now, updatedAtIso: now },
      { id: 'user_b', email: 'b@example.test', role: 'owner', customerId: 'cust_b', status: 'active', createdAtIso: now, updatedAtIso: now },
    ],
    sessions: [
      { id: 'sess_a', token: 'token_a', userId: 'user_a', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
      { id: 'sess_b', token: 'token_b', userId: 'user_b', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
    ],
    customers: [
      { id: 'cust_a', name: 'A Shop', email: 'a@example.test', status: 'active', createdAtIso: now, updatedAtIso: now, maxConnectedAccounts: 1, activeConnectedAccounts: 1, packageStatus: 'active', addOnStatus: { zernio: 'active' } },
      { id: 'cust_b', name: 'B Shop', email: 'b@example.test', status: 'active', createdAtIso: now, updatedAtIso: now, maxConnectedAccounts: 1, activeConnectedAccounts: 0, packageStatus: 'active', addOnStatus: { zernio: 'active' } },
    ],
    connectedAccounts: [
      { id: 'acct_a_fb', customerId: 'cust_a', platform: 'facebook', zernioAccountId: 'z_fb_a', status: 'connected', connectedAtIso: now, lastVerifiedAtIso: now },
    ],
  });

  await withApi(state, async (baseUrl) => {
    const noBearer = await fetch(`${baseUrl}/customers/cust_a/connection-summary`);
    assert.equal(noBearer.status, 401);

    const crossCustomer = await fetch(`${baseUrl}/customers/cust_a/connection-summary`, { headers: { authorization: 'Bearer token_b' } });
    assert.equal(crossCustomer.status, 403);

    const ownCustomer = await fetch(`${baseUrl}/customers/cust_a/connection-summary`, { headers: { authorization: 'Bearer token_a' } });
    assert.equal(ownCustomer.status, 200);
    const payload = (await ownCustomer.json()) as { integrations: Array<{ platform: string; connected: boolean }> };
    assert.deepEqual(payload.integrations, [{ id: 'acct_a_fb', platform: 'facebook', connected: true, needsReconnection: false, lastVerifiedAt: now, accountId: 'z_fb_a', username: null, capabilities: [] }]);
  });
});

test('inbox read APIs are tenant-scoped and never expose another customer messages', async () => {
  const state = emptyState();
  Object.assign(state, {
    users: [
      { id: 'user_a', email: 'a@example.test', role: 'owner', customerId: 'cust_a', status: 'active', createdAtIso: now, updatedAtIso: now },
      { id: 'user_b', email: 'b@example.test', role: 'owner', customerId: 'cust_b', status: 'active', createdAtIso: now, updatedAtIso: now },
    ],
    sessions: [
      { id: 'sess_a', token: 'token_a', userId: 'user_a', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
      { id: 'sess_b', token: 'token_b', userId: 'user_b', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
    ],
    customers: [{ id: 'cust_a', name: 'A', status: 'active' }, { id: 'cust_b', name: 'B', status: 'active' }],
    inboxConversations: [{ id: 'conv_a', customerId: 'cust_a', accountId: 'acct_a', platform: 'facebook', providerConversationId: 'conv_a', status: 'open', lastMessageAtIso: now, unreadCount: 1, createdAtIso: now, updatedAtIso: now }],
    inboxMessages: [{ id: 'msg_a', customerId: 'cust_a', accountId: 'acct_a', platform: 'facebook', conversationId: 'conv_a', providerMessageId: 'provider_a', direction: 'inbound', text: 'Riêng tư', receivedAtIso: now, createdAtIso: now }],
  });
  await withApi(state, async (baseUrl) => {
    const own = await fetch(`${baseUrl}/customers/cust_a/inbox/conversations`, { headers: { authorization: 'Bearer token_a' } });
    assert.equal(own.status, 200);
    const ownPayload = (await own.json()) as { mode: string; conversations: Array<{ id: string }> };
    assert.equal(ownPayload.mode, 'draft_only');
    assert.deepEqual(ownPayload.conversations.map((row) => row.id), ['conv_a']);
    const messages = await fetch(`${baseUrl}/customers/cust_a/inbox/conversations/conv_a/messages`, { headers: { authorization: 'Bearer token_a' } });
    assert.equal(messages.status, 200);
    assert.deepEqual((await messages.json() as { messages: Array<{ text: string }> }).messages.map((row) => row.text), ['Riêng tư']);
    const cross = await fetch(`${baseUrl}/customers/cust_a/inbox/conversations`, { headers: { authorization: 'Bearer token_b' } });
    assert.equal(cross.status, 403);
  });
});

test('inbox draft endpoint creates a tenant-scoped pending-review reply and rejects cross-tenant access', async () => {
  const state = emptyState();
  Object.assign(state, {
    users: [
      { id: 'user_a', email: 'a@example.test', role: 'owner', customerId: 'cust_a', status: 'active', createdAtIso: now, updatedAtIso: now },
      { id: 'user_b', email: 'b@example.test', role: 'owner', customerId: 'cust_b', status: 'active', createdAtIso: now, updatedAtIso: now },
    ],
    sessions: [
      { id: 'sess_a', token: 'token_a', userId: 'user_a', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
      { id: 'sess_b', token: 'token_b', userId: 'user_b', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
    ],
    customers: [{ id: 'cust_a', name: 'A', status: 'active' }, { id: 'cust_b', name: 'B', status: 'active' }],
    inboxConversations: [{ id: 'conv_a', customerId: 'cust_a', accountId: 'acct_a', platform: 'facebook', providerConversationId: 'conv_a', status: 'open', lastMessageAtIso: now, unreadCount: 1, createdAtIso: now, updatedAtIso: now }],
  });
  await withApi(state, async (baseUrl) => {
    const own = await fetch(`${baseUrl}/customers/cust_a/inbox/conversations/conv_a/drafts`, {
      method: 'POST', headers: { authorization: 'Bearer token_a', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Em hỗ trợ anh ngay ạ.' }),
    });
    assert.equal(own.status, 201);
    const payload = (await own.json()) as { mode: string; draft: { status: string; text: string; sendAttempted: boolean } };
    assert.equal(payload.mode, 'draft_only');
    assert.equal(payload.draft.status, 'pending_review');
    assert.equal(payload.draft.text, 'Em hỗ trợ anh ngay ạ.');
    assert.equal(payload.draft.sendAttempted, false);
    const cross = await fetch(`${baseUrl}/customers/cust_a/inbox/conversations/conv_a/drafts`, {
      method: 'POST', headers: { authorization: 'Bearer token_b', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Không được phép' }),
    });
    assert.equal(cross.status, 403);
  });
});

test('inbox approval queues exactly one reply job and preserves cross-tenant denial', async () => {
  const state = emptyState();
  Object.assign(state, {
    users: [
      { id: 'user_a', email: 'a@example.test', role: 'owner', customerId: 'cust_a', status: 'active', createdAtIso: now, updatedAtIso: now },
      { id: 'user_b', email: 'b@example.test', role: 'owner', customerId: 'cust_b', status: 'active', createdAtIso: now, updatedAtIso: now },
    ],
    sessions: [
      { id: 'sess_a', token: 'token_a', userId: 'user_a', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
      { id: 'sess_b', token: 'token_b', userId: 'user_b', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
    ],
    customers: [{ id: 'cust_a', name: 'A', status: 'active' }, { id: 'cust_b', name: 'B', status: 'active' }],
    inboxConversations: [{ id: 'conv_a', customerId: 'cust_a', accountId: 'acct_a', platform: 'facebook', providerConversationId: 'conv_a', status: 'open', lastMessageAtIso: now, unreadCount: 1, createdAtIso: now, updatedAtIso: now }],
    inboxDraftReplies: [{ id: 'draft_a', customerId: 'cust_a', conversationId: 'conv_a', text: 'Đã duyệt', status: 'pending_review', sendAttempted: false, createdByUserId: 'user_a', createdAtIso: now }],
  });
  await withApi(state, async (baseUrl) => {
    const approved = await fetch(`${baseUrl}/customers/cust_a/inbox/drafts/draft_a/approve`, { method: 'POST', headers: { authorization: 'Bearer token_a' } });
    assert.equal(approved.status, 202);
    const result = (await approved.json()) as { draft: { status: string; approvedByUserId: string }; job: { type: string; status: string } };
    assert.equal(result.draft.status, 'queued');
    assert.equal(result.draft.approvedByUserId, 'user_a');
    assert.deepEqual(result.job, { type: 'inbox_reply', status: 'queued' });
    const second = await fetch(`${baseUrl}/customers/cust_a/inbox/drafts/draft_a/approve`, { method: 'POST', headers: { authorization: 'Bearer token_a' } });
    assert.equal(second.status, 409);
    const cross = await fetch(`${baseUrl}/customers/cust_a/inbox/drafts/draft_a/approve`, { method: 'POST', headers: { authorization: 'Bearer token_b' } });
    assert.equal(cross.status, 403);
  });
});

test('mapping endpoints create tenant/customer/profile/account links without root profileId account scope', async () => {
  const state = emptyState();
  state.users = [
    { id: 'user_acme', email: 'owner@acme.test', displayName: 'Acme Owner', role: 'owner', customerId: 'cust_1', status: 'active', createdAtIso: now, updatedAtIso: now },
  ];
  state.sessions = [
    { id: 'sess_acme', token: 'token_acme', userId: 'user_acme', createdAtIso: now, expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
  ];
  await withApi(state, async (baseUrl) => {
    const customerResponse = await fetch(`${baseUrl}/mappings/customers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ras-internal-token': 'test-internal-token' },
      body: JSON.stringify({
        customerId: 'cust_1',
        tenantId: 'tenant_acme',
        name: 'Acme Shop',
        email: 'owner@acme.test',
        zernioProfileId: 'profile_zernio_1',
      }),
    });
    assert.equal(customerResponse.status, 201);
    const customerPayload = (await customerResponse.json()) as {
      mapping: { customerId: string; tenantId: string; zernioProfileId: string };
    };
    assert.deepEqual(customerPayload.mapping, {
      customerId: 'cust_1',
      tenantId: 'tenant_acme',
      zernioProfileId: 'profile_zernio_1',
    });

    const accountResponse = await fetch(`${baseUrl}/mappings/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ras-internal-token': 'test-internal-token' },
      body: JSON.stringify({
        accountId: 'acct_local_1',
        customerId: 'cust_1',
        platform: 'facebook',
        zernioProfileId: 'profile_zernio_1',
        zernioAccountId: 'social_account_1',
        handle: '@acme',
        username: 'acme',
        status: 'connected',
        connectedAtIso: now,
        lastVerifiedAtIso: now,
      }),
    });
    assert.equal(accountResponse.status, 201);
    const accountPayload = (await accountResponse.json()) as {
      mapping: { accountId: string; customerId: string; platform: string; zernioAccountId: string; createPostScope: unknown };
    };
    assert.deepEqual(accountPayload.mapping.createPostScope, {
      platforms: [{ platform: 'facebook', accountId: 'social_account_1' }],
    });

    const summaryResponse = await fetch(`${baseUrl}/mappings/customers/cust_1`, { headers: { authorization: 'Bearer token_acme' } });
    assert.equal(summaryResponse.status, 200);
    const summary = (await summaryResponse.json()) as {
      mapping: {
        tenantId: string;
        customerId: string;
        zernioProfileId: string;
        accounts: Array<{ accountId: string; zernioAccountId: string; createPostScope: unknown; profileId?: string }>;
      };
    };
    assert.equal(summary.mapping.tenantId, 'tenant_acme');
    assert.equal(summary.mapping.customerId, 'cust_1');
    assert.equal(summary.mapping.zernioProfileId, 'profile_zernio_1');
    assert.equal(summary.mapping.accounts.length, 1);
    assert.equal(summary.mapping.accounts[0].accountId, 'acct_local_1');
    assert.equal(summary.mapping.accounts[0].zernioAccountId, 'social_account_1');
    assert.equal(summary.mapping.accounts[0].profileId, undefined);
    assert.deepEqual(summary.mapping.accounts[0].createPostScope, {
      platforms: [{ platform: 'facebook', accountId: 'social_account_1' }],
    });
  });
});

test('billing entitlement provisioning rejects direct session activation', async () => {
  const state = emptyState();
  state.customers = [
    {
      id: 'cust_entitled',
      name: 'Entitled Shop',
      email: 'owner@entitled.test',
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    },
  ];
  state.users = [
    {
      id: 'user_entitled',
      email: 'owner@entitled.test',
      displayName: 'Entitled Owner',
      role: 'owner',
      customerId: 'cust_entitled',
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    },
  ];
  state.sessions = [
    {
      id: 'sess_entitled',
      token: 'token_entitled',
      userId: 'user_entitled',
      expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      createdAtIso: now,
    },
  ];

  await withApi(state, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/billing/entitlements/provision`, {
      method: 'POST',
      headers: { authorization: 'Bearer token_entitled', 'content-type': 'application/json' },
      body: JSON.stringify({
        plan: 'pro',
        billing_cycle: 'monthly',
        extra_connect_slots: 2,
        total_amount: 51,
      }),
    });

    assert.equal(response.status, 410);
    assert.equal((await response.json() as { error: string }).error, 'payment_capture_required');
  });
});

test('billing entitlement provisioning rejects alias payloads from direct session activation', async () => {
  const state = emptyState();
  state.customers = [
    {
      id: 'cust_alias',
      name: 'Alias Shop',
      email: 'alias@example.test',
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    },
  ];
  state.users = [
    {
      id: 'user_alias',
      email: 'alias@example.test',
      displayName: 'Alias Owner',
      role: 'owner',
      customerId: 'cust_alias',
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    },
  ];
  state.sessions = [
    {
      id: 'sess_alias',
      token: 'token_alias',
      userId: 'user_alias',
      expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      createdAtIso: now,
    },
  ];

  await withApi(state, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/billing/entitlements/provision`, {
      method: 'POST',
      headers: { authorization: 'Bearer token_alias', 'content-type': 'application/json' },
      body: JSON.stringify({
        plan_id: 'lite',
        billing_cycle: 'yearly',
        connect_slots: 4,
        amount: 480,
      }),
    });

    assert.equal(response.status, 410);
    assert.equal((await response.json() as { error: string }).error, 'payment_capture_required');
  });
});

test('lead sessions cannot bootstrap trial or personal access tokens, but can create a lead-bound checkout intent', async () => {
  const state = emptyState();
  Object.assign(state, {
    users: [{ id: 'lead_1', email: 'lead@example.test', role: 'owner', status: 'active', createdAtIso: now, updatedAtIso: now }],
    sessions: [{ id: 'sess_lead', token: 'token_lead', userId: 'lead_1', createdAtIso: now, expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString() }],
  });
  await withApi(state, async (baseUrl) => {
    const headers = { authorization: 'Bearer token_lead', 'content-type': 'application/json' };
    const trial = await fetch(`${baseUrl}/billing/entitlements/activate-trial`, { method: 'POST', headers });
    assert.equal(trial.status, 403);
    assert.equal((await trial.json() as { error: string }).error, 'tenant_required');
    const checkout = await fetch(`${baseUrl}/billing/checkout-intents`, { method: 'POST', headers, body: JSON.stringify({ plan: 'lite', extra_connect_slots: 0, customer_id: 'forged', amount: 1 }) });
    assert.equal(checkout.status, 201);
    const intent = (await checkout.json() as { intent: { id: string; customerId?: string; purchaserUserId?: string; purchaserEmail?: string; amount: string } }).intent;
    assert.equal(intent.customerId, undefined);
    assert.equal(intent.purchaserUserId, 'lead_1');
    assert.equal(intent.purchaserEmail, 'lead@example.test');
    assert.equal(intent.amount, '19');
    const pat = await fetch(`${baseUrl}/api/v1/personal-access-tokens`, { method: 'POST', headers, body: JSON.stringify({ name: 'no-tenant', scopes: ['accounts:read'] }) });
    assert.equal(pat.status, 401);
    const persisted = JSON.parse(await (await fetch(`${baseUrl}/health`)).text()) as { counts: { customers: number; jobs: number } };
    assert.deepEqual(persisted.counts, { customers: 0, sandboxes: 0, agents: 0, servicePackages: 0, connectedAccounts: 0, jobs: 0 });
  });
});

test('trusted relay capture binds a lead once, records durable outbox, and does not provision Zernio in capture', async () => {
  const state = emptyState();
  Object.assign(state, {
    users: [{ id: 'lead_capture', email: 'capture@example.test', displayName: 'Capture Lead', role: 'owner', status: 'active', createdAtIso: now, updatedAtIso: now }],
    sessions: [{ id: 'sess_capture', token: 'token_capture', userId: 'lead_capture', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() }],
  });
  await withApi(state, async (baseUrl) => {
    const headers = { authorization: 'Bearer token_capture', 'content-type': 'application/json' };
    const created = await fetch(`${baseUrl}/billing/checkout-intents`, { method: 'POST', headers, body: JSON.stringify({ plan: 'pro', billing_cycle: 'monthly', extra_connect_slots: 2, customer_id: 'attacker', amount: 0 }) });
    assert.equal(created.status, 201);
    const intent = (await created.json() as { intent: { id: string } }).intent;
    const browserCapture = await fetch(`${baseUrl}/billing/payments/captured`, { method: 'POST', headers, body: JSON.stringify({ intent_id: intent.id, paypal_order_id: 'ORDER-LEAD-1', transaction_id: 'CAP-LEAD-1', capture_status: 'COMPLETED' }) });
    assert.equal(browserCapture.status, 401);
    const bind = await fetch(`${baseUrl}/billing/checkout-intents/bind-paypal-order`, { method: 'POST', headers: { 'x-ras-internal-token': 'test-internal-token', 'content-type': 'application/json' }, body: JSON.stringify({ intent_id: intent.id, customer_id: 'attacker', paypal_order_id: 'ORDER-LEAD-1' }) });
    assert.equal(bind.status, 409);
    const trustedBind = await fetch(`${baseUrl}/billing/checkout-intents/bind-paypal-order`, { method: 'POST', headers: { 'x-ras-internal-token': 'test-internal-token', 'content-type': 'application/json' }, body: JSON.stringify({ intent_id: intent.id, paypal_order_id: 'ORDER-LEAD-1' }) });
    assert.equal(trustedBind.status, 200);
    const relay_assertion = { intentId: intent.id, paypalOrderId: 'ORDER-LEAD-1', transactionId: 'CAP-LEAD-1', amount: '51', currency: 'USD', status: 'COMPLETED', issuedAtIso: new Date().toISOString(), expiresAtIso: new Date(Date.now() + 60_000).toISOString(), nonce: 'lead-capture-nonce' };
    const captureBody = { intent_id: intent.id, paypal_order_id: 'ORDER-LEAD-1', transaction_id: 'CAP-LEAD-1', capture_status: 'COMPLETED', relay_assertion };
    const captured = await fetch(`${baseUrl}/billing/payments/captured`, { method: 'POST', headers: relayHeaders(relay_assertion), body: JSON.stringify(captureBody) });
    assert.equal(captured.status, 202);
    const payload = await captured.json() as { customerId: string; provisioning: { queued: boolean } };
    assert.equal(payload.provisioning.queued, true);
    const replay = await fetch(`${baseUrl}/billing/payments/captured`, { method: 'POST', headers: relayHeaders(relay_assertion), body: JSON.stringify(captureBody) });
    assert.equal(replay.status, 202);
    assert.equal((await replay.json() as { provisioning: { queued: boolean } }).provisioning.queued, false);
    const dashboard = await fetch(`${baseUrl}/dashboard`, { headers: { authorization: 'Bearer token_capture' } });
    const dashboardPayload = await dashboard.json() as { dashboard: { state: string; customer: { id: string; zernioProfileId?: string } } };
    assert.equal(dashboardPayload.dashboard.state, 'needs_plan');
    assert.equal(dashboardPayload.dashboard.customer.id, payload.customerId);
    assert.equal(dashboardPayload.dashboard.customer.zernioProfileId, undefined);
  });
});

test('authenticated trial activation grants base entitlement without enabling Zernio slots', async () => {
  const state = emptyState();
  state.customers = [
    {
      id: 'cust_trial',
      name: 'Trial Shop',
      email: 'owner@trial.test',
      status: 'pending',
      createdAtIso: now,
      updatedAtIso: now,
    },
  ];
  state.users = [
    {
      id: 'user_trial',
      email: 'owner@trial.test',
      displayName: 'Trial Owner',
      role: 'owner',
      customerId: 'cust_trial',
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    },
  ];
  state.sessions = [
    {
      id: 'sess_trial',
      token: 'token_trial',
      userId: 'user_trial',
      expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      createdAtIso: now,
    },
  ];

  await withApi(state, async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/billing/entitlements/activate-trial`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${baseUrl}/billing/entitlements/activate-trial`, {
      method: 'POST',
      headers: { authorization: 'Bearer token_trial' },
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      entitlement: {
        customerId: string;
        maxConnectedAccounts: number;
        activeConnectedAccounts: number;
        packageStatus: string;
        addOnStatus: Record<string, string>;
        zernioProfileIds: string[];
      };
    };

    assert.equal(payload.entitlement.customerId, 'cust_trial');
    assert.equal(payload.entitlement.maxConnectedAccounts, 0);
    assert.equal(payload.entitlement.activeConnectedAccounts, 0);
    assert.equal(payload.entitlement.packageStatus, 'active');
    assert.equal(payload.entitlement.addOnStatus.zernio, 'inactive');
    assert.deepEqual(payload.entitlement.zernioProfileIds, []);
  });
});

test('connect endpoint enforces RAS quota before returning Zernio OAuth URL', async () => {
  const state = emptyState();
  state.customers = [
    {
      id: 'cust_quota',
      name: 'Quota Shop',
      email: 'owner@quota.test',
      zernioProfileId: 'profile_quota_1',
      zernioProfileIds: ['profile_quota_1'],
      maxConnectedAccounts: 1,
      packageStatus: 'active',
      addOnStatus: { zernio: 'active' },
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    },
  ];
  state.connectedAccounts = [
    {
      id: 'acct_existing',
      customerId: 'cust_quota',
      platform: 'facebook',
      zernioProfileId: 'profile_quota_1',
      zernioAccountId: 'social_existing',
      status: 'connected',
      connectedAtIso: now,
      lastVerifiedAtIso: now,
    },
  ];
  state.users = [
    { id: 'user_quota', email: 'owner@quota.test', displayName: 'Quota Owner', role: 'owner', customerId: 'cust_quota', status: 'active', createdAtIso: now, updatedAtIso: now },
  ];
  state.sessions = [
    { id: 'sess_quota', token: 'token_quota', userId: 'user_quota', createdAtIso: now, expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
  ];

  await withApi(state, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/customers/cust_quota/connect/instagram`, { headers: { authorization: 'Bearer token_quota' } });
    assert.equal(response.status, 409);
    const payload = (await response.json()) as { error: string; entitlement: { maxConnectedAccounts: number; activeConnectedAccounts: number } };
    assert.equal(payload.error, 'connection_quota_exceeded');
    assert.equal(payload.entitlement.maxConnectedAccounts, 1);
    assert.equal(payload.entitlement.activeConnectedAccounts, 1);
  });
});

test('Facebook Page selection endpoints are tenant-scoped and fail closed without OAuth data', async () => {
  const state = emptyState();
  Object.assign(state, {
    users: [
      { id: 'user_a', email: 'a@example.test', role: 'owner', customerId: 'cust_a', status: 'active', createdAtIso: now, updatedAtIso: now },
      { id: 'user_b', email: 'b@example.test', role: 'owner', customerId: 'cust_b', status: 'active', createdAtIso: now, updatedAtIso: now },
    ],
    sessions: [
      { id: 'sess_a', token: 'token_a', userId: 'user_a', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
      { id: 'sess_b', token: 'token_b', userId: 'user_b', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() },
    ],
    customers: [{ id: 'cust_a', name: 'A', status: 'active', zernioProfileId: 'profile_a', zernioProfileIds: ['profile_a'], maxConnectedAccounts: 1, activeConnectedAccounts: 0, packageStatus: 'active', addOnStatus: { zernio: 'active' } }],
  });
  await withApi(state, async (baseUrl) => {
    const missingSession = await fetch(`${baseUrl}/customers/cust_a/connect/facebook/pages?tempToken=temporary`);
    assert.equal(missingSession.status, 401);
    const crossTenant = await fetch(`${baseUrl}/customers/cust_a/connect/facebook/pages?tempToken=temporary`, { headers: { authorization: 'Bearer token_b' } });
    assert.equal(crossTenant.status, 403);
    const missingToken = await fetch(`${baseUrl}/customers/cust_a/connect/facebook/pages`, { headers: { authorization: 'Bearer token_a' } });
    assert.equal(missingToken.status, 400);
    assert.equal((await missingToken.json() as { error: string }).error, 'missing_facebook_oauth_tokens');
    const missingSelection = await fetch(`${baseUrl}/customers/cust_a/connect/facebook/pages/select`, { method: 'POST', headers: { authorization: 'Bearer token_a', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missingSelection.status, 400);
    assert.equal((await missingSelection.json() as { error: string }).error, 'missing_facebook_page_selection_fields');
  });
});

test('Facebook Page selection forwards a valid provider userProfile object without requiring example id/name fields', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile('apps/ras-api/src/server.ts', 'utf8'));
  assert.doesNotMatch(source, /!userId \|\| !userName/);
  assert.match(source, /connectToken,\s*\n\s*userProfile,/);
});

test('disconnect endpoint is tenant-scoped and delegates provider deletion before local disconnection', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const source = await readFile(join(process.cwd(), 'apps/ras-api/src/server.ts'), 'utf8');
  const adapterSource = await readFile(join(process.cwd(), 'packages/zernio-adapter/src/index.ts'), 'utf8');
  assert.match(source, /req\.method === 'DELETE'.*\/connections\//s);
  assert.match(source, /requireCustomerAccess\(req, customerId, 'accounts:connect'\)/);
  assert.match(source, /account\.customerId !== customerId/);
  assert.match(source, /adapter\.disconnectAccount\(account\.zernioAccountId\)/);
  assert.match(source, /status: 'disconnected'/);
  assert.match(adapterSource, /disconnectAccount\(accountId: string\)/);
  assert.match(adapterSource, /method: 'DELETE'/);
});

test('connect endpoint queues one worker-only Zernio profile provision for a second same-platform account', async () => {
  const state = emptyState();
  state.customers = [
    {
      id: 'cust_same_platform',
      name: 'Same Platform Shop',
      email: 'owner@same.test',
      zernioProfileId: 'profile_same_1',
      zernioProfileIds: ['profile_same_1'],
      maxConnectedAccounts: 2,
      packageStatus: 'active',
      addOnStatus: { zernio: 'active' },
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    },
  ];
  state.connectedAccounts = [
    {
      id: 'acct_fb_1',
      customerId: 'cust_same_platform',
      platform: 'facebook',
      zernioProfileId: 'profile_same_1',
      zernioAccountId: 'social_fb_1',
      status: 'connected',
      connectedAtIso: now,
      lastVerifiedAtIso: now,
    },
  ];
  state.users = [
    { id: 'user_same', email: 'owner@same.test', displayName: 'Same Owner', role: 'owner', customerId: 'cust_same_platform', status: 'active', createdAtIso: now, updatedAtIso: now },
  ];
  state.sessions = [
    { id: 'sess_same', token: 'token_same', userId: 'user_same', createdAtIso: now, expiresAtIso: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
  ];

  await withApi(state, async (baseUrl, dbPath) => {
    const response = await fetch(`${baseUrl}/customers/cust_same_platform/connect/facebook?redirectUrl=https://runagentsys.com/dashboard`, { headers: { authorization: 'Bearer token_same' } });
    assert.equal(response.status, 202);
    const payload = (await response.json()) as {
      error: string;
      provisioning: { queued: boolean; jobId: string; reason: string; platform: string };
      entitlement: { zernioProfileIds: string[]; maxConnectedAccounts: number; activeConnectedAccounts: number };
    };

    assert.equal(payload.error, 'profile_provisioning_pending');
    assert.deepEqual(payload.provisioning, { queued: true, jobId: 'provision_profile:cust_same_platform:facebook:same_platform_connect', reason: 'same_platform_connect', platform: 'facebook' });
    assert.deepEqual(payload.entitlement.zernioProfileIds, ['profile_same_1']);
    assert.equal(payload.entitlement.maxConnectedAccounts, 2);
    assert.equal(payload.entitlement.activeConnectedAccounts, 1);
    const retry = await fetch(`${baseUrl}/customers/cust_same_platform/connect/facebook`, { headers: { authorization: 'Bearer token_same' } });
    assert.equal(retry.status, 202);
    assert.equal((await retry.json() as { provisioning: { queued: boolean } }).provisioning.queued, false);
    const persisted = JSON.parse(await readFile(dbPath, 'utf8')) as { jobs: Array<{ id: string; customerId: string; platform: string; type: string; status: string; payload: Record<string, unknown> }> };
    assert.equal(persisted.jobs.length, 1, 'duplicate API requests queue at most one durable request');
    assert.deepEqual(persisted.jobs[0] && { id: persisted.jobs[0].id, customerId: persisted.jobs[0].customerId, platform: persisted.jobs[0].platform, type: persisted.jobs[0].type, status: persisted.jobs[0].status, payload: persisted.jobs[0].payload }, { id: 'provision_profile:cust_same_platform:facebook:same_platform_connect', customerId: 'cust_same_platform', platform: 'facebook', type: 'create_profile', status: 'queued', payload: { reason: 'same_platform_connect', platform: 'facebook' } }, 'API queues a tenant/platform-scoped request and never creates a provider profile');
    const worker = spawn(process.execPath, ['dist/apps/ras-worker/src/worker.js'], { cwd: process.cwd(), env: { ...process.env, RAS_DB_PATH: dbPath, RAS_WORKER_SINGLE_RUN: 'true' }, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { worker.once('error', reject); worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))); });
    const ready = await fetch(`${baseUrl}/customers/cust_same_platform/connect/facebook`, { headers: { authorization: 'Bearer token_same' } });
    assert.equal(ready.status, 200);
    const readyPayload = await ready.json() as { authUrl: string; profileId: string };
    assert.equal(readyPayload.profileId, 'zernio_cust_same_platform');
    assert.match(readyPayload.authUrl, /profileId=zernio_cust_same_platform/);
  });
});

test('account mapping rejects unknown customer and mismatched zernio profile', async () => {
  const state = emptyState();
  state.customers = [
    {
      id: 'cust_1',
      name: 'Acme Shop',
      zernioProfileId: 'profile_zernio_1',
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    },
  ];

  await withApi(state, async (baseUrl) => {
    const missingCustomer = await fetch(`${baseUrl}/mappings/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ras-internal-token': 'test-internal-token' },
      body: JSON.stringify({
        accountId: 'acct_missing',
        customerId: 'missing',
        platform: 'facebook',
        zernioProfileId: 'profile_zernio_1',
        zernioAccountId: 'social_account_1',
      }),
    });
    assert.equal(missingCustomer.status, 404);

    const mismatchedProfile = await fetch(`${baseUrl}/mappings/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ras-internal-token': 'test-internal-token' },
      body: JSON.stringify({
        accountId: 'acct_bad_profile',
        customerId: 'cust_1',
        platform: 'facebook',
        zernioProfileId: 'other_profile',
        zernioAccountId: 'social_account_1',
      }),
    });
    assert.equal(mismatchedProfile.status, 409);
    const payload = (await mismatchedProfile.json()) as { error: string };
    assert.equal(payload.error, 'zernio_profile_mismatch');
  });
});


test('checkout capture uses an owned bound intent rather than relay supplied price fields', async () => {
  const state = emptyState();
  Object.assign(state, {
    users: [{ id: 'user_a', email: 'a@example.test', role: 'owner', customerId: 'cust_a', status: 'active', createdAtIso: now, updatedAtIso: now }],
    sessions: [{ id: 'sess_a', token: 'token_a', userId: 'user_a', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3600000).toISOString() }],
    customers: [{ id: 'cust_a', name: 'A', status: 'active', createdAtIso: now, updatedAtIso: now, maxConnectedAccounts: 0, packageStatus: 'active', addOnStatus: {} }],
  });
  await withApi(state, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/billing/checkout-intents`, { method: 'POST', headers: { authorization: 'Bearer token_a', 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'lite', billing_cycle: 'monthly', extra_connect_slots: 1 }) });
    assert.equal(created.status, 201);
    const intent = ((await created.json()) as { intent: { id: string; amount: string } }).intent;
    assert.equal(intent.amount, '25');
    const bind = await fetch(`${baseUrl}/billing/checkout-intents/bind-paypal-order`, { method: 'POST', headers: { 'x-ras-internal-token': 'test-internal-token', 'content-type': 'application/json' }, body: JSON.stringify({ intent_id: intent.id, customer_id: 'cust_a', paypal_order_id: 'ORDER-INTENT-1' }) });
    assert.equal(bind.status, 200);
    const relay_assertion = { intentId: intent.id, paypalOrderId: 'ORDER-INTENT-1', transactionId: 'CAP-INTENT-1', amount: '25', currency: 'USD', status: 'COMPLETED', issuedAtIso: new Date().toISOString(), expiresAtIso: new Date(Date.now() + 60_000).toISOString(), nonce: 'tenant-capture-nonce' };
    const captured = await fetch(`${baseUrl}/billing/payments/captured`, { method: 'POST', headers: relayHeaders(relay_assertion), body: JSON.stringify({ intent_id: intent.id, paypal_order_id: 'ORDER-INTENT-1', transaction_id: 'CAP-INTENT-1', captureStatus: 'COMPLETED', total_amount: 1, plan: 'max', relay_assertion }) });
    assert.equal(captured.status, 202);
    const repeated = await fetch(`${baseUrl}/billing/payments/captured`, { method: 'POST', headers: { 'x-ras-internal-token': 'test-internal-token', 'content-type': 'application/json' }, body: JSON.stringify({ intent_id: intent.id, paypal_order_id: 'ORDER-INTENT-1', transaction_id: 'CAP-OTHER', capture_status: 'COMPLETED' }) });
    assert.equal(repeated.status, 401);
  });
});
