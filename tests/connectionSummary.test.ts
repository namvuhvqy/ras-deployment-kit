import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRasStore } from '../packages/shared/src/persistentStore.js';

const now = new Date(0).toISOString();

test('connection summary never reports connected without a verified connected account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-connection-summary-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();

    await store.upsertCustomer({ id: 'cust_1', name: 'Shop Demo', status: 'active' });

    assert.deepEqual(await store.getConnectionSummary('cust_1'), { connected: false, accounts: [] });

    await store.upsertConnectedAccount({
      id: 'acct_pending',
      customerId: 'cust_1',
      platform: 'facebook',
      zernioAccountId: 'zacct_pending',
      status: 'pending',
    });

    const pending = await store.getConnectionSummary('cust_1');
    assert.equal(pending.connected, false);
    assert.equal(pending.accounts.length, 1);

    await store.upsertConnectedAccount({
      id: 'acct_connected_without_verification',
      customerId: 'cust_1',
      platform: 'instagram',
      zernioAccountId: 'zacct_unverified',
      status: 'connected',
    });

    const unverified = await store.getConnectionSummary('cust_1');
    assert.equal(unverified.connected, false);
    assert.equal(unverified.accounts.length, 2);

    await store.upsertConnectedAccount({
      id: 'acct_connected_verified',
      customerId: 'cust_1',
      platform: 'facebook',
      zernioAccountId: 'zacct_verified',
      status: 'connected',
      connectedAtIso: now,
      lastVerifiedAtIso: now,
    });

    const verified = await store.getConnectionSummary('cust_1');
    assert.equal(verified.connected, true);
    assert.equal(verified.accounts.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upserting account status by RAS account id cannot be spoofed by click/demo state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-account-status-'));
  try {
    const store = new JsonRasStore(join(dir, 'ras-store.json'));
    await store.migrate();

    await store.upsertConnectedAccount({
      id: 'acct_1',
      customerId: 'cust_1',
      platform: 'facebook',
      zernioAccountId: 'zacct_1',
      status: 'pending',
    });

    await store.setConnectedAccountVerification({
      id: 'acct_1',
      status: 'connected',
      connectedAtIso: now,
      lastVerifiedAtIso: now,
    });

    const summary = await store.getConnectionSummary('cust_1');
    assert.equal(summary.connected, true);
    assert.equal(summary.accounts[0].id, 'acct_1');
    assert.equal(summary.accounts[0].status, 'connected');
    assert.equal(summary.accounts[0].connectedAtIso, now);
    assert.equal(summary.accounts[0].lastVerifiedAtIso, now);

    await assert.rejects(
      store.setConnectedAccountVerification({
        id: 'demo_click_connected',
        status: 'connected',
        connectedAtIso: now,
        lastVerifiedAtIso: now,
      }),
      /Connected account not found: demo_click_connected/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
