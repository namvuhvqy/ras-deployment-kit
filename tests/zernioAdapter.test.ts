import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostPayload, createZernioAdapterFromEnv, DryRunZernioAdapter, LiveZernioAdapter, ZernioApiError } from '../packages/zernio-adapter/src/index.js';

test('createZernioAdapterFromEnv defaults to dry-run', () => {
  const adapter = createZernioAdapterFromEnv({});
  assert.ok(adapter instanceof DryRunZernioAdapter);
});

test('createZernioAdapterFromEnv creates live adapter only when requested', () => {
  const adapter = createZernioAdapterFromEnv({ ZERNIO_MODE: 'live', ZERNIO_API_KEY: 'test-key' });
  assert.ok(adapter instanceof LiveZernioAdapter);
});

test('LiveZernioAdapter createProfile sends only documented Zernio fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: 'profile_123', name: 'Shop A' }), { status: 200 });
  };

  try {
    const adapter = new LiveZernioAdapter({ apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' });
    const result = await adapter.createProfile({ customerId: 'cust_1', name: 'Shop A', email: 'owner@example.test' });
    assert.equal(result.zernioProfileId, 'profile_123');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      name: 'Shop A',
      description: 'RAS customer cust_1 <owner@example.test>',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LiveZernioAdapter createPost sends Zernio payload and maps response', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: 'post_123', status: 'scheduled' }), { status: 200 });
  };

  try {
    const adapter = new LiveZernioAdapter({ apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' });
    const result = await adapter.createPost({
      profileId: 'profile_1',
      accountId: 'account_1',
      platform: 'facebook',
      content: 'Xin chào RAS',
      mediaUrls: ['https://cdn.example/video.mp4'],
      scheduleAtIso: '2026-07-20T10:00:00.000Z',
    });

    assert.deepEqual(result, { zernioPostId: 'post_123', status: 'scheduled' });
    assert.equal(calls[0].url, 'https://example.test/api/v1/posts');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      content: 'Xin chào RAS',
      platforms: [{ platform: 'facebook', accountId: 'account_1' }],
      scheduledFor: '2026-07-20T10:00:00.000Z',
      mediaItems: [{ type: 'video', url: 'https://cdn.example/video.mp4' }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createPostPayload follows documented Zernio /posts shape', () => {
  assert.deepEqual(
    createPostPayload({
      profileId: 'profile_1',
      accountId: 'account_1',
      platform: 'youtube',
      content: 'Video description here',
      mediaUrls: ['https://cdn.example/video.mp4', 'https://cdn.example/cover.png'],
      platformSpecificData: { title: 'My Video Title', visibility: 'public', playlistId: 'PLxxx' },
    }),
    {
      content: 'Video description here',
      platforms: [
        {
          platform: 'youtube',
          accountId: 'account_1',
          platformSpecificData: { title: 'My Video Title', visibility: 'public', playlistId: 'PLxxx' },
        },
      ],
      publishNow: true,
      mediaItems: [
        { type: 'video', url: 'https://cdn.example/video.mp4' },
        { type: 'image', url: 'https://cdn.example/cover.png' },
      ],
    },
  );
});

test('LiveZernioAdapter surfaces API errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'bad' }), { status: 429 });

  try {
    const adapter = new LiveZernioAdapter({ apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' });
    await assert.rejects(
      () => adapter.getConnectUrl({ profileId: 'profile_1', platform: 'facebook', redirectUrl: 'https://ras.test/callback' }),
      (error) => error instanceof ZernioApiError && error.status === 429,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
