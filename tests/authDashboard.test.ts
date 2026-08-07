import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRasStore } from '../packages/shared/src/persistentStore.js';

const now = new Date(0).toISOString();

test('dashboard requires a valid session token and returns tenant control panel data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-auth-dashboard-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();

    await store.upsertUser({
      id: 'user_1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
      customerId: 'cust_1',
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    });
    await store.upsertCustomer({ id: 'cust_1', name: 'Shop Demo', status: 'active', createdAtIso: now });
    await store.upsertSandbox({
      id: 'sandbox_1',
      customerId: 'cust_1',
      provider: 'vps',
      status: 'running',
      endpoint: 'https://tenant.example.test',
      createdAtIso: now,
      updatedAtIso: now,
    });
    await store.upsertAgent({
      id: 'agent_1',
      customerId: 'cust_1',
      sandboxId: 'sandbox_1',
      kind: 'ras1-hermes',
      status: 'running',
      updatedAtIso: now,
    });

    const session = await store.createSession({ userId: 'user_1', ttlMs: 60_000, nowIso: now });
    assert.equal(await store.getDashboardForSession('missing'), undefined);

    const dashboard = await store.getDashboardForSession(session.token, now);
    assert.equal(dashboard?.user.email, 'owner@example.com');
    assert.equal(dashboard?.customer.id, 'cust_1');
    assert.equal(dashboard?.sandboxes[0].status, 'running');
    assert.equal(dashboard?.agents[0].kind, 'ras1-hermes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dashboard summary is tenant-scoped and preserves needs-plan defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-dashboard-summary-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.upsertUser({ id: 'user_a', email: 'a@example.test', displayName: 'A', role: 'owner', customerId: 'cust_a', status: 'active', createdAtIso: now, updatedAtIso: now });
    await store.upsertUser({ id: 'user_b', email: 'b@example.test', displayName: 'B', role: 'owner', customerId: 'cust_b', status: 'active', createdAtIso: now, updatedAtIso: now });
    await store.upsertCustomer({ id: 'cust_a', name: 'A', status: 'active', billingStatus: 'past_due', maxConnectedAccounts: 3, createdAtIso: now });
    await store.upsertCustomer({ id: 'cust_b', name: 'B', status: 'active', billingStatus: 'active', maxConnectedAccounts: 9, createdAtIso: now });
    await store.upsertConnectedAccount({ id: 'account_a_connected', customerId: 'cust_a', platform: 'facebook', zernioAccountId: 'provider_a_connected', status: 'connected' });
    await store.upsertConnectedAccount({ id: 'account_a_reconnect', customerId: 'cust_a', platform: 'instagram', zernioAccountId: 'provider_a_reconnect', status: 'error' });
    await store.upsertConnectedAccount({ id: 'account_b', customerId: 'cust_b', platform: 'linkedin', zernioAccountId: 'provider_b', status: 'connected' });
    await store.recordInboxMessage({ id: 'message_a', customerId: 'cust_a', conversationId: 'conversation_a', accountId: 'account_a_connected', platform: 'facebook', providerMessageId: 'message_a', direction: 'inbound', receivedAtIso: now });
    await store.recordInboxMessage({ id: 'message_b', customerId: 'cust_b', conversationId: 'conversation_b', accountId: 'account_b', platform: 'linkedin', providerMessageId: 'message_b', direction: 'inbound', receivedAtIso: now });
    await store.createInboxDraftReply({ customerId: 'cust_a', conversationId: 'conversation_a', text: 'Review me', createdByUserId: 'user_a' });
    await store.createInboxDraftReply({ customerId: 'cust_b', conversationId: 'conversation_b', text: 'Other tenant', createdByUserId: 'user_b' });

    const session = await store.createSession({ userId: 'user_a', ttlMs: 60_000, nowIso: now });
    const dashboard = await store.getDashboardForSession(session.token, now);

    assert.equal(dashboard?.state, 'ready');
    assert.deepEqual(dashboard?.dashboardSummary, {
      renewalState: 'past_due',
      inbox: { unreadConversations: 1, pendingReviewDrafts: 1 },
      channels: { totalSlots: 3, activeAccounts: 1, needsReconnect: 1 },
      api: { patManagementHref: '/personal-access-tokens' },
    });

    const newCustomer = await store.upsertGoogleUser({ email: 'new@example.test', nowIso: now });
    const newSession = await store.createSession({ userId: newCustomer.id, ttlMs: 60_000, nowIso: now });
    const needsPlan = await store.getDashboardForSession(newSession.token, now);
    assert.equal(needsPlan?.state, 'needs_plan');
    assert.deepEqual(needsPlan?.dashboardSummary, {
      renewalState: 'unknown',
      inbox: { unreadConversations: 0, pendingReviewDrafts: 0 },
      channels: { totalSlots: 0, activeAccounts: 0, needsReconnect: 0 },
      api: { patManagementHref: '/personal-access-tokens' },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Google login repairs a legacy active user whose customer projection is missing without granting entitlement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-google-customer-repair-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();
    await store.upsertUser({
      id: 'user_legacy',
      email: 'legacy@example.test',
      displayName: 'Legacy owner',
      role: 'owner',
      customerId: 'cust_missing',
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    });

    const user = await store.upsertGoogleUser({ email: 'legacy@example.test', nowIso: now });
    const session = await store.createSession({ userId: user.id, ttlMs: 60_000, nowIso: now });
    const dashboard = await store.getDashboardForSession(session.token, now);

    assert.equal(user.customerId, 'cust_missing');
    assert.equal(dashboard?.customer.id, 'cust_missing');
    assert.equal(dashboard?.state, 'needs_plan');
    assert.equal(dashboard?.entitlement.connectSlots.totalSlots, 0);
    assert.equal(dashboard?.connectedAccounts.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('login creates session only for active configured users', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-login-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();

    await store.upsertUser({
      id: 'user_1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
      customerId: 'cust_1',
      status: 'active',
      password: 'secret',
      createdAtIso: now,
      updatedAtIso: now,
    });

    assert.equal(await store.login({ email: 'owner@example.com', password: 'wrong', nowIso: now }), undefined);
    const session = await store.login({ email: 'owner@example.com', password: 'secret', nowIso: now });
    assert.ok(session?.token.startsWith('sess_'));
    assert.equal(session?.userId, 'user_1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
