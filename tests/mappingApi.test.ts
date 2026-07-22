import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();

async function withApi<T>(state: Record<string, unknown>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ras-mapping-api-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 19_080 + Math.floor(Math.random() * 1000);
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
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

function emptyState(): Record<string, unknown> {
  return {
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
}

test('mapping endpoints create tenant/customer/profile/account links without root profileId account scope', async () => {
  await withApi(emptyState(), async (baseUrl) => {
    const customerResponse = await fetch(`${baseUrl}/mappings/customers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: 'cust_1',
        tenantId: 'tenant_acme',
        name: 'Acme Shop',
        email: 'owner@acme.test',
        zernioProfileId: 'profile_zernio_1',
      }),
    });
    assert.equal(customerResponse.status, 201);
    const customerPayload = (await customerResponse.json()) as {
      mapping: { customerId: string; tenantId: string; zernioProfileId: string };
    };
    assert.deepEqual(customerPayload.mapping, {
      customerId: 'cust_1',
      tenantId: 'tenant_acme',
      zernioProfileId: 'profile_zernio_1',
    });

    const accountResponse = await fetch(`${baseUrl}/mappings/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acct_local_1',
        customerId: 'cust_1',
        platform: 'facebook',
        zernioProfileId: 'profile_zernio_1',
        zernioAccountId: 'social_account_1',
        handle: '@acme',
        username: 'acme',
        status: 'connected',
        connectedAtIso: now,
        lastVerifiedAtIso: now,
      }),
    });
    assert.equal(accountResponse.status, 201);
    const accountPayload = (await accountResponse.json()) as {
      mapping: { accountId: string; customerId: string; platform: string; zernioAccountId: string; createPostScope: unknown };
    };
    assert.deepEqual(accountPayload.mapping.createPostScope, {
      platforms: [{ platform: 'facebook', accountId: 'social_account_1' }],
    });

    const summaryResponse = await fetch(`${baseUrl}/mappings/customers/cust_1`);
    assert.equal(summaryResponse.status, 200);
    const summary = (await summaryResponse.json()) as {
      mapping: {
        tenantId: string;
        customerId: string;
        zernioProfileId: string;
        accounts: Array<{ accountId: string; zernioAccountId: string; createPostScope: unknown; profileId?: string }>;
      };
    };
    assert.equal(summary.mapping.tenantId, 'tenant_acme');
    assert.equal(summary.mapping.customerId, 'cust_1');
    assert.equal(summary.mapping.zernioProfileId, 'profile_zernio_1');
    assert.equal(summary.mapping.accounts.length, 1);
    assert.equal(summary.mapping.accounts[0].accountId, 'acct_local_1');
    assert.equal(summary.mapping.accounts[0].zernioAccountId, 'social_account_1');
    assert.equal(summary.mapping.accounts[0].profileId, undefined);
    assert.deepEqual(summary.mapping.accounts[0].createPostScope, {
      platforms: [{ platform: 'facebook', accountId: 'social_account_1' }],
    });
  });
});

test('account mapping rejects unknown customer and mismatched zernio profile', async () => {
  const state = emptyState();
  state.customers = [
    {
      id: 'cust_1',
      name: 'Acme Shop',
      zernioProfileId: 'profile_zernio_1',
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    },
  ];

  await withApi(state, async (baseUrl) => {
    const missingCustomer = await fetch(`${baseUrl}/mappings/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acct_missing',
        customerId: 'missing',
        platform: 'facebook',
        zernioProfileId: 'profile_zernio_1',
        zernioAccountId: 'social_account_1',
      }),
    });
    assert.equal(missingCustomer.status, 404);

    const mismatchedProfile = await fetch(`${baseUrl}/mappings/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acct_bad_profile',
        customerId: 'cust_1',
        platform: 'facebook',
        zernioProfileId: 'other_profile',
        zernioAccountId: 'social_account_1',
      }),
    });
    assert.equal(mismatchedProfile.status, 409);
    const payload = (await mismatchedProfile.json()) as { error: string };
    assert.equal(payload.error, 'zernio_profile_mismatch');
  });
});
