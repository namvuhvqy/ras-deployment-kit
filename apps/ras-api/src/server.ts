import { createServer } from 'node:http';
import { createStoreFromEnv } from '../../../packages/shared/src/persistentStore.js';
import { createZernioAdapterFromEnv } from '../../../packages/zernio-adapter/src/index.js';

const adapter = createZernioAdapterFromEnv();
const store = createStoreFromEnv();
const port = Number(process.env.PORT ?? 8080);

const ready = store.migrate();

const server = createServer(async (req, res) => {
  await ready;
  res.setHeader('content-type', 'application/json; charset=utf-8');

  if (req.url === '/health') {
    const state = await store.load();
    res.end(JSON.stringify({ ok: true, service: 'ras-api', schemaVersion: state.schemaVersion }));
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
