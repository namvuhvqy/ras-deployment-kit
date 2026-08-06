import type { RasBillingCycle, SubscriptionLifecycleEvaluation } from './types.js';

const REMINDER_DAYS = 7;
const GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** Strictly validates an explicit server timestamp without consulting a clock. */
export function parseSubscriptionPolicyIso(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const match = ISO_TIMESTAMP.exec(iso);
  if (!match) return undefined;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return undefined;

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
  const expiresAtMs = parseSubscriptionPolicyIso(expiresAtIso);
  const nowMs = parseSubscriptionPolicyIso(nowIso);
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
  const startMs = parseSubscriptionPolicyIso(startIso);
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
