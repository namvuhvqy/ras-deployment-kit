import { createServer, type IncomingMessage } from 'node:http';
import { createStoreFromEnv } from '../../../packages/shared/src/persistentStore.js';
import { createZernioAdapterFromEnv } from '../../../packages/zernio-adapter/src/index.js';

const adapter = createZernioAdapterFromEnv();
const store = createStoreFromEnv();
const port = Number(process.env.PORT ?? 8080);

const ready = store.migrate();

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length);
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

  if (req.url?.startsWith('/customers/') && req.url.endsWith('/connection-summary')) {
    const [, , customerId] = req.url.split('/');
    const summary = await store.getConnectionSummary(decodeURIComponent(customerId));
    res.end(JSON.stringify(summary));
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
