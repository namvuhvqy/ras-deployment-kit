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
    res.end(JSON.stringify({ ...summary, customerId: decodedCustomerId, sync }));
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
