import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();

test('API login returns a bearer token that unlocks dashboard payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-auth-api-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 18_080 + Math.floor(Math.random() * 1000);
  const state = {
    schemaVersion: 1,
    migratedAtIso: now,
    users: [
      {
        id: 'user_1',
        email: 'owner@example.com',
        displayName: 'Owner',
        role: 'owner',
        customerId: 'cust_1',
        status: 'active',
        password: 'secret',
        createdAtIso: now,
        updatedAtIso: now,
      },
    ],
    sessions: [],
    customers: [
      {
        id: 'cust_1',
        name: 'Shop Demo',
        status: 'active',
        sandboxId: 'sandbox_1',
        servicePackageId: 'pkg_growth',
        billingStatus: 'active',
        createdAtIso: now,
      },
      {
        id: 'cust_trial',
        name: 'Trial Demo',
        status: 'trial',
        servicePackageId: 'pkg_growth',
        createdAtIso: now,
      },
      {
        id: 'cust_missing_package',
        name: 'Missing Package Demo',
        status: 'active',
        servicePackageId: 'pkg_missing',
        createdAtIso: now,
      },
    ],
    sandboxes: [
      {
        id: 'sandbox_1',
        customerId: 'cust_1',
        provider: 'vps',
        status: 'running',
        endpoint: 'https://tenant.example.test',
        createdAtIso: now,
        updatedAtIso: now,
      },
    ],
    agents: [
      {
        id: 'agent_1',
        customerId: 'cust_1',
        sandboxId: 'sandbox_1',
        kind: 'ras1-hermes',
        status: 'running',
        updatedAtIso: now,
      },
      {
        id: 'agent_2',
        customerId: 'cust_1',
        sandboxId: 'sandbox_other',
        kind: 'ras2-openclaw',
        status: 'stopped',
        updatedAtIso: now,
      },
    ],
    servicePackages: [
      {
        id: 'pkg_growth',
        name: 'Growth Sandbox',
        status: 'active',
        monthlyPriceVnd: 5000000,
        includedAgents: 2,
        includedSocialAccounts: 5,
        features: ['2 RAS agents', 'Zernio add-on'],
        createdAtIso: now,
        updatedAtIso: now,
      },
    ],
    connectedAccounts: [],
    jobs: [],
    webhookEvents: [],
    auditLogs: [
      {
        id: 'audit_older',
        customerId: 'cust_1',
        action: 'customer.created',
        targetType: 'customer',
        targetId: 'cust_1',
        metadata: { source: 'test' },
        createdAtIso: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'audit_newer',
        customerId: 'cust_1',
        action: 'agent.checked',
        targetType: 'agent',
        targetId: 'agent_1',
        metadata: { source: 'test' },
        createdAtIso: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'audit_other_customer',
        customerId: 'cust_other',
        action: 'customer.created',
        targetType: 'customer',
        targetId: 'cust_other',
        metadata: { source: 'test' },
        createdAtIso: '2026-01-03T00:00:00.000Z',
      },
    ],
  };

  await writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`);
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), RAS_DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('ras-api listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
    });

    const denied = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(denied.status, 401);

    const login = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'secret' }),
    });
    assert.equal(login.status, 200);
    const loginPayload = (await login.json()) as { token: string };
    assert.ok(loginPayload.token.startsWith('sess_'));

    const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { authorization: `Bearer ${loginPayload.token}` },
    });
    assert.equal(dashboard.status, 200);
    const payload = (await dashboard.json()) as { dashboard: { customer: { id: string }; agents: Array<{ kind: string }> } };
    assert.equal(payload.dashboard.customer.id, 'cust_1');
    assert.equal(payload.dashboard.agents[0].kind, 'ras1-hermes');

    const mapping = await fetch(`http://127.0.0.1:${port}/customers/cust_1/mapping`);
    assert.equal(mapping.status, 200);
    const mappingPayload = (await mapping.json()) as {
      mapping: { customer: { id: string }; sandbox: { id: string }; agents: Array<{ id: string }> };
    };
    assert.equal(mappingPayload.mapping.customer.id, 'cust_1');
    assert.equal(mappingPayload.mapping.sandbox.id, 'sandbox_1');
    assert.deepEqual(
      mappingPayload.mapping.agents.map((agent) => agent.id),
      ['agent_1', 'agent_2'],
    );

    const missing = await fetch(`http://127.0.0.1:${port}/customers/missing/mapping`);
    assert.equal(missing.status, 404);

    const lifecycle = await fetch(`http://127.0.0.1:${port}/customers/cust_1/lifecycle-status`);
    assert.equal(lifecycle.status, 200);
    const lifecyclePayload = (await lifecycle.json()) as { lifecycle: { healthy: boolean; blockers: string[] } };
    assert.equal(lifecyclePayload.lifecycle.healthy, false);
    assert.deepEqual(lifecyclePayload.lifecycle.blockers, ['ras2-openclaw_wrong_sandbox', 'ras2-openclaw_stopped']);

    const missingLifecycle = await fetch(`http://127.0.0.1:${port}/customers/missing/lifecycle-status`);
    assert.equal(missingLifecycle.status, 404);

    const auditLogs = await fetch(`http://127.0.0.1:${port}/customers/cust_1/audit-logs`);
    assert.equal(auditLogs.status, 200);
    const auditLogsPayload = (await auditLogs.json()) as { auditLogs: Array<{ id: string; customerId: string }> };
    assert.deepEqual(
      auditLogsPayload.auditLogs.map((log) => log.id),
      ['audit_newer', 'audit_older'],
    );
    assert.ok(auditLogsPayload.auditLogs.every((log) => log.customerId === 'cust_1'));

    const missingAuditLogs = await fetch(`http://127.0.0.1:${port}/customers/missing/audit-logs`);
    assert.equal(missingAuditLogs.status, 404);

    const servicePackage = await fetch(`http://127.0.0.1:${port}/customers/cust_1/service-package`);
    assert.equal(servicePackage.status, 200);
    const servicePackagePayload = (await servicePackage.json()) as { servicePackage: { id: string; includedAgents: number } };
    assert.equal(servicePackagePayload.servicePackage.id, 'pkg_growth');
    assert.equal(servicePackagePayload.servicePackage.includedAgents, 2);

    const missingServicePackage = await fetch(`http://127.0.0.1:${port}/customers/missing/service-package`);
    assert.equal(missingServicePackage.status, 404);

    const unconfiguredServicePackage = await fetch(
      `http://127.0.0.1:${port}/customers/cust_missing_package/service-package`,
    );
    assert.equal(unconfiguredServicePackage.status, 404);
    const unconfiguredServicePackagePayload = (await unconfiguredServicePackage.json()) as { error: string };
    assert.equal(unconfiguredServicePackagePayload.error, 'service_package_not_found');

    const billingState = await fetch(`http://127.0.0.1:${port}/customers/cust_1/billing-state`);
    assert.equal(billingState.status, 200);
    const billingStatePayload = (await billingState.json()) as {
      billingState: { customerId: string; status: string; servicePackageId: string };
    };
    assert.deepEqual(billingStatePayload.billingState, {
      customerId: 'cust_1',
      status: 'active',
      servicePackageId: 'pkg_growth',
    });

    const trialBillingState = await fetch(`http://127.0.0.1:${port}/customers/cust_trial/billing-state`);
    assert.equal(trialBillingState.status, 200);
    const trialBillingStatePayload = (await trialBillingState.json()) as {
      billingState: { customerId: string; status: string; servicePackageId: string };
    };
    assert.deepEqual(trialBillingStatePayload.billingState, {
      customerId: 'cust_trial',
      status: 'trial',
      servicePackageId: 'pkg_growth',
    });

    const missingBillingState = await fetch(`http://127.0.0.1:${port}/customers/missing/billing-state`);
    assert.equal(missingBillingState.status, 404);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});


