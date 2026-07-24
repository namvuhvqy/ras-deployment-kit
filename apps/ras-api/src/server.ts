import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createStoreFromEnv } from '../../../packages/shared/src/persistentStore.js';
import { createZernioAdapterFromEnv } from '../../../packages/zernio-adapter/src/index.js';

const adapter = createZernioAdapterFromEnv();
const store = createStoreFromEnv();
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

  if (req.method === 'POST' && req.url === '/webhooks/zernio') {
    const status = await store.getWebhookStatus();
    const headerEventId = firstHeader(req, 'x-zernio-event-id');
    if (!status.enabled) {
      await store.recordWebhookFailure({ source: 'zernio', eventId: headerEventId, reason: 'webhook_disabled', statusCode: 503 });
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: 'webhook_disabled' }));
      return;
    }

    const rawBody = await readRawBody(req);
    const signatureStatus = verifySignature(rawBody, firstHeader(req, 'x-zernio-signature'), process.env.ZERNIO_WEBHOOK_SECRET);
    if (signatureStatus === 'invalid' || signatureStatus === 'missing') {
      const failureStatus = await store.recordWebhookFailure({
        source: 'zernio',
        eventId: headerEventId,
        reason: `${signatureStatus}_signature`,
        statusCode: signatureStatus === 'missing' ? 400 : 401,
      });
      res.statusCode = failureStatus.enabled ? (signatureStatus === 'missing' ? 400 : 401) : 503;
      res.end(JSON.stringify({ ok: false, error: `${signatureStatus}_signature`, disabled: !failureStatus.enabled }));
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = rawBody.length ? (JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>) : {};
    } catch {
      const failureStatus = await store.recordWebhookFailure({ source: 'zernio', eventId: headerEventId, reason: 'invalid_json', statusCode: 400 });
      res.statusCode = failureStatus.enabled ? 400 : 503;
      res.end(JSON.stringify({ ok: false, error: 'invalid_json', disabled: !failureStatus.enabled }));
      return;
    }

    const payloadEventId = typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : undefined;
    const eventId = headerEventId ?? payloadEventId;
    if (!eventId) {
      const failureStatus = await store.recordWebhookFailure({ source: 'zernio', reason: 'missing_event_id', statusCode: 400 });
      res.statusCode = failureStatus.enabled ? 400 : 503;
      res.end(JSON.stringify({ ok: false, error: 'missing_event_id', disabled: !failureStatus.enabled }));
      return;
    }

    const eventType = typeof payload.type === 'string' ? payload.type : 'unknown';
    const result = await store.recordWebhookEvent({
      id: eventId,
      source: 'zernio',
      profileId: typeof payload.profileId === 'string' ? payload.profileId : undefined,
      accountId: typeof payload.accountId === 'string' ? payload.accountId : undefined,
      eventType,
      payload,
      processedAtIso: new Date().toISOString(),
      createdAtIso: new Date().toISOString(),
      signatureStatus,
    });
    res.statusCode = result.inserted ? 202 : 200;
    res.end(JSON.stringify({ ok: true, deduped: !result.inserted, eventId, signature: signatureStatus }));
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
    const redirectTo = url.searchParams.get('redirectTo') || '/dashboard';
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

  if (req.method === 'POST' && req.url === '/billing/entitlements/provision') {
    const body = await readJsonBody(req);
    const customerId = stringField(body, 'customerId');
    const maxConnectedAccounts = numberField(body, 'maxConnectedAccounts');
    if (!customerId || maxConnectedAccounts === undefined || maxConnectedAccounts < 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'missing_entitlement_fields' }));
      return;
    }

    const state = await store.load();
    const customer = state.customers.find((row) => row.id === customerId);
    if (!customer) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'customer_not_found' }));
      return;
    }

    let zernioProfileId = customer.zernioProfileId;
    if (!zernioProfileId && maxConnectedAccounts > 0) {
      const profile = await adapter.createProfile({ customerId, name: customer.name, email: customer.email });
      zernioProfileId = profile.zernioProfileId;
    }

    const mapping = await store.upsertCustomerEntitlement({
      customerId,
      maxConnectedAccounts,
      packageStatus: (stringField(body, 'packageStatus') as 'pending' | 'active' | 'past_due' | 'cancelled' | undefined) ?? 'active',
      addOnStatus: objectField(body, 'addOnStatus') as Record<string, 'pending' | 'active' | 'inactive' | 'cancelled'> | undefined,
      zernioProfileId,
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, entitlement: mapping }));
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
    const mapping = await store.getCustomerMapping(decodeURIComponent(customerId));
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
    const state = await store.load();
    const customer = state.customers.find((row) => row.id === decodeURIComponent(customerId));
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
    const lifecycle = await store.getCustomerLifecycleStatus(decodeURIComponent(customerId));
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
    const state = await store.load();
    const customer = state.customers.find((row) => row.id === decodeURIComponent(customerId));
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
    const state = await store.load();
    const customer = state.customers.find((row) => row.id === decodeURIComponent(customerId));
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
    const state = await store.load();
    const customer = state.customers.find((row) => row.id === decodeURIComponent(customerId));
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

  if (req.method === 'GET' && req.url?.startsWith('/customers/') && req.url.endsWith('/connection-summary')) {
    const [, , customerId] = req.url.split('/');
    const decodedCustomerId = decodeURIComponent(customerId);
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
    const customer = await adapter.createProfile({ customerId: 'demo', name: 'Demo Customer' });
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
