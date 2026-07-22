import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const now = new Date().toISOString();

async function withApi<T>(state: Record<string, unknown>, env: Record<string, string>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ras-webhook-api-'));
  const dbPath = join(dir, 'ras-store.json');
  const port = 20_080 + Math.floor(Math.random() * 1000);
  await writeFile(dbPath, `${JSON.stringify(state, null, 2)}\n`);
  const child = spawn(process.execPath, ['dist/apps/ras-api/src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, PORT: String(port), RAS_DB_PATH: dbPath },
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

function signature(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

test('zernio webhook verifies raw body signature and deduplicates by header event id', async () => {
  const rawBody = '{"id":"payload_1","type":"post.published","profileId":"profile_1","accountId":"acct_1","nested":{"spacing":"kept"}}';
  await withApi(emptyState(), { ZERNIO_WEBHOOK_SECRET: 'topsecret' }, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/webhooks/zernio`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zernio-event-id': 'evt_header_1',
        'x-zernio-signature': signature('topsecret', rawBody),
      },
      body: rawBody,
    });
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { ok: true, deduped: false, eventId: 'evt_header_1', signature: 'verified' });

    const duplicate = await fetch(`${baseUrl}/webhooks/zernio`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zernio-event-id': 'evt_header_1',
        'x-zernio-signature': signature('topsecret', rawBody),
      },
      body: rawBody,
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { ok: true, deduped: true, eventId: 'evt_header_1', signature: 'verified' });

    const logs = await fetch(`${baseUrl}/webhooks/zernio/status`);
    assert.equal(logs.status, 200);
    const payload = (await logs.json()) as { status: { enabled: boolean; consecutiveFailures: number; recentEvents: Array<{ id: string }> } };
    assert.equal(payload.status.enabled, true);
    assert.equal(payload.status.consecutiveFailures, 0);
    assert.deepEqual(payload.status.recentEvents.map((event) => event.id), ['evt_header_1']);
  });
});

test('zernio webhook rejects bad signatures, records failure log, and auto-disables after ten failures', async () => {
  const rawBody = JSON.stringify({ id: 'payload_bad', type: 'post.failed' });
  await withApi(emptyState(), { ZERNIO_WEBHOOK_SECRET: 'topsecret' }, async (baseUrl) => {
    for (let i = 1; i <= 10; i += 1) {
      const response = await fetch(`${baseUrl}/webhooks/zernio`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zernio-event-id': `evt_bad_${i}`, 'x-zernio-signature': 'bad' },
        body: rawBody,
      });
      assert.equal(response.status, i === 10 ? 503 : 401);
    }

    const disabled = await fetch(`${baseUrl}/webhooks/zernio`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zernio-event-id': 'evt_after_disable',
        'x-zernio-signature': signature('topsecret', rawBody),
      },
      body: rawBody,
    });
    assert.equal(disabled.status, 503);

    const logs = await fetch(`${baseUrl}/webhooks/zernio/status`);
    assert.equal(logs.status, 200);
    const payload = (await logs.json()) as { status: { enabled: boolean; consecutiveFailures: number; recentFailures: Array<{ reason: string; eventId: string }> } };
    assert.equal(payload.status.enabled, false);
    assert.equal(payload.status.consecutiveFailures, 10);
    assert.equal(payload.status.recentFailures[0].reason, 'webhook_disabled');
    assert.equal(payload.status.recentFailures.some((failure) => failure.reason === 'invalid_signature'), true);
  });
});

test('zernio webhook accepts unsigned events when no secret is configured and deduplicates by payload id', async () => {
  await withApi(emptyState(), { ZERNIO_WEBHOOK_SECRET: '' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webhooks/zernio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'payload_only_id', type: 'profile.connected' }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, deduped: false, eventId: 'payload_only_id', signature: 'skipped' });
  });
});
