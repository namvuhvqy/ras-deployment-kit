import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createStoreFromEnv } from '../../../packages/shared/src/persistentStore.js';
import { createZernioWebhookRouter } from './webhookRouter.js';
import { createZernioAdapterFromEnv } from '../../../packages/zernio-adapter/src/index.js';
import type { RasBasePlanId, RasBillingCycle, RasEntitlement } from '../../../packages/shared/src/types.js';

const adapter = createZernioAdapterFromEnv();
const store = createStoreFromEnv();
const zernioWebhookRouter = createZernioWebhookRouter({ store, secret: process.env.ZERNIO_WEBHOOK_SECRET });
const port = Number(process.env.PORT ?? 8080);

const ready = store.migrate();

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
}

function normalizeSignature(value: string): string {
  return value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
}

function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string | undefined): 'verified' | 'skipped' | 'invalid' | 'missing' {
  if (!secret) return 'skipped';
  if (!signature) return 'missing';
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const actual = normalizeSignature(signature);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return 'invalid';
  return timingSafeEqual(actualBuffer, expectedBuffer) ? 'verified' : 'invalid';
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';

async function paypalSandboxAccessToken(): Promise<string | undefined> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${PAYPAL_SANDBOX_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${authorization}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!response.ok) return undefined;
  const payload = (await response.json()) as { access_token?: string };
  return payload.access_token;
}

