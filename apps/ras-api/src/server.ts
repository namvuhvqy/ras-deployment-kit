import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createStoreFromEnv } from '../../../packages/shared/src/persistentStore.js';
import { createZernioWebhookRouter } from './webhookRouter.js';
import { consumeRedisPatRateLimit } from './patRateLimit.js';
import { redisUrlFromEnv } from './redisConfig.js';
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

function allowedFrontendOrigin(value: string | undefined): string {
  const canonical = new URL(frontendBaseUrl()).origin;
  if (!value) return canonical;
  try {
    const candidate = new URL(value);
    if (candidate.protocol !== 'https:' || candidate.pathname !== '/' || candidate.search || candidate.hash) return canonical;
    if (candidate.origin === canonical) return canonical;
    return /^https:\/\/landingpage-ban-hang-[a-z0-9-]+-namvuhvqys-projects\.vercel\.app$/.test(candidate.origin)
      ? candidate.origin
      : canonical;
  } catch {
    return canonical;
  }
}

function frontendOAuthCallbackUrl(token: string, redirectTo: string, frontendOrigin: string): string {
  const callback = new URL('/api/auth/google/callback', frontendOrigin);
  callback.searchParams.set('token', token);
  callback.searchParams.set('redirectTo', safeRedirectPath(redirectTo));
  return callback.toString();
}

async function createOAuthState(redirectTo: string, frontendOrigin: string): Promise<string> {
  const state = `oauth_${randomBytes(32).toString('base64url')}`;
  await store.createGoogleOAuthState({ state, redirectTo, frontendOrigin, createdAtMs: Date.now() });
  return state;
}

async function consumeOAuthState(state: string | undefined) {
  return store.consumeGoogleOAuthState(state);
}

function hasScope(scopes: string[], requiredScope?: string): boolean {
  return !requiredScope || scopes.includes('*') || scopes.includes(requiredScope);
}

type CustomerAccess = 'ok' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'rate_limit_unavailable';

async function requireCustomerAccess(req: IncomingMessage, customerId: string, requiredScope?: string): Promise<{ status: CustomerAccess; retryAfterSeconds?: number; remaining?: number; principal?: import('../../../packages/shared/src/types.js').RasPrincipal }> {
  const principal = await store.resolvePrincipal(bearerToken(req) ?? '');
  if (!principal) return { status: 'unauthorized' };
  if (principal.customerId !== customerId || !hasScope(principal.scopes, requiredScope)) return { status: 'forbidden', principal };
  if (principal.authType === 'pat' && principal.tokenId) {
    const configuredLimit = Number.parseInt(process.env.RAS_PAT_RATE_LIMIT_PER_MINUTE ?? '120', 10);
    const limit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 120;
    const redisUrl = redisUrlFromEnv(process.env);
    let result: { allowed: boolean; remaining: number; retryAfterSeconds: number };
    try {
      result = redisUrl
        ? await consumeRedisPatRateLimit({ redisUrl, customerId, tokenId: principal.tokenId, limit })
        : await store.consumePatRateLimit({ customerId, tokenId: principal.tokenId, limit, windowMs: 60_000 });
    } catch {
      await store.appendAuditLog({ id: `audit_${Date.now()}_${principal.tokenId}`, customerId, action: 'pat.rate_limit_unavailable', targetType: 'personal_access_token', targetId: principal.tokenId, metadata: { requiredScope, backend: 'redis' }, createdAtIso: new Date().toISOString() });
      return { status: 'rate_limit_unavailable', principal };
    }
    if (!result.allowed) {
      await store.appendAuditLog({ id: `audit_${Date.now()}_${principal.tokenId}`, customerId, action: 'pat.rate_limited', targetType: 'personal_access_token', targetId: principal.tokenId, metadata: { requiredScope, retryAfterSeconds: result.retryAfterSeconds }, createdAtIso: new Date().toISOString() });
      return { status: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds, remaining: 0, principal };
    }
    return { status: 'ok', remaining: result.remaining, principal };
  }
  return { status: 'ok', principal };
}

async function requireSessionPrincipal(req: IncomingMessage): Promise<import('../../../packages/shared/src/types.js').RasPrincipal | undefined> {
  const principal = await store.resolvePrincipal(bearerToken(req) ?? '');
  return principal?.authType === 'session' ? principal : undefined;
}

