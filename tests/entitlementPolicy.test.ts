import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePaidCapability } from '../packages/shared/src/entitlementPolicy.js';
import type { RasEntitlement } from '../packages/shared/src/types.js';

function entitlement(overrides: Partial<RasEntitlement['basePlan']> = {}): RasEntitlement {
  return {
    basePlan: { planId: 'lite', status: 'active', vps: { type: 'dedicated' }, agents: { included: 1, kinds: ['ras1-hermes'] }, expiresAtIso: '2026-08-20T00:00:00.000Z', ...overrides },
    connectSlots: { status: 'active', includedSlots: 1, purchasedSlots: 0, trialSlots: 0, totalSlots: 1, activeConnectedAccounts: 0 },
    addOns: [{ id: 'zernio', name: 'Zernio Connect', status: 'active' }],
  };
}

test('paid capability policy requires an active base-plan status while retaining lifecycle precedence', () => {
  for (const status of ['pending', 'inactive', 'past_due', 'cancelled', 'expired'] as const) {
    assert.equal(evaluatePaidCapability(entitlement({ status }), '2026-08-15T00:00:00.000Z'), 'entitlement_inactive');
  }
  assert.equal(evaluatePaidCapability(entitlement({ status: 'active' }), '2026-08-21T00:00:00.000Z'), 'allow');
  assert.equal(evaluatePaidCapability(entitlement({ status: 'inactive' }), '2026-08-27T00:00:00.000Z'), 'entitlement_expired');
});

test('paid capability policy fails closed for unavailable expiry and inactive base or Zernio capability', () => {
  assert.equal(evaluatePaidCapability(entitlement({ expiresAtIso: undefined }), '2026-08-15T00:00:00.000Z'), 'entitlement_unavailable');
  assert.equal(evaluatePaidCapability(entitlement({ expiresAtIso: 'not-an-iso' }), '2026-08-15T00:00:00.000Z'), 'entitlement_unavailable');
  assert.equal(evaluatePaidCapability(entitlement({ planId: 'none' }), '2026-08-15T00:00:00.000Z'), 'entitlement_inactive');
  assert.equal(evaluatePaidCapability({ ...entitlement(), connectSlots: { ...entitlement().connectSlots, status: 'inactive' } }, '2026-08-15T00:00:00.000Z'), 'entitlement_inactive');
});