test('Google OAuth callback upserts user/customer and returns a session token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ras-google-oauth-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 19_080 + Math.floor(Math.random() * 1000);
  const state = {
    schemaVersion: 1,
    migratedAtIso: now,
    users: [],
    sessions: [],
    customers: [],
    sandboxes: [],
    agents: [],
    servicePackages: [],
    connectedAccounts: [],
    jobs: [],
    webhookEvents: [],
    auditLogs: [],
  };
  await writeFile(dbPath, `${JSON.stringify(state, null, 2)}
`);

  const mockGoogle = `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const value = String(url);
      if (value === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'google_access_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (value === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({ email: 'owner@example.com', email_verified: true, name: 'Owner Google' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(url, init);
    };
    await import('./dist/apps/ras-api/src/server.js');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', mockGoogle], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      RAS_DB_PATH: dbPath,
      GOOGLE_OAUTH_CLIENT_ID: 'client_test',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret_test',
      GOOGLE_OAUTH_CALLBACK_URL: 'http://127.0.0.1/callback',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('ras-api listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
    });

    const authStart = await fetch(`http://127.0.0.1:${port}/auth/google?redirectTo=/dashboard`);
    assert.equal(authStart.status, 200);
    const authStartPayload = (await authStart.json()) as { authUrl: string };
    const authUrl = new URL(authStartPayload.authUrl);
    assert.equal(authUrl.hostname, 'accounts.google.com');
    assert.equal(authUrl.searchParams.get('scope'), 'openid email profile');
    assert.equal(authUrl.searchParams.get('client_id'), 'client_test');

    const callback = await fetch(`http://127.0.0.1:${port}/auth/google/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'google_code_test', state: authUrl.searchParams.get('state') }),
    });
    assert.equal(callback.status, 200);
    const callbackPayload = (await callback.json()) as { token: string; customerId: string; redirectTo: string };
    assert.ok(callbackPayload.token.startsWith('sess_'));
    assert.equal(callbackPayload.redirectTo, '/dashboard');
    assert.ok(callbackPayload.customerId.startsWith('cust_owner_example_com'));

    const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { authorization: `Bearer ${callbackPayload.token}` },
    });
    assert.equal(dashboard.status, 200);
    const dashboardPayload = (await dashboard.json()) as { dashboard: { customer: { id: string; email: string } } };
    assert.equal(dashboardPayload.dashboard.customer.id, callbackPayload.customerId);
    assert.equal(dashboardPayload.dashboard.customer.email, 'owner@example.com');
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