async function verifyPaypalSandboxWebhook(rawBody: Buffer, req: IncomingMessage, webhookId: string): Promise<boolean> {
  const transmissionId = firstHeader(req, 'paypal-transmission-id');
  const transmissionTime = firstHeader(req, 'paypal-transmission-time');
  const transmissionSig = firstHeader(req, 'paypal-transmission-sig');
  const certUrl = firstHeader(req, 'paypal-cert-url');
  const authAlgo = firstHeader(req, 'paypal-auth-algo');
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) return false;
  const accessToken = await paypalSandboxAccessToken();
  if (!accessToken) return false;
  let webhookEvent: Record<string, unknown>;
  try {
    webhookEvent = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  const response = await fetch(`${PAYPAL_SANDBOX_API}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: webhookEvent,
    }),
  });
  if (!response.ok) return false;
  const payload = (await response.json()) as { verification_status?: string };
  return payload.verification_status === 'SUCCESS';
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length);
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstNumberField(body: Record<string, unknown>, fields: string[]): number | undefined {
  for (const field of fields) {
    const value = numberField(body, field);
    if (value !== undefined) return value;
  }
  return undefined;
}

const GOOGLE_OAUTH_SCOPE = 'openid email profile';
const googleOAuthStates = new Map<string, { redirectTo: string; createdAtMs: number }>();

function publicBaseUrl(req: IncomingMessage): string {
  const proto = firstHeader(req, 'x-forwarded-proto') ?? 'http';
  const host = firstHeader(req, 'x-forwarded-host') ?? firstHeader(req, 'host') ?? `127.0.0.1:${port}`;
  return `${proto}://${host}`;
}

function googleCallbackUrl(req: IncomingMessage): string {
  return process.env.GOOGLE_OAUTH_CALLBACK_URL ?? `${publicBaseUrl(req)}/auth/google/callback`;
}

function frontendBaseUrl(): string {
  return process.env.FRONTEND_APP_URL ?? process.env.RAS_FRONTEND_URL ?? 'https://runagentsys.com';
}

function safeRedirectPath(value: string | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard';
}

function frontendOAuthCallbackUrl(token: string, redirectTo: string): string {
  const callback = new URL('/api/auth/google/callback', frontendBaseUrl());
  callback.searchParams.set('token', token);
  callback.searchParams.set('redirectTo', safeRedirectPath(redirectTo));
  return callback.toString();
}

function createOAuthState(redirectTo: string): string {
  const state = `oauth_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  googleOAuthStates.set(state, { redirectTo, createdAtMs: Date.now() });
  return state;
}

function consumeOAuthState(state: string | undefined): { redirectTo: string } | undefined {
  if (!state) return undefined;
  const stored = googleOAuthStates.get(state);
  if (!stored) return undefined;
  googleOAuthStates.delete(state);
  if (Date.now() - stored.createdAtMs > 10 * 60 * 1000) return undefined;
  return { redirectTo: stored.redirectTo };
}

async function requireCustomerAccess(req: IncomingMessage, customerId: string): Promise<'ok' | 'unauthorized' | 'forbidden'> {
  const dashboard = await store.getDashboardForSession(bearerToken(req) ?? '');
  if (!dashboard) return 'unauthorized';
  if (dashboard.customer.id !== customerId) return 'forbidden';
  return 'ok';
}

function endCustomerAccessError(res: { statusCode: number; end: (chunk: string) => void }, access: 'unauthorized' | 'forbidden') {
  res.statusCode = access === 'unauthorized' ? 401 : 403;
  res.end(JSON.stringify({ ok: false, error: access }));
}

function requireInternalAccess(req: IncomingMessage): boolean {
  const token = process.env.RAS_INTERNAL_API_TOKEN;
  if (!token) return false;
  return firstHeader(req, 'x-ras-internal-token') === token;
}

function endInternalAccessError(res: { statusCode: number; end: (chunk: string) => void }) {
  res.statusCode = 401;
  res.end(JSON.stringify({ ok: false, error: 'missing_internal_token' }));
}

async function exchangeGoogleCode(req: IncomingMessage, code: string): Promise<string> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('google_oauth_not_configured');
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: googleCallbackUrl(req),
    grant_type: 'authorization_code',
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`google_token_exchange_failed_${response.status}`);
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error('google_access_token_missing');
  return payload.access_token;
}

async function fetchGoogleProfile(accessToken: string): Promise<{ email: string; displayName?: string }> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`google_userinfo_failed_${response.status}`);
  const profile = (await response.json()) as { email?: string; email_verified?: boolean; name?: string };
  if (!profile.email || profile.email_verified === false) throw new Error('google_email_unverified');
  return { email: profile.email, displayName: profile.name };
}

function objectField(body: Record<string, unknown>, field: string): Record<string, string> | undefined {
  const value = body[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, status]) => [key, String(status)]));
}

type PaidRasBasePlanId = Exclude<RasBasePlanId, 'none'>;

const RAS_PLAN_PRICES: Record<PaidRasBasePlanId, { monthly: number; yearlyMonthly: number; vpsSize: 'small' | 'standard' | 'large'; aiTokenLimit: number }> = {
  lite: { monthly: 19, yearlyMonthly: 16, vpsSize: 'small', aiTokenLimit: 100000 },
  pro: { monthly: 39, yearlyMonthly: 33, vpsSize: 'standard', aiTokenLimit: 250000 },
  max: { monthly: 59, yearlyMonthly: 49, vpsSize: 'large', aiTokenLimit: 500000 },
};

function basePlanField(body: Record<string, unknown>): PaidRasBasePlanId | undefined {
  const value = stringField(body, 'plan') ?? stringField(body, 'plan_id') ?? stringField(body, 'base_plan');
  return value === 'lite' || value === 'pro' || value === 'max' ? value : undefined;
}

function billingCycleField(body: Record<string, unknown>): RasBillingCycle {
  return stringField(body, 'billing_cycle') === 'yearly' ? 'yearly' : 'monthly';
}

function isSocialPlatform(value: unknown): value is 'facebook' | 'instagram' | 'youtube' | 'twitter' | 'linkedin' | 'tiktok' | 'threads' | 'bluesky' {
  return (
    value === 'facebook' ||
    value === 'instagram' ||
    value === 'youtube' ||
    value === 'twitter' ||
    value === 'linkedin' ||
    value === 'tiktok' ||
    value === 'threads' ||
    value === 'bluesky'
  );
}

async function refreshZernioAccountsForCustomer(customerId: string): Promise<{ refreshed: boolean; reason?: string; accountCount?: number }> {
  const state = await store.load();
  const customer = state.customers.find((row) => row.id === customerId);
  if (!customer) return { refreshed: false, reason: 'customer_not_found' };
  if (!customer.zernioProfileId) return { refreshed: false, reason: 'missing_zernio_profile_id' };

  const nowIso = new Date().toISOString();
  try {
    const accounts = await adapter.listAccounts(customer.zernioProfileId);
    for (const account of accounts) {
      await store.upsertAccountMapping({
        ...account,
        id: account.id || `${customer.id}_${account.platform}_${account.zernioAccountId}`,
        customerId: customer.id,
        zernioProfileId: customer.zernioProfileId,
        profileId: customer.zernioProfileId,
        status: account.status,
        connectedAtIso: account.connectedAtIso ?? (account.status === 'connected' ? nowIso : undefined),
        lastVerifiedAtIso: nowIso,
      });
    }
    return { refreshed: true, accountCount: accounts.length };
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status?: unknown }).status) : undefined;
    return {
      refreshed: false,
      reason: status ? `zernio_sync_failed_${status}` : 'zernio_sync_failed',
    };
  }
}

const server = createServer(async (req, res) => {
  await ready;
  res.setHeader('content-type', 'application/json; charset=utf-8');

  if (await zernioWebhookRouter(req, res)) return;

  if (req.url === '/health') {
    const state = await store.load();
    res.end(
      JSON.stringify({
        ok: true,
        service: 'ras-api',
        product: 'RAS Sandbox Agent Environment',
        schemaVersion: state.schemaVersion,
        counts: {
          customers: state.customers.length,
          sandboxes: state.sandboxes.length,
          agents: state.agents.length,
          servicePackages: state.servicePackages.length,
          connectedAccounts: state.connectedAccounts.length,
          jobs: state.jobs.length,
        },
      }),
    );
    return;
  }

  if (req.method === 'GET' && req.url === '/webhooks/zernio/status') {
    const status = await store.getWebhookStatus();
    res.end(JSON.stringify({ ok: true, status }));
    return;
  }


  if (req.method === 'POST' && req.url === '/webhooks/paypal/sandbox') {
    // Intentionally Sandbox-only: this process has no PayPal Live webhook route.
    const webhookId = process.env.PAYPAL_WEBHOOK_ID_SANDBOX;
    if (process.env.PAYPAL_MODE !== 'sandbox' || !webhookId || !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: 'paypal_sandbox_webhook_not_configured' }));
      return;
    }
    const requiredHeaders = ['paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo'];
    if (requiredHeaders.some((header) => !firstHeader(req, header))) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'missing_paypal_transmission_headers' }));
      return;
    }
    const rawBody = await readRawBody(req);
    let payload: Record<string, unknown>;
    try {
      payload = rawBody.length ? (JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>) : {};
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
      return;
    }
    const eventId = stringField(payload, 'id');
    if (!eventId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'missing_paypal_event_id' }));
      return;
    }
    const verified = await verifyPaypalSandboxWebhook(rawBody, req, webhookId);
    if (!verified) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'invalid_paypal_webhook_signature' }));
      return;
    }
    const eventType = stringField(payload, 'event_type') ?? 'unknown';
    const result = await store.recordWebhookEvent({
      id: eventId,
      source: 'paypal_sandbox',
      eventType,
      payload,
      processedAtIso: new Date().toISOString(),
      createdAtIso: new Date().toISOString(),
      signatureStatus: 'verified',
    });
    res.statusCode = result.inserted ? 202 : 200;
    res.end(JSON.stringify({ ok: true, deduped: !result.inserted, eventId, signature: 'verified' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/auth/login') {
    const body = await readJsonBody(req);
    const session = await store.login({ email: String(body.email ?? ''), password: String(body.password ?? '') });
    if (!session) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'invalid_credentials' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, token: session.token, expiresAtIso: session.expiresAtIso }));
    return;
  }

  // Keep Google OAuth routes above all customer/dashboard routes and the final 404 fallback.
  if (req.method === 'GET' && req.url?.startsWith('/auth/google/callback')) {
    const url = new URL(req.url, publicBaseUrl(req));
    if (url.pathname !== '/auth/google/callback') {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }
    const code = url.searchParams.get('code') ?? undefined;
    const state = consumeOAuthState(url.searchParams.get('state') ?? undefined);
    if (!code || !state) {
      const failed = new URL('/login', frontendBaseUrl());
      failed.searchParams.set('error', 'invalid_google_oauth_callback');
      res.statusCode = 302;
      res.setHeader('location', failed.toString());
      res.end();
      return;
    }
    try {
      const accessToken = await exchangeGoogleCode(req, code);
      const profile = await fetchGoogleProfile(accessToken);
      const session = await store.createSessionForGoogleUser({ email: profile.email, displayName: profile.displayName });
      const dashboard = await store.getDashboardForSession(session.token);
      if (!dashboard) throw new Error('google_session_dashboard_missing');
      res.statusCode = 302;
      res.setHeader('location', frontendOAuthCallbackUrl(session.token, state.redirectTo));
      res.end();
    } catch (error) {
      const failed = new URL('/login', frontendBaseUrl());
      failed.searchParams.set('error', (error as Error).message);
      res.statusCode = 302;
      res.setHeader('location', failed.toString());
      res.end();
    }
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/auth/google')) {
    const url = new URL(req.url, publicBaseUrl(req));
    if (url.pathname !== '/auth/google') {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!clientId) {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: 'google_oauth_not_configured' }));
      return;
    }
    const redirectTo = safeRedirectPath(url.searchParams.get('redirectTo') ?? undefined);
    const state = createOAuthState(redirectTo);
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', googleCallbackUrl(req));
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', GOOGLE_OAUTH_SCOPE);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'select_account');
    res.end(JSON.stringify({ ok: true, authUrl: authUrl.toString() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/auth/google/callback') {
    const body = await readJsonBody(req);
    const code = stringField(body, 'code');
    const state = consumeOAuthState(stringField(body, 'state'));
    if (!code || !state) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'invalid_google_oauth_callback' }));
      return;
    }
    try {
      const accessToken = await exchangeGoogleCode(req, code);
      const profile = await fetchGoogleProfile(accessToken);
      const session = await store.createSessionForGoogleUser({ email: profile.email, displayName: profile.displayName });
      const dashboard = await store.getDashboardForSession(session.token);
      if (!dashboard) throw new Error('google_session_dashboard_missing');
      res.end(
        JSON.stringify({
          ok: true,
          token: session.token,
          expiresAtIso: session.expiresAtIso,
          customerId: dashboard.customer.id,
          redirectTo: state.redirectTo,
        }),
      );
    } catch (error) {
      res.statusCode = 502;
      res.end(JSON.stringify({ ok: false, error: (error as Error).message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/dashboard') {
    const dashboard = await store.getDashboardForSession(bearerToken(req) ?? '');
    if (!dashboard) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, dashboard }));
    return;
  }

  if (req.method === 'POST' && req.url === '/billing/entitlements/activate-trial') {
    const dashboard = await store.getDashboardForSession(bearerToken(req) ?? '');
    if (!dashboard) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    const mapping = await store.upsertCustomerEntitlement({
      customerId: dashboard.customer.id,
      maxConnectedAccounts: 0,
      packageStatus: 'active',
      addOnStatus: { zernio: 'inactive' },
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, entitlement: mapping }));
    return;
  }

  if (req.method === 'POST' && req.url === '/billing/payments/captured') {
    const dashboard = await store.getDashboardForSession(bearerToken(req) ?? '');
    if (!dashboard) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    const body = await readJsonBody(req);
    const plan = basePlanField(body);
    const billingCycle = billingCycleField(body);
    const extraConnectSlots = firstNumberField(body, ['extra_connect_slots', 'connect_slots', 'extraConnectSlots']);
    const totalAmount = firstNumberField(body, ['total_amount', 'amount', 'totalAmount']);
    const paypalOrderId = stringField(body, 'paypal_order_id') ?? stringField(body, 'paypalOrderId');
    const transactionId = stringField(body, 'transaction_id') ?? stringField(body, 'transactionId');
    const captureStatus = stringField(body, 'capture_status') ?? stringField(body, 'status');
    const currency = (stringField(body, 'currency') ?? 'USD').toUpperCase();

    if (!plan || extraConnectSlots === undefined || extraConnectSlots < 0 || !Number.isInteger(extraConnectSlots) || totalAmount === undefined || totalAmount < 0 || !paypalOrderId || !transactionId || captureStatus !== 'COMPLETED') {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'invalid_captured_payment' }));
      return;
    }

    const planPrice = RAS_PLAN_PRICES[plan];
    const expectedBase = billingCycle === 'yearly' ? planPrice.yearlyMonthly * 12 : planPrice.monthly;
    const expectedConnect = billingCycle === 'yearly' ? extraConnectSlots * 6 * 12 : extraConnectSlots * 6;
    const expectedTotal = expectedBase + expectedConnect;
    if (totalAmount !== expectedTotal || currency !== 'USD') {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'invalid_payment_amount', expectedTotal }));
      return;
    }

    const customerId = dashboard.customer.id;
    const payment = await store.recordBillingPaymentCapture({
      provider: 'paypal',
      customerId,
      paypalOrderId,
      transactionId,
      status: 'captured',
      amount: String(totalAmount),
      currency,
      plan,
      billingCycle,
      extraConnectSlots,
      rawCapture: typeof body.rawCapture === 'object' && body.rawCapture !== null && !Array.isArray(body.rawCapture) ? body.rawCapture as Record<string, unknown> : body,
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    });

    try {
      const customer = dashboard.customer;
      const maxConnectedAccounts = 1 + extraConnectSlots;
      let zernioProfileId = customer.zernioProfileId;
      if (!zernioProfileId && maxConnectedAccounts > 0) {
        const profile = await adapter.createProfile({ customerId, name: customer.name, email: customer.email });
        zernioProfileId = profile.zernioProfileId;
      }

      const entitlement: RasEntitlement = {
        basePlan: {
          planId: plan,
          status: 'active' as const,
          billingCycle,
          monthlyPriceUsd: billingCycle === 'yearly' ? planPrice.yearlyMonthly : planPrice.monthly,
          totalAmountUsd: expectedTotal,
          vps: { type: 'dedicated' as const, size: planPrice.vpsSize },
          agents: { included: 2, kinds: ['ras1-hermes', 'ras2-openclaw'] },
          aiTokens: { monthlyLimit: planPrice.aiTokenLimit },
          activatedAtIso: new Date().toISOString(),
        },
        connectSlots: {
          status: 'active' as const,
          includedSlots: 1,
          purchasedSlots: extraConnectSlots,
          trialSlots: 0,
          totalSlots: maxConnectedAccounts,
          activeConnectedAccounts: dashboard.customer.activeConnectedAccounts ?? 0,
        },
        addOns: [
          { id: 'zernio-connect', name: 'Zernio Connect', status: 'active' as const, slots: maxConnectedAccounts, priceUsd: expectedConnect },
        ],
      };
      const mapping = await store.upsertCustomerEntitlement({
        customerId,
        maxConnectedAccounts,
        packageStatus: 'active',
        addOnStatus: { ...(customer.addOnStatus ?? {}), zernio: maxConnectedAccounts > 0 ? 'active' : 'inactive' },
        zernioProfileId,
        entitlement,
      });
      await store.markBillingPaymentProvisioned(payment.id);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, payment: { id: payment.id, provisionStatus: 'provisioned', transactionId }, entitlement: { ...mapping, entitlement } }));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'provision_failed';
      const pendingPayment = await store.markBillingPaymentProvisionFailed(payment.id, message);
      res.statusCode = 202;
      res.end(JSON.stringify({ ok: false, error: 'provision_pending_retry', payment: pendingPayment }));
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/billing/entitlements/provision') {
    const dashboard = await store.getDashboardForSession(bearerToken(req) ?? '');
    if (!dashboard) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    const body = await readJsonBody(req);
    const plan = basePlanField(body);
    const billingCycle = billingCycleField(body);
    const extraConnectSlots = firstNumberField(body, ['extra_connect_slots', 'connect_slots', 'extraConnectSlots']);
    const totalAmount = firstNumberField(body, ['total_amount', 'amount', 'totalAmount']);
    if (!plan || extraConnectSlots === undefined || extraConnectSlots < 0 || !Number.isInteger(extraConnectSlots) || totalAmount === undefined || totalAmount < 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'missing_entitlement_fields' }));
      return;
    }

    const planPrice = RAS_PLAN_PRICES[plan];
    const expectedBase = billingCycle === 'yearly' ? planPrice.yearlyMonthly * 12 : planPrice.monthly;
    const expectedConnect = billingCycle === 'yearly' ? extraConnectSlots * 6 * 12 : extraConnectSlots * 6;
    const expectedTotal = expectedBase + expectedConnect;
    if (totalAmount !== expectedTotal) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'invalid_total_amount', expectedTotal }));
      return;
    }

    const customerId = dashboard.customer.id;
    const customer = dashboard.customer;
    const maxConnectedAccounts = 1 + extraConnectSlots;
    let zernioProfileId = customer.zernioProfileId;
    if (!zernioProfileId && maxConnectedAccounts > 0) {
      const profile = await adapter.createProfile({ customerId, name: customer.name, email: customer.email });
      zernioProfileId = profile.zernioProfileId;
    }

    const entitlement: RasEntitlement = {
      basePlan: {
        planId: plan,
        status: 'active' as const,
        billingCycle,
        monthlyPriceUsd: billingCycle === 'yearly' ? planPrice.yearlyMonthly : planPrice.monthly,
        totalAmountUsd: expectedTotal,
        vps: { type: 'dedicated' as const, size: planPrice.vpsSize },
        agents: { included: 2, kinds: ['ras1-hermes', 'ras2-openclaw'] },
        aiTokens: { monthlyLimit: planPrice.aiTokenLimit },
        activatedAtIso: new Date().toISOString(),
      },
      connectSlots: {
        status: 'active' as const,
        includedSlots: 1,
        purchasedSlots: extraConnectSlots,
        trialSlots: 0,
        totalSlots: maxConnectedAccounts,
        activeConnectedAccounts: dashboard.customer.activeConnectedAccounts ?? 0,
      },
      addOns: [
        { id: 'zernio-connect', name: 'Zernio Connect', status: 'active' as const, slots: maxConnectedAccounts, priceUsd: expectedConnect },
      ],
    };
    const mapping = await store.upsertCustomerEntitlement({
      customerId,
      maxConnectedAccounts,
      packageStatus: 'active',
      addOnStatus: { ...(customer.addOnStatus ?? {}), zernio: maxConnectedAccounts > 0 ? 'active' : 'inactive' },
      zernioProfileId,
      entitlement,
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, entitlement: { ...mapping, entitlement } }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.includes('/connect/')) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const customerId = decodeURIComponent(parts[2] ?? '');
    const platform = parts[4];
    if (!customerId || !isSocialPlatform(platform)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'invalid_connect_request' }));
      return;
    }

    const access = await requireCustomerAccess(req, customerId);
    if (access !== 'ok') {
      endCustomerAccessError(res, access);
      return;
    }

    await refreshZernioAccountsForCustomer(customerId);
    const mapping = await store.getCustomerMapping(customerId);
    if (!mapping) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'customer_not_found' }));
      return;
    }
    if (mapping.packageStatus !== 'active' || (mapping.addOnStatus.zernio && mapping.addOnStatus.zernio !== 'active')) {
      res.statusCode = 403;
      res.end(JSON.stringify({ ok: false, error: 'zernio_addon_inactive', entitlement: mapping }));
      return;
    }
    if (mapping.activeConnectedAccounts >= mapping.maxConnectedAccounts) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: 'connection_quota_exceeded', entitlement: mapping }));
      return;
    }

    let profileId = mapping.zernioProfileId ?? mapping.zernioProfileIds[0];
    const samePlatformExists = mapping.accounts.some((account) => account.platform === platform && account.status === 'connected');
    if (!profileId || samePlatformExists) {
      const state = await store.load();
      const customer = state.customers.find((row) => row.id === customerId);
      if (!customer) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: 'customer_not_found' }));
        return;
      }
      const profile = await adapter.createProfile({ customerId, name: customer.name, email: customer.email });
      if (!profile.zernioProfileId) throw new Error('Zernio profile response missing profile id');
      profileId = profile.zernioProfileId;
      await store.addCustomerZernioProfile(customerId, profileId);
    }

    const redirectUrl = url.searchParams.get('redirectUrl') ?? `${firstHeader(req, 'origin') ?? 'https://runagentsys.com'}/dashboard`;
    const authUrl = await adapter.getConnectUrl({ profileId, platform, redirectUrl });
    res.end(JSON.stringify({ ok: true, authUrl, profileId, platform, entitlement: await store.getCustomerMapping(customerId) }));
    return;
  }

  if (req.method === 'POST' && req.url === '/mappings/customers') {
    if (!requireInternalAccess(req)) {
      endInternalAccessError(res);
      return;
    }
    const body = await readJsonBody(req);
    const customerId = stringField(body, 'customerId');
    const name = stringField(body, 'name');
    if (!customerId || !name) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'missing_customer_mapping_fields' }));
      return;
    }
    const nowIso = new Date().toISOString();
    const existing = (await store.load()).customers.find((row) => row.id === customerId);
    const customer = await store.upsertCustomer({
      ...existing,
      id: customerId,
      tenantId: stringField(body, 'tenantId') ?? existing?.tenantId,
      name,
      email: stringField(body, 'email') ?? existing?.email,
      zernioProfileId: stringField(body, 'zernioProfileId') ?? existing?.zernioProfileId,
      status: 'active',
      createdAtIso: existing?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
    });
    res.statusCode = existing ? 200 : 201;
    res.end(
      JSON.stringify({
        ok: true,
        mapping: { customerId: customer.id, tenantId: customer.tenantId, zernioProfileId: customer.zernioProfileId },
      }),
    );
    return;
  }

  if (req.method === 'POST' && req.url === '/mappings/accounts') {
    if (!requireInternalAccess(req)) {
      endInternalAccessError(res);
      return;
    }
    const body = await readJsonBody(req);
    const accountId = stringField(body, 'accountId');
    const customerId = stringField(body, 'customerId');
    const platform = body.platform;
    const zernioAccountId = stringField(body, 'zernioAccountId');
    if (!accountId || !customerId || !isSocialPlatform(platform) || !zernioAccountId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'missing_account_mapping_fields' }));
      return;
    }
    try {
      const mapping = await store.upsertAccountMapping({
        id: accountId,
        customerId,
        platform,
        zernioAccountId,
        zernioProfileId: stringField(body, 'zernioProfileId'),
        handle: stringField(body, 'handle'),
        username: stringField(body, 'username'),
        status: (stringField(body, 'status') as 'pending' | 'connected' | 'disconnected' | 'error' | undefined) ?? 'pending',
        connectedAtIso: stringField(body, 'connectedAtIso'),
        lastVerifiedAtIso: stringField(body, 'lastVerifiedAtIso'),
      });
      res.statusCode = 201;
      res.end(JSON.stringify({ ok: true, mapping }));
    } catch (error) {
      const message = (error as Error).message;
      if (message.startsWith('Customer not found:')) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: 'customer_not_found' }));
        return;
      }
      if (message.startsWith('Zernio profile mismatch:')) {
        res.statusCode = 409;
        res.end(JSON.stringify({ ok: false, error: 'zernio_profile_mismatch' }));
        return;
      }
      throw error;
    }
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/mappings/customers/')) {
    const [, , , customerId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId);
    if (access !== 'ok') {
      endCustomerAccessError(res, access);
      return;
    }
    const mapping = await store.getCustomerMapping(decodedCustomerId);
    if (!mapping) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'customer_not_found' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, mapping }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.endsWith('/mapping')) {
    const [, , customerId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId);
    if (access !== 'ok') {
      endCustomerAccessError(res, access);
      return;
    }
    const state = await store.load();
    const customer = state.customers.find((row) => row.id === decodedCustomerId);
    if (!customer) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'customer_not_found' }));
      return;
    }
    res.end(
      JSON.stringify({
        ok: true,
        mapping: {
          customer,
          sandbox: customer.sandboxId ? state.sandboxes.find((row) => row.id === customer.sandboxId) : undefined,
          agents: state.agents.filter((row) => row.customerId === customer.id),
          connectedAccounts: state.connectedAccounts.filter((row) => row.customerId === customer.id),
        },
      }),
    );
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.endsWith('/lifecycle-status')) {
    const [, , customerId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId);
    if (access !== 'ok') {
      endCustomerAccessError(res, access);
      return;
    }
    const lifecycle = await store.getCustomerLifecycleStatus(decodedCustomerId);
    if (!lifecycle) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'customer_not_found' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, lifecycle }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.endsWith('/audit-logs')) {
    const [, , customerId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId);
    if (access !== 'ok') {
      endCustomerAccessError(res, access);
      return;
    }
    const state = await store.load();
    const customer = state.customers.find((row) => row.id === decodedCustomerId);
    if (!customer) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'customer_not_found' }));
      return;
    }
    const auditLogs = state.auditLogs
      .filter((row) => row.customerId === customer.id)
      .sort((left, right) => Date.parse(right.createdAtIso) - Date.parse(left.createdAtIso));
    res.end(JSON.stringify({ ok: true, auditLogs }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.endsWith('/service-package')) {
    const [, , customerId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId);
    if (access !== 'ok') {
      endCustomerAccessError(res, access);
      return;
    }
    const state = await store.load();
    const customer = state.customers.find((row) => row.id === decodedCustomerId);
    if (!customer) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'customer_not_found' }));
      return;
    }
    const servicePackage = customer.servicePackageId
      ? state.servicePackages.find((row) => row.id === customer.servicePackageId)
      : undefined;
    if (!servicePackage) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'service_package_not_found' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, servicePackage }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.endsWith('/billing-state')) {
    const [, , customerId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId);
    if (access !== 'ok') {
      endCustomerAccessError(res, access);
      return;
    }
    const state = await store.load();
    const customer = state.customers.find((row) => row.id === decodedCustomerId);
    if (!customer) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'customer_not_found' }));
      return;
    }
    res.end(
      JSON.stringify({
        ok: true,
        billingState: {
          customerId: customer.id,
          status: customer.billingStatus ?? 'trial',
          servicePackageId: customer.servicePackageId,
        },
      }),
    );
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.endsWith('/inbox/conversations')) {
    const [, , customerId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId);
    if (access !== 'ok') { endCustomerAccessError(res, access); return; }
    const conversations = await store.listInboxConversations(decodedCustomerId);
    res.end(JSON.stringify({ ok: true, customerId: decodedCustomerId, mode: 'draft_only', conversations }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && /\/inbox\/conversations\/[^/]+\/messages$/.test(req.url)) {
    const [, , customerId, , , conversationId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId);
    if (access !== 'ok') { endCustomerAccessError(res, access); return; }
    const messages = await store.listInboxMessages(decodedCustomerId, decodeURIComponent(conversationId));
    res.end(JSON.stringify({ ok: true, customerId: decodedCustomerId, conversationId: decodeURIComponent(conversationId), messages }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.endsWith('/connection-summary')) {
    const [, , customerId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId);
    if (access !== 'ok') {
      endCustomerAccessError(res, access);
      return;
    }
    const sync = await refreshZernioAccountsForCustomer(decodedCustomerId);
    const summary = await store.getConnectionSummary(decodedCustomerId);
    const integrations = summary.accounts.map((account) => ({
      id: account.id,
      platform: account.platform,
      connected:
        account.status === 'connected' && Boolean(account.connectedAtIso) && Boolean(account.lastVerifiedAtIso),
      needsReconnection: account.status === 'disconnected' || account.status === 'error',
      lastVerifiedAt: account.lastVerifiedAtIso ?? null,
      accountId: account.zernioAccountId,
      username: account.username ?? account.handle ?? null,
      capabilities: account.capabilities ?? [],
    }));
    res.end(JSON.stringify({ ...summary, integrations, customerId: decodedCustomerId, sync }));
    return;
  }

  if (req.method === 'POST' && req.url === '/demo/customer-zernio-profile') {
    const body = await readJsonBody(req);
    const customerId = stringField(body, 'customerId') ?? 'demo_khach_2';
    const zernioProfileId = stringField(body, 'zernioProfileId') ?? '6a2d49446d68ffa8630cf8e6';
    const name = stringField(body, 'name') ?? 'Khách 2 Demo';
    const nowIso = new Date().toISOString();
    const existing = (await store.load()).customers.find((row) => row.id === customerId);
    const customer = await store.upsertCustomer({
      ...existing,
      id: customerId,
      name,
      tenantId: stringField(body, 'tenantId') ?? existing?.tenantId ?? customerId,
      email: stringField(body, 'email') ?? existing?.email,
      zernioProfileId,
      status: 'active',
      createdAtIso: existing?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
    });
    const sync = await refreshZernioAccountsForCustomer(customer.id);
    await store.appendAuditLog({
      id: `audit_${Date.now()}`,
      customerId: customer.id,
      action: 'customer.zernio_profile_mapped',
      targetType: 'zernio_profile',
      targetId: customer.zernioProfileId,
      metadata: { source: 'demo/customer-zernio-profile', sync },
      createdAtIso: nowIso,
    });
    const summary = await store.getConnectionSummary(customer.id);
    res.statusCode = existing ? 200 : 201;
    res.end(JSON.stringify({ ok: true, customer, summary: { ...summary, customerId: customer.id, sync } }));
    return;
  }

  if (req.url === '/dry-run/customer') {
    const existing = (await store.load()).customers.find((customer) => customer.id === 'demo');
    const customer = existing?.zernioProfileId
      ? existing
      : await adapter.createProfile({ customerId: 'demo', name: 'Demo Customer' });
    await store.upsertCustomer(customer);
    await store.appendAuditLog({
      id: `audit_${Date.now()}`,
      customerId: customer.id,
      action: 'customer.upserted',
      targetType: 'customer',
      targetId: customer.id,
      metadata: { source: 'dry-run/customer' },
      createdAtIso: new Date().toISOString(),
    });
    res.end(JSON.stringify(customer));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

server.listen(port, () => {
  console.log(`ras-api listening on :${port}`);
});
