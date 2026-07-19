import { createServer } from 'node:http';
import { createZernioAdapterFromEnv } from '../../../packages/zernio-adapter/src/index.js';

const adapter = createZernioAdapterFromEnv();
const port = Number(process.env.PORT ?? 8080);

const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');

  if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true, service: 'ras-api' }));
    return;
  }

  if (req.url === '/dry-run/customer') {
    const customer = await adapter.createProfile({ customerId: 'demo', name: 'Demo Customer' });
    res.end(JSON.stringify(customer));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

server.listen(port, () => {
  console.log(`ras-api listening on :${port}`);
});