async function requireAdminSession(req: IncomingMessage): Promise<import('../../../packages/shared/src/types.js').RasPrincipal | undefined> {
  const principal = await requireSessionPrincipal(req);
  // Global operations access is deliberately separate from tenant-local roles.
  const systemAdminIds = new Set((process.env.RAS_SYSTEM_ADMIN_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
  return principal?.userId && systemAdminIds.has(principal.userId) ? principal : undefined;
}

function endAdminAccessError(res: { statusCode: number; end: (chunk?: string) => void }, authenticated: boolean): void {
  res.statusCode = authenticated ? 403 : 401;
  res.end(JSON.stringify({ ok: false, error: authenticated ? 'admin_role_required' : 'session_auth_required' }));
}

function endCustomerAccessError(res: { statusCode: number; setHeader: (name: string, value: string | number) => void; end: (chunk?: string) => void }, access: { status: CustomerAccess; retryAfterSeconds?: number }) {
  if (access.status === 'rate_limited') {
    res.statusCode = 429;
    res.setHeader('retry-after', String(access.retryAfterSeconds ?? 60));
    res.end(JSON.stringify({ ok: false, error: 'rate_limited', retryAfterSeconds: access.retryAfterSeconds ?? 60 }));
    return;
  }
  if (access.status === 'rate_limit_unavailable') {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, error: 'rate_limit_unavailable' }));
    return;
  }
  res.statusCode = access.status === 'unauthorized' ? 401 : 403;
  res.end(JSON.stringify({ ok: false, error: access.status }));
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

function mediaUrlsField(body: Record<string, unknown>): string[] | undefined {
  if (body.mediaUrls === undefined) return [];
  return Array.isArray(body.mediaUrls) && body.mediaUrls.length <= 10 && body.mediaUrls.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 2048 && isHttpUrl(value))
    ? body.mediaUrls as string[] : undefined;
}

function isHttpUrl(value: string): boolean {
  try { const protocol = new URL(value).protocol; return protocol === 'http:' || protocol === 'https:'; } catch { return false; }
}

