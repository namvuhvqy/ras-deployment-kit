import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();

async function withApi<T>(state: Record<string, unknown>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ras-mapping-api-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 19_080 + Math.floor(Math.random() * 1000);
  await writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`);
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), RAS_DB_PATH: dbPath, RAS_INTERNAL_API_TOKEN: 'test-internal-token' },
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
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
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

test('connect endpoint creates another Zernio profile for a second account on the same platform', async () => {
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

  await withApi(state, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/customers/cust_same_platform/connect/facebook?redirectUrl=https://runagentsys.com/dashboard`, { headers: { authorization: 'Bearer token_same' } });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      authUrl: string;
      profileId: string;
      entitlement: { zernioProfileIds: string[]; maxConnectedAccounts: number; activeConnectedAccounts: number };
    };

    assert.equal(payload.profileId, 'zernio_cust_same_platform');
    assert.match(payload.authUrl, /\/connect\/facebook\?/);
    assert.match(payload.authUrl, /profileId=zernio_cust_same_platform/);
    assert.deepEqual(payload.entitlement.zernioProfileIds, ['profile_same_1', 'zernio_cust_same_platform']);
    assert.equal(payload.entitlement.maxConnectedAccounts, 2);
    assert.equal(payload.entitlement.activeConnectedAccounts, 1);
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


test('add-on-only checkout co-terms to active Core and rejects missing/expired Core', async () => {
  const state = emptyState();
  const expiry = new Date(Date.now() + 15 * 86_400_000).toISOString();
  Object.assign(state, {
    users: [{ id: 'user_slots', email: 'slots@example.test', role: 'owner', customerId: 'cust_slots', status: 'active', createdAtIso: now, updatedAtIso: now }],
    sessions: [{ id: 'sess_slots', token: 'token_slots', userId: 'user_slots', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3_600_000).toISOString() }],
    customers: [{ id: 'cust_slots', name: 'Slots', status: 'active', createdAtIso: now, updatedAtIso: now, entitlement: { basePlan: { planId: 'lite', status: 'active', billingCycle: 'monthly', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, expiresAtIso: expiry }, connectSlots: { status: 'active', includedSlots: 1, purchasedSlots: 0, trialSlots: 0, totalSlots: 1, activeConnectedAccounts: 0 }, addOns: [] } }],
  });
  await withApi(state, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/billing/checkout-intents`, { method: 'POST', headers: { authorization: 'Bearer token_slots', 'content-type': 'application/json' }, body: JSON.stringify({ checkout_kind: 'connect_slot_addon', extra_connect_slots: 2 }) });
    assert.equal(created.status, 201);
    const intent = ((await created.json()) as { intent: { amount: string; servicePeriodEndIso: string; collectionMode: string; lineItems: Array<{ sku: string; quantity: number; proration: boolean }> } }).intent;
    assert.equal(intent.servicePeriodEndIso, expiry);
    assert.equal(intent.collectionMode, 'manual');
    assert.equal(intent.lineItems.length, 1);
    assert.equal(intent.lineItems[0]?.sku, 'zernio-connect-slot');
    assert.equal(intent.lineItems[0]?.quantity, 2);
    assert.equal(intent.lineItems[0]?.proration, true);
    assert.ok(Number(intent.amount) > 0 && Number(intent.amount) < 12);
  });

  const expired = emptyState();
  Object.assign(expired, {
    users: [{ id: 'user_expired', email: 'expired@example.test', role: 'owner', customerId: 'cust_expired', status: 'active', createdAtIso: now, updatedAtIso: now }],
    sessions: [{ id: 'sess_expired', token: 'token_expired', userId: 'user_expired', createdAtIso: now, expiresAtIso: new Date(Date.now() + 3_600_000).toISOString() }],
    customers: [{ id: 'cust_expired', name: 'Expired', status: 'active', createdAtIso: now, updatedAtIso: now, entitlement: { basePlan: { planId: 'lite', status: 'active', billingCycle: 'monthly', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, expiresAtIso: new Date(Date.now() - 86_400_000).toISOString() }, connectSlots: { status: 'inactive', includedSlots: 0, purchasedSlots: 0, trialSlots: 0, totalSlots: 0, activeConnectedAccounts: 0 }, addOns: [] } }],
  });
  await withApi(expired, async (baseUrl) => {
    const rejected = await fetch(`${baseUrl}/billing/checkout-intents`, { method: 'POST', headers: { authorization: 'Bearer token_expired', 'content-type': 'application/json' }, body: JSON.stringify({ checkout_kind: 'connect_slot_addon', extra_connect_slots: 1 }) });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json() as { error: string }).error, 'active_core_plan_required');
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
    const ownedRead = await fetch(`${baseUrl}/billing/checkout-intents/${encodeURIComponent(intent.id)}`, { headers: { authorization: 'Bearer token_a' } });
    assert.equal(ownedRead.status, 200);
    assert.equal(((await ownedRead.json()) as { intent: { id: string } }).intent.id, intent.id);
    const bind = await fetch(`${baseUrl}/billing/checkout-intents/bind-paypal-order`, { method: 'POST', headers: { 'x-ras-internal-token': 'test-internal-token', 'content-type': 'application/json' }, body: JSON.stringify({ intent_id: intent.id, customer_id: 'cust_a', paypal_order_id: 'ORDER-INTENT-1' }) });
    assert.equal(bind.status, 200);
    const captured = await fetch(`${baseUrl}/billing/payments/captured`, { method: 'POST', headers: { 'x-ras-internal-token': 'test-internal-token', 'content-type': 'application/json' }, body: JSON.stringify({ intent_id: intent.id, paypal_order_id: 'ORDER-INTENT-1', transaction_id: 'CAP-INTENT-1', captureStatus: 'COMPLETED', total_amount: 1, plan: 'max' }) });
    assert.equal(captured.status, 202);
    const repeated = await fetch(`${baseUrl}/billing/payments/captured`, { method: 'POST', headers: { 'x-ras-internal-token': 'test-internal-token', 'content-type': 'application/json' }, body: JSON.stringify({ intent_id: intent.id, paypal_order_id: 'ORDER-INTENT-1', transaction_id: 'CAP-OTHER', capture_status: 'COMPLETED' }) });
    assert.equal(repeated.status, 409);
  });
});
