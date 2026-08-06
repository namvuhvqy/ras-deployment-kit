import { evaluateSubscriptionLifecycle } from './subscriptionPolicy.js';
import type { RasEntitlement } from './types.js';

export type PaidCapabilityDecision = 'allow' | 'entitlement_unavailable' | 'entitlement_expired' | 'entitlement_inactive';

/**
 * Pure server-side policy for customer mutations that consume paid Zernio
 * capabilities. Subscription lifecycle is always derived from the authoritative
 * expiry timestamp; provider/account health is deliberately not considered.
 */
export function evaluatePaidCapability(
  entitlement: RasEntitlement | undefined,
  nowIso: string,
): PaidCapabilityDecision {
  if (!entitlement) return 'entitlement_unavailable';

  const lifecycle = evaluateSubscriptionLifecycle(entitlement.basePlan.expiresAtIso, nowIso);
  if (lifecycle.state === 'unknown') return 'entitlement_unavailable';
  if (lifecycle.state === 'expired') return 'entitlement_expired';

  const zernioAddOn = entitlement.addOns.find((addOn) => addOn.id === 'zernio' || addOn.id === 'zernio-connect');
  if (
    entitlement.basePlan.planId === 'none'
    || entitlement.connectSlots.status !== 'active'
    || zernioAddOn?.status !== 'active'
  ) return 'entitlement_inactive';

  return 'allow';
}