function canonicalPostHash(value: Record<string, unknown>): string {
  const canonical = Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function publicSocialPost(post: import('../../../packages/shared/src/types.js').SocialPost) {
  return { monitorId: post.id, accountId: post.accountId, platform: post.platform, content: post.content, mediaUrls: post.mediaUrls, isDraft: post.isDraft, scheduleAtIso: post.scheduleAtIso, zernioPostId: post.zernioPostId, platformPostId: post.platformPostId, status: post.status, publishedAtIso: post.publishedAtIso, createdAtIso: post.createdAtIso, updatedAtIso: post.updatedAtIso };
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

  if (req.method === 'GET' && req.url === '/admin/service-packages') {
    const session = await requireSessionPrincipal(req); const admin = await requireAdminSession(req);
    if (!admin) { endAdminAccessError(res, Boolean(session)); return; }
    const state = await store.load();
    const servicePackages = state.servicePackages
      .filter((row) => row.status === 'active')
      .map(({ id, name, description, status, monthlyPriceVnd, includedAgents, includedSocialAccounts, features, updatedAtIso }) => ({ id, name, description, status, monthlyPriceVnd, includedAgents, includedSocialAccounts, features, updatedAtIso }));
    res.end(JSON.stringify({ ok: true, servicePackages }));
    return;
  }

  if (req.method === 'GET' && req.url === '/admin/customers') {
    const session = await requireSessionPrincipal(req); const admin = await requireAdminSession(req);
    if (!admin) { endAdminAccessError(res, Boolean(session)); return; }
    const state = await store.load();
    res.end(JSON.stringify({ ok: true, customers: state.customers.map(({ id, name, email, status, servicePackageId, sandboxId, updatedAtIso }) => ({ id, name, email, status, servicePackageId, sandboxId, updatedAtIso })) }));
    return;
  }

  if (req.method === 'POST' && req.url === '/admin/customers') {
    const session = await requireSessionPrincipal(req); const admin = await requireAdminSession(req);
    if (!admin?.userId) { endAdminAccessError(res, Boolean(session)); return; }
    const body = await readJsonBody(req); const id = stringField(body, 'id'); const name = stringField(body, 'name'); const email = stringField(body, 'email');
    if (!id || !name || !/^[-a-zA-Z0-9_]+$/.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'invalid_admin_customer' })); return; }
    try { const customer = await store.createAdminCustomer({ id, name, email, actorUserId: admin.userId }); res.statusCode = 201; res.end(JSON.stringify({ ok: true, customer })); }
    catch (error) { res.statusCode = error instanceof Error && error.message === 'admin_customer_exists' ? 409 : 400; res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'admin_customer_create_failed' })); }
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/admin/customers/') && req.url.endsWith('/operations')) {
    const session = await requireSessionPrincipal(req); const admin = await requireAdminSession(req);
    if (!admin) { endAdminAccessError(res, Boolean(session)); return; }
    const customerId = decodeURIComponent(req.url.slice('/admin/customers/'.length, -'/operations'.length)); const operations = await store.getAdminOperations(customerId);
    if (!operations) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'admin_customer_not_found' })); return; }
    res.end(JSON.stringify({ ok: true, operations })); return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/admin/customers/') && req.url.endsWith('/assignments')) {
    const session = await requireSessionPrincipal(req); const admin = await requireAdminSession(req);
    if (!admin?.userId) { endAdminAccessError(res, Boolean(session)); return; }
    const customerId = decodeURIComponent(req.url.slice('/admin/customers/'.length, -'/assignments'.length)); const idempotencyKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].trim() : ''; const body = await readJsonBody(req); const servicePackageId = stringField(body, 'servicePackageId');
    const profile = body.profileSlot as Record<string, unknown> | undefined; const sandbox = body.sandbox as Record<string, unknown> | undefined; const rawAgents = Array.isArray(body.agents) ? body.agents : [];
    const profileSlot = profile && stringField(profile, 'id') ? { id: stringField(profile, 'id')! } : undefined;
    const sandboxStatus = sandbox && stringField(sandbox, 'status'); const sandboxProvider = sandbox && stringField(sandbox, 'provider');
    const sandboxInput = sandbox && stringField(sandbox, 'id') && (sandboxProvider === 'vps' || sandboxProvider === 'cloud') && ['provisioning', 'starting', 'running', 'degraded', 'stopped', 'failed'].includes(sandboxStatus ?? '') ? { id: stringField(sandbox, 'id')!, provider: sandboxProvider as 'vps' | 'cloud', status: sandboxStatus as import('../../../packages/shared/src/types.js').SandboxStatus, endpoint: stringField(sandbox, 'endpoint') } : undefined;
    const agents = rawAgents.map((value) => value as Record<string, unknown>).flatMap((agent) => { const id = stringField(agent, 'id'); const kind = stringField(agent, 'kind'); const status = stringField(agent, 'status'); return id && (kind === 'ras1-hermes' || kind === 'ras2-openclaw') && ['unknown', 'starting', 'running', 'degraded', 'stopped', 'failed'].includes(status ?? '') ? [{ id, kind: kind as import('../../../packages/shared/src/types.js').AgentKind, status: status as import('../../../packages/shared/src/types.js').AgentStatus }] : []; });
    if (!servicePackageId || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey) || rawAgents.length !== agents.length || (profile && !profileSlot) || (sandbox && !sandboxInput)) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'invalid_admin_assignment' })); return; }
    try { await store.applyAdminAssignment({ customerId, servicePackageId, profileSlot, sandbox: sandboxInput, agents, actorUserId: admin.userId, idempotencyKey }); const operations = await store.getAdminOperations(customerId); res.end(JSON.stringify({ ok: true, operations })); }
    catch (error) { const message = error instanceof Error ? error.message : 'admin_assignment_failed'; res.statusCode = message === 'admin_customer_not_found' || message === 'admin_service_package_not_found' ? 404 : ['admin_profile_slot_unavailable', 'admin_sandbox_assigned', 'admin_agent_assigned', 'admin_agent_sandbox_mismatch', 'admin_assignment_idempotency_conflict'].includes(message) ? 409 : 400; res.end(JSON.stringify({ ok: false, error: message })); }
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
    const state = await consumeOAuthState(url.searchParams.get('state') ?? undefined);
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
      res.setHeader('location', frontendOAuthCallbackUrl(session.token, state.redirectTo, state.frontendOrigin));
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
    const frontendOrigin = allowedFrontendOrigin(url.searchParams.get('frontendOrigin') ?? undefined);
    const state = await createOAuthState(redirectTo, frontendOrigin);
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
    const state = await consumeOAuthState(stringField(body, 'state'));
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

  if (req.method === 'POST' && req.url === '/api/v1/personal-access-tokens') {
    const principal = await requireSessionPrincipal(req);
    if (!principal?.userId) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'session_auth_required' }));
      return;
    }
    const body = await readJsonBody(req);
    const name = stringField(body, 'name');
    const scopes = Array.isArray(body.scopes) && body.scopes.every((scope) => typeof scope === 'string' && scope.length > 0)
      ? body.scopes as string[]
      : [];
    const expiresAtIso = stringField(body, 'expiresAtIso');
    if (!name || scopes.length === 0 || (expiresAtIso && (!Number.isFinite(Date.parse(expiresAtIso)) || Date.parse(expiresAtIso) <= Date.now()))) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'invalid_pat_request' }));
      return;
    }
    const created = await store.createPersonalAccessToken({ customerId: principal.customerId, createdByUserId: principal.userId, name, scopes, expiresAtIso });
    await store.appendAuditLog({ id: `audit_${Date.now()}_${created.token.id}`, customerId: principal.customerId, action: 'pat.created', targetType: 'personal_access_token', targetId: created.token.id, metadata: { scopes: created.token.scopes, tokenPrefix: created.token.tokenPrefix }, createdAtIso: new Date().toISOString() });
    res.statusCode = 201;
    res.end(JSON.stringify({ ok: true, token: { ...created.token, tokenHash: undefined }, plaintextToken: created.plaintext }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/v1/personal-access-tokens') {
    const principal = await requireSessionPrincipal(req);
    if (!principal) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'session_auth_required' })); return; }
    res.end(JSON.stringify({ ok: true, tokens: await store.listPersonalAccessTokens(principal.customerId) }));
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/api/v1/personal-access-tokens/') && req.url.endsWith('/rotate')) {
    const principal = await requireSessionPrincipal(req);
    if (!principal?.userId) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'session_auth_required' })); return; }
    const tokenId = decodeURIComponent(req.url.slice('/api/v1/personal-access-tokens/'.length, -'/rotate'.length));
    const body = await readJsonBody(req);
    const expiresAtIso = stringField(body, 'expiresAtIso');
    if (expiresAtIso && (!Number.isFinite(Date.parse(expiresAtIso)) || Date.parse(expiresAtIso) <= Date.now())) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'invalid_pat_expiry' }));
      return;
    }
    const rotated = await store.rotatePersonalAccessToken({ customerId: principal.customerId, tokenId, createdByUserId: principal.userId, expiresAtIso });
    if (!rotated) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'pat_not_found_or_inactive' })); return; }
    await store.appendAuditLog({ id: `audit_${Date.now()}_${rotated.token.id}`, customerId: principal.customerId, action: 'pat.rotated', targetType: 'personal_access_token', targetId: rotated.token.id, metadata: { previousTokenId: tokenId, scopes: rotated.token.scopes, tokenPrefix: rotated.token.tokenPrefix }, createdAtIso: new Date().toISOString() });
    res.statusCode = 201;
    res.end(JSON.stringify({ ok: true, token: { ...rotated.token, tokenHash: undefined }, plaintextToken: rotated.plaintext }));
    return;
  }

  if (req.method === 'DELETE' && req.url?.startsWith('/api/v1/personal-access-tokens/')) {
    const principal = await requireSessionPrincipal(req);
    if (!principal) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'session_auth_required' })); return; }
    const tokenId = decodeURIComponent(req.url.split('/').pop() ?? '');
    const revoked = await store.revokePersonalAccessToken({ customerId: principal.customerId, tokenId });
    if (!revoked) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'pat_not_found' })); return; }
    await store.appendAuditLog({ id: `audit_${Date.now()}_${tokenId}`, customerId: principal.customerId, action: 'pat.revoked', targetType: 'personal_access_token', targetId: tokenId, metadata: {}, createdAtIso: new Date().toISOString() });
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/api/v1/me') {
    const principal = await store.resolvePrincipal(bearerToken(req) ?? '');
    if (!principal) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }
    res.end(JSON.stringify({ ok: true, principal }));
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

  if (req.method === 'POST' && req.url === '/billing/checkout-intents') {
    const dashboard = await store.getDashboardForSession(bearerToken(req) ?? '');
    if (!dashboard) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }
    const body = await readJsonBody(req);
    const plan = basePlanField(body); const billingCycle = billingCycleField(body);
    const extraConnectSlots = firstNumberField(body, ['extra_connect_slots', 'connect_slots', 'extraConnectSlots']);
    if (!plan || extraConnectSlots === undefined || extraConnectSlots < 0 || !Number.isInteger(extraConnectSlots)) {
      res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'invalid_checkout_intent' })); return;
    }
    const pricing = RAS_PLAN_PRICES[plan];
    const amount = (billingCycle === 'yearly' ? pricing.yearlyMonthly * 12 : pricing.monthly) + (billingCycle === 'yearly' ? extraConnectSlots * 6 * 12 : extraConnectSlots * 6);
    const ttlMinutes = Number.parseInt(process.env.RAS_CHECKOUT_INTENT_TTL_MINUTES ?? '30', 10);
    const expiresAtIso = new Date(Date.now() + (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 30) * 60_000).toISOString();
    const intent = await store.createCheckoutIntent({ customerId: dashboard.customer.id, plan, billingCycle, extraConnectSlots, amount: String(amount), currency: 'USD', expiresAtIso });
    res.statusCode = 201; res.end(JSON.stringify({ ok: true, intent })); return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/billing/checkout-intents/')) {
    const dashboard = await store.getDashboardForSession(bearerToken(req) ?? '');
    if (!dashboard) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return; }
    const intentId = decodeURIComponent(req.url.slice('/billing/checkout-intents/'.length));
    if (!intentId || intentId.includes('/')) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'checkout_intent_not_found' })); return; }
    const intent = await store.getCheckoutIntent(intentId);
    if (!intent || intent.customerId !== dashboard.customer.id) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'checkout_intent_not_found' })); return; }
    res.end(JSON.stringify({ ok: true, intent })); return;
  }

  if (req.method === 'POST' && req.url === '/billing/checkout-intents/bind-paypal-order') {
    if (!requireInternalAccess(req)) { endInternalAccessError(res); return; }
    const body = await readJsonBody(req);
    const intentId = stringField(body, 'intent_id') ?? stringField(body, 'intentId');
    const customerId = stringField(body, 'customer_id') ?? stringField(body, 'customerId');
    const paypalOrderId = stringField(body, 'paypal_order_id') ?? stringField(body, 'paypalOrderId');
    if (!intentId || !customerId || !paypalOrderId) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'invalid_checkout_intent_binding' })); return; }
    const bound = await store.bindCheckoutIntentPaypalOrder({ intentId, customerId, paypalOrderId });
    if (!bound.intent) { res.statusCode = bound.error === 'not_found' ? 404 : 409; res.end(JSON.stringify({ ok: false, error: `checkout_intent_${bound.error}` })); return; }
    res.end(JSON.stringify({ ok: true, intent: bound.intent })); return;
  }

  if (req.method === 'POST' && req.url === '/billing/payments/captured') {
    // Only the trusted server relay may report a provider capture. Pricing and tenant
    // identity are read from an already-bound, durable intent, never browser input.
    if (!requireInternalAccess(req)) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: 'internal_payment_relay_required' })); return; }
    const body = await readJsonBody(req);
    const intentId = stringField(body, 'intent_id') ?? stringField(body, 'intentId');
    const paypalOrderId = stringField(body, 'paypal_order_id') ?? stringField(body, 'paypalOrderId');
    const transactionId = stringField(body, 'transaction_id') ?? stringField(body, 'transactionId');
    const captureStatus = stringField(body, 'capture_status') ?? stringField(body, 'captureStatus') ?? stringField(body, 'status');
    if (!intentId || !paypalOrderId || !transactionId || captureStatus !== 'COMPLETED') { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'invalid_captured_payment' })); return; }
    const intentBefore = await store.getCheckoutIntent(intentId);
    if (!intentBefore) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'checkout_intent_not_found' })); return; }
    const finalized = await store.finalizeCapturedPaymentAndEnqueue({ intentId, customerId: intentBefore.customerId, paypalOrderId, transactionId, rawCapture: typeof body.rawCapture === 'object' && body.rawCapture !== null && !Array.isArray(body.rawCapture) ? body.rawCapture as Record<string, unknown> : body });
    if (!finalized.payment || !finalized.job) { res.statusCode = finalized.error === 'expired' ? 410 : finalized.error === 'not_found' ? 404 : 409; res.end(JSON.stringify({ ok: false, error: `checkout_intent_${finalized.error}` })); return; }
    res.statusCode = 202; res.end(JSON.stringify({ ok: true, payment: { id: finalized.payment.id, provisionStatus: finalized.payment.provisionStatus, transactionId }, provisioning: { queued: finalized.job.status === 'queued', jobId: finalized.job.id } })); return;
  }

  if (req.method === 'POST' && req.url === '/billing/entitlements/provision') {
    // Retired direct provision endpoint. Paid entitlements are activated only
    // by a consumed, PayPal-bound checkout intent through the durable outbox.
    res.statusCode = 410;
    res.end(JSON.stringify({ ok: false, error: 'payment_capture_required' }));
    return;
    /* legacy implementation retained below temporarily for source migration:
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
    */
  }

  const postsMatch = req.url ? /^\/customers\/([^/]+)\/posts(?:\/(drafts|schedules))?$/.exec(new URL(req.url, 'http://localhost').pathname) : null;
  if (postsMatch) {
    const customerId = decodeURIComponent(postsMatch[1]);
    const operation = postsMatch[2];
    const access = await requireCustomerAccess(req, customerId, req.method === 'GET' && !operation ? 'posts:read' : 'posts:write');
    if (access.status !== 'ok') { endCustomerAccessError(res, access); return; }
    if (req.method === 'GET' && !operation) { res.end(JSON.stringify({ ok: true, posts: (await store.listSocialPosts(customerId)).map(publicSocialPost) })); return; }
    if (req.method !== 'POST' || !operation) { res.statusCode = 405; res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); return; }
    const idempotencyKey = firstHeader(req, 'idempotency-key')?.trim();
    let body: Record<string, unknown>;
    try { body = await readJsonBody(req); } catch { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'invalid_json' })); return; }
    const accountId = stringField(body, 'accountId');
    const content = stringField(body, 'content')?.trim();
    const mediaUrls = mediaUrlsField(body);
    const scheduleInput = operation === 'schedules' ? stringField(body, 'scheduleAtIso') : undefined;
    const scheduleAtIso = scheduleInput && Number.isFinite(Date.parse(scheduleInput)) ? new Date(scheduleInput).toISOString() : undefined;
    if (!idempotencyKey || idempotencyKey.length > 256 || !accountId || !content || content.length > 10_000 || mediaUrls === undefined || 'publishNow' in body || (operation === 'schedules' && (!scheduleAtIso || Date.parse(scheduleAtIso) <= Date.now()))) {
      res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'invalid_post_request' })); return;
    }
    const account = await store.getConnectedAccount(accountId);
    if (!account || account.customerId !== customerId) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'connected_account_not_found' })); return; }
    if (account.status !== 'connected') { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: 'connected_account_inactive' })); return; }
    const profileId = account.zernioProfileId ?? account.profileId;
    if (!profileId) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: 'connected_account_profile_missing' })); return; }
    const payloadHash = canonicalPostHash({ operation, accountId, content, mediaUrls, ...(scheduleAtIso ? { scheduleAtIso } : {}) });
    const id = `post_${randomUUID()}`; const jobId = `publish_${randomUUID()}`; const createdAtIso = new Date().toISOString();
    const post: import('../../../packages/shared/src/types.js').SocialPost = { id, jobId, customerId, accountId, profileId, platform: account.platform, content, mediaUrls, isDraft: operation === 'drafts', scheduleAtIso, status: operation === 'drafts' ? 'draft' : 'scheduled', idempotencyKey, idempotencyPayloadHash: payloadHash, createdAtIso, updatedAtIso: createdAtIso };
    const job: import('../../../packages/shared/src/types.js').RasJob = { id: jobId, customerId, profileId, accountId, platform: account.platform, type: 'publish_post', priority: 'P2', status: 'queued', retryCount: 0, payload: { postId: id, accountId, providerAccountId: account.zernioAccountId, platform: account.platform, content, mediaUrls, isDraft: operation === 'drafts', ...(scheduleAtIso ? { scheduleAtIso } : {}) }, createdAtIso };
    const result = await store.createPostAndJobIdempotently({ post, job });
    if (result.conflict) { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: 'idempotency_conflict' })); return; }
    res.statusCode = result.created ? 201 : 200; res.end(JSON.stringify({ ok: true, post: publicSocialPost(result.post), job: { id: result.job.id, type: result.job.type, status: result.job.status } })); return;
  }

  if (req.url?.startsWith('/customers/') && req.url.includes('/connect/facebook/pages')) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const customerId = decodeURIComponent(parts[2] ?? '');
    const access = await requireCustomerAccess(req, customerId, 'accounts:connect');
    if (access.status !== 'ok') {
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
    const profileId = mapping.zernioProfileId ?? mapping.zernioProfileIds[0];
    if (!profileId) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: 'zernio_profile_missing' }));
      return;
    }

    if (req.method === 'GET') {
      const tempToken = url.searchParams.get('tempToken');
      const connectToken = url.searchParams.get('connectToken');
      if (!tempToken || !connectToken) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'missing_facebook_oauth_tokens' }));
        return;
      }
      const pages = await adapter.listFacebookPages({ profileId, tempToken, connectToken });
      res.end(JSON.stringify({ ok: true, pages }));
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/select')) {
      const body = await readJsonBody(req);
      const pageId = stringField(body, 'pageId');
      const tempToken = stringField(body, 'tempToken');
      const connectToken = stringField(body, 'connectToken');
      const rawUserProfile = body.userProfile;
      const userProfile = rawUserProfile && typeof rawUserProfile === 'object' && !Array.isArray(rawUserProfile)
        ? rawUserProfile as Record<string, unknown>
        : undefined;
      if (!pageId || !tempToken || !connectToken || !userProfile) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: 'missing_facebook_page_selection_fields' }));
        return;
      }
      const result = await adapter.selectFacebookPage({
        profileId,
        pageId,
        tempToken,
        connectToken,
        userProfile,
      });
      await refreshZernioAccountsForCustomer(customerId);
      res.end(JSON.stringify({ ok: true, account: result, entitlement: await store.getCustomerMapping(customerId) }));
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
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

    const access = await requireCustomerAccess(req, customerId, 'accounts:connect');
    if (access.status !== 'ok') {
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

  if (req.method === 'DELETE' && req.url?.startsWith('/customers/') && req.url.includes('/connections/')) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const customerId = decodeURIComponent(parts[2] ?? '');
    const accountId = decodeURIComponent(parts[4] ?? '');
    const access = await requireCustomerAccess(req, customerId, 'accounts:connect');
    if (access.status !== 'ok') {
      endCustomerAccessError(res, access);
      return;
    }
    const account = await store.getConnectedAccount(accountId);
    if (!account || account.customerId !== customerId) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'connected_account_not_found' }));
      return;
    }
    if (account.status !== 'disconnected') {
      await adapter.disconnectAccount(account.zernioAccountId);
      await store.upsertConnectedAccount({ ...account, status: 'disconnected', lastVerifiedAtIso: new Date().toISOString() });
    }
    res.end(JSON.stringify({ ok: true, account: { id: account.id, platform: account.platform, status: 'disconnected' } }));
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

  if (req.method === 'POST' && req.url === '/mappings/users') {
    if (!requireInternalAccess(req)) {
      endInternalAccessError(res);
      return;
    }
    const body = await readJsonBody(req);
    const customerId = stringField(body, 'customerId');
    const email = stringField(body, 'email')?.toLowerCase();
    const password = stringField(body, 'password');
    if (!customerId || !email || !password) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'missing_user_mapping_fields' }));
      return;
    }
    const state = await store.load();
    if (!state.customers.some((row) => row.id === customerId)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'customer_not_found' }));
      return;
    }
    const existing = state.users.find((row) => row.email.toLowerCase() === email);
    if (existing && existing.customerId !== customerId) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: 'email_customer_conflict' }));
      return;
    }
    const nowIso = new Date().toISOString();
    const user = await store.upsertUser({
      id: existing?.id ?? `user_${email.replace(/[^a-z0-9]+/g, '_')}_${Date.now().toString(36)}`,
      email,
      displayName: stringField(body, 'displayName') ?? existing?.displayName,
      role: 'owner',
      customerId,
      status: 'active',
      password,
      createdAtIso: existing?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
    });
    res.statusCode = existing ? 200 : 201;
    res.end(JSON.stringify({ ok: true, user: { id: user.id, email: user.email, customerId: user.customerId, role: user.role } }));
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
    if (access.status !== 'ok') {
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
    const access = await requireCustomerAccess(req, decodedCustomerId, 'accounts:read');
    if (access.status !== 'ok') {
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
    if (access.status !== 'ok') {
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
    if (access.status !== 'ok') {
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
    if (access.status !== 'ok') {
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
    if (access.status !== 'ok') {
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

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.split('?')[0].endsWith('/inbox/drafts')) {
    const [, , customerId] = req.url.split('?')[0].split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId, 'inbox:read');
    if (access.status !== 'ok') { endCustomerAccessError(res, access); return; }
    const url = new URL(req.url, 'http://ras.local');
    const conversationId = url.searchParams.get('conversationId') || undefined;
    const drafts = await store.listInboxDraftReplies(decodedCustomerId, conversationId);
    res.end(JSON.stringify({ ok: true, customerId: decodedCustomerId, mode: 'draft_only', drafts }));
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/customers/') && /\/inbox\/drafts\/[^/]+\/approve$/.test(req.url)) {
    const [, , customerId, , , draftId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const decodedDraftId = decodeURIComponent(draftId);
    const access = await requireCustomerAccess(req, decodedCustomerId, 'inbox:approve');
    if (access.status !== 'ok') { endCustomerAccessError(res, access); return; }
    if (!access.principal?.userId) { endCustomerAccessError(res, { status: 'unauthorized' }); return; }
    try {
      const { draft, job } = await store.approveInboxDraftReply({
        customerId: decodedCustomerId,
        draftId: decodedDraftId,
        approvedByUserId: access.principal.userId,
      });
      await store.appendAuditLog({
        id: `audit_${Date.now()}_${draft.id}`,
        customerId: decodedCustomerId,
        action: 'inbox.draft.approved',
        targetType: 'inbox_draft_reply',
        targetId: draft.id,
        metadata: { jobId: job.id, conversationId: draft.conversationId, approvedByUserId: access.principal.userId },
        createdAtIso: new Date().toISOString(),
      });
      res.statusCode = 202;
      res.end(JSON.stringify({ ok: true, mode: 'approved_for_delivery', draft, job: { type: job.type, status: job.status } }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'inbox_draft_approval_failed';
      res.statusCode = message === 'inbox_draft_not_found' ? 404 : message === 'inbox_draft_not_pending_review' || message === 'inbox_reply_job_exists' ? 409 : 400;
      res.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/customers/') && /\/inbox\/conversations\/[^/]+\/drafts$/.test(req.url)) {
    const [, , customerId, , , conversationId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const decodedConversationId = decodeURIComponent(conversationId);
    const access = await requireCustomerAccess(req, decodedCustomerId, 'inbox:draft');
    if (access.status !== 'ok') { endCustomerAccessError(res, access); return; }
    const body = await readJsonBody(req);
    const text = stringField(body, 'text');
    if (!text || !access.principal?.userId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'inbox_draft_text_required' }));
      return;
    }
    try {
      const draft = await store.createInboxDraftReply({
        customerId: decodedCustomerId,
        conversationId: decodedConversationId,
        text,
        createdByUserId: access.principal.userId,
      });
      res.statusCode = 201;
      res.end(JSON.stringify({ ok: true, mode: 'draft_only', draft }));
    } catch (error) {
      res.statusCode = error instanceof Error && error.message === 'inbox_conversation_not_found' ? 404 : 400;
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'inbox_draft_failed' }));
    }
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.endsWith('/inbox/conversations')) {
    const [, , customerId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId, 'inbox:read');
    if (access.status !== 'ok') { endCustomerAccessError(res, access); return; }
    const conversations = await store.listInboxConversations(decodedCustomerId);
    res.end(JSON.stringify({ ok: true, customerId: decodedCustomerId, mode: 'draft_only', conversations }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && /\/inbox\/conversations\/[^/]+\/messages$/.test(req.url)) {
    const [, , customerId, , , conversationId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId, 'inbox:read');
    if (access.status !== 'ok') { endCustomerAccessError(res, access); return; }
    const messages = await store.listInboxMessages(decodedCustomerId, decodeURIComponent(conversationId));
    res.end(JSON.stringify({ ok: true, customerId: decodedCustomerId, conversationId: decodeURIComponent(conversationId), messages }));
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.endsWith('/connection-summary')) {
    const [, , customerId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
    const access = await requireCustomerAccess(req, decodedCustomerId);
    if (access.status !== 'ok') {
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
