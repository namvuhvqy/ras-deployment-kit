import type { RasBillingCycle, SubscriptionLifecycleEvaluation } from './types.js';

const REMINDER_DAYS = 7;
const GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseIso(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * Derives a subscription state from server-owned dates. It has no clock access:
 * callers must explicitly supply the server's current timestamp.
 */
export function evaluateSubscriptionLifecycle(
  expiresAtIso: string | undefined,
  nowIso: string,
): SubscriptionLifecycleEvaluation {
  const expiresAtMs = parseIso(expiresAtIso);
  const nowMs = parseIso(nowIso);
  if (expiresAtMs === undefined || nowMs === undefined) return { state: 'unknown' };

  const reminderAtMs = expiresAtMs - REMINDER_DAYS * DAY_MS;
  const graceEndsAtMs = expiresAtMs + GRACE_DAYS * DAY_MS;
  if (nowMs < reminderAtMs) return { state: 'active', expiresAtIso: new Date(expiresAtMs).toISOString(), reminderAtIso: new Date(reminderAtMs).toISOString(), graceEndsAtIso: new Date(graceEndsAtMs).toISOString() };
  if (nowMs < expiresAtMs) return { state: 'expiring_soon', expiresAtIso: new Date(expiresAtMs).toISOString(), reminderAtIso: new Date(reminderAtMs).toISOString(), graceEndsAtIso: new Date(graceEndsAtMs).toISOString() };
  if (nowMs < graceEndsAtMs) return { state: 'past_due', expiresAtIso: new Date(expiresAtMs).toISOString(), reminderAtIso: new Date(reminderAtMs).toISOString(), graceEndsAtIso: new Date(graceEndsAtMs).toISOString() };
  return { state: 'expired', expiresAtIso: new Date(expiresAtMs).toISOString(), reminderAtIso: new Date(reminderAtMs).toISOString(), graceEndsAtIso: new Date(graceEndsAtMs).toISOString() };
}

/** Adds one billing period in UTC, clamping dates such as January 31 to February's last day. */
export function addPeriod(startIso: string, billingCycle: RasBillingCycle): string | undefined {
  const startMs = parseIso(startIso);
  if (startMs === undefined) return undefined;

  const start = new Date(startMs);
  const targetYear = start.getUTCFullYear() + (billingCycle === 'yearly' ? 1 : 0);
  const targetMonth = start.getUTCMonth() + (billingCycle === 'monthly' ? 1 : 0);
  const firstOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 1));
  const lastDay = new Date(Date.UTC(firstOfTargetMonth.getUTCFullYear(), firstOfTargetMonth.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    firstOfTargetMonth.getUTCFullYear(),
    firstOfTargetMonth.getUTCMonth(),
    Math.min(start.getUTCDate(), lastDay),
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds(),
  )).toISOString();
}

export const subscriptionPolicy = { REMINDER_DAYS, GRACE_DAYS };
