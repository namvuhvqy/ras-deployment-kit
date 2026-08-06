import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRasStore } from '../packages/shared/src/persistentStore.js';

const expiry = '2026-08-20T00:00:00.000Z';

async function createCustomerStore(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const path = join(dir, 'ras-store.json');
  const store = new JsonRasStore(path);
  await store.migrate();
  await store.upsertCustomer({
    id: 'customer', name: 'Customer', packageStatus: 'active',
    entitlement: {
      basePlan: { planId: 'pro', status: 'active', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, expiresAtIso: expiry },
      connectSlots: { status: 'active', includedSlots: 1, purchasedSlots: 0, trialSlots: 0, totalSlots: 1, activeConnectedAccounts: 0 }, addOns: [],
    },
  });
  return { dir, path, store };
}

test('lifecycle sweep rejects invalid clock without initializing legacy state or writing bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-lifecycle-invalid-clock-'));
  try {
    const path = join(dir, 'ras-store.json');
    const legacy = '{\n  "schemaVersion": 3,\n  "customers": []\n}\n';
    await writeFile(path, legacy);
    const store = new JsonRasStore(path);

    assert.deepEqual(await store.sweepSubscriptionLifecycle('2026-02-30T00:00:00.000Z'), []);
    assert.equal(await readFile(path, 'utf8'), legacy);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missed past-due sweep records every passed lifecycle milestone once in order', async () => {
  const { dir, store } = await createCustomerStore('ras-lifecycle-past-due-');
  try {
    const now = '2026-08-21T00:00:00.000Z';
    assert.deepEqual((await store.sweepSubscriptionLifecycle(now)).map((event) => event.lifecycleState), ['expiring_soon', 'past_due']);
    assert.deepEqual(await store.sweepSubscriptionLifecycle(now), []);
    const state = await store.load();
    assert.deepEqual(state.subscriptionLifecycleEvents.map((event) => [event.kind, event.lifecycleState, event.expiresAtIso, event.createdAtIso]), [
      ['reminder', 'expiring_soon', expiry, now], ['transition', 'past_due', expiry, now],
    ]);
    assert.deepEqual(state.auditLogs.map((log) => [log.action, log.metadata]), [
      ['subscription.lifecycle.reminder', { lifecycleState: 'expiring_soon', expiresAtIso: expiry }],
      ['subscription.lifecycle.transition', { lifecycleState: 'past_due', expiresAtIso: expiry }],
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missed expired sweep records every lifecycle milestone once in chronological order and deactivates only at expiry', async () => {
  const { dir, store } = await createCustomerStore('ras-lifecycle-expired-');
  try {
    const now = '2026-08-27T00:00:00.000Z';
    assert.deepEqual((await store.sweepSubscriptionLifecycle(now)).map((event) => event.lifecycleState), ['expiring_soon', 'past_due', 'expired']);
    assert.deepEqual(await store.sweepSubscriptionLifecycle('2026-08-28T00:00:00.000Z'), []);
    const state = await store.load();
    assert.deepEqual(state.subscriptionLifecycleEvents.map((event) => event.lifecycleState), ['expiring_soon', 'past_due', 'expired']);
    assert.deepEqual(state.auditLogs.map((log) => log.metadata), [
      { lifecycleState: 'expiring_soon', expiresAtIso: expiry },
      { lifecycleState: 'past_due', expiresAtIso: expiry },
      { lifecycleState: 'expired', expiresAtIso: expiry },
    ]);
    assert.equal(state.customers[0]?.entitlement?.basePlan.status, 'expired');
    assert.equal(state.customers[0]?.entitlement?.connectSlots.status, 'inactive');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const [now, expected] of [
  ['2026-08-13T00:00:00.000Z', ['expiring_soon']],
  ['2026-08-20T00:00:00.000Z', ['expiring_soon', 'past_due']],
  ['2026-08-27T00:00:00.000Z', ['expiring_soon', 'past_due', 'expired']],
] as const) {
  test(`first sweep at lifecycle boundary ${now} includes ${expected.join(', ')}`, async () => {
    const { dir, store } = await createCustomerStore('ras-lifecycle-boundary-');
    try { assert.deepEqual((await store.sweepSubscriptionLifecycle(now)).map((event) => event.lifecycleState), expected); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
}
