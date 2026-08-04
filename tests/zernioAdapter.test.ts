import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostPayload, createProfilePayload, createZernioAdapterFromEnv, DryRunZernioAdapter, LiveZernioAdapter, ZernioApiError } from '../packages/zernio-adapter/src/index.js';

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

test('LiveZernioAdapter unwraps Zernio profile envelope', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ profile: { _id: 'profile_wrapped_123', name: 'Shop A' } }), { status: 200 });

  try {
    const adapter = new LiveZernioAdapter({ apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' });
    const result = await adapter.createProfile({ customerId: 'cust_1', name: 'Shop A' });
    assert.equal(result.zernioProfileId, 'profile_wrapped_123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createProfilePayload does not include undocumented mapping fields', () => {
  assert.deepEqual(Object.keys(createProfilePayload({ customerId: 'cust_1', name: 'Shop A', email: 'owner@example.test' })).sort(), ['description', 'name']);
});

test('LiveZernioAdapter requests Facebook headless mode for branded page selection', async () => {
  let requestedUrl = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ authUrl: 'https://www.facebook.com/dialog/oauth' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const adapter = new LiveZernioAdapter({ apiKey: 'test', baseUrl: 'https://zernio.test/api/v1' });
    await adapter.getConnectUrl({ profileId: 'profile_1', platform: 'facebook', redirectUrl: 'https://app.test/callback' });
    const url = new URL(requestedUrl);
    assert.equal(url.searchParams.get('profileId'), 'profile_1');
    assert.equal(url.searchParams.get('redirect_url'), 'https://app.test/callback');
    assert.equal(url.searchParams.get('headless'), 'true');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LiveZernioAdapter lists Facebook pages without exposing page access tokens', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ pages: [{ id: 'page_1', name: 'Page One', username: 'page.one', picture: { data: { url: 'https://images.example.test/page-one.jpg' } }, access_token: 'secret-page-token', category: 'Brand', tasks: ['MANAGE'] }] }), { status: 200 });
  };
  try {
    const adapter = new LiveZernioAdapter({ apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' });
    const pages = await adapter.listFacebookPages({ profileId: 'profile_1', tempToken: 'temporary-user-token', connectToken: 'short-lived-connect-token' });
    assert.deepEqual(pages, [{ id: 'page_1', name: 'Page One', username: 'page.one', category: 'Brand', avatarUrl: 'https://images.example.test/page-one.jpg', tasks: ['MANAGE'] }]);
    assert.equal(calls[0].url, 'https://example.test/api/v1/connect/facebook/select-page?profileId=profile_1&tempToken=temporary-user-token');
    assert.equal((calls[0].init.headers as Record<string, string>)['x-connect-token'], 'short-lived-connect-token');
    assert.doesNotMatch(JSON.stringify(pages), /secret-page-token/);
  } finally { globalThis.fetch = originalFetch; }
});

test('LiveZernioAdapter selects exactly one Facebook page using the documented payload', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ account: { accountId: 'account_1', platform: 'facebook', username: 'page.one', displayName: 'Page One', isActive: true, selectedPageName: 'Page One' } }), { status: 200 });
  };
  try {
    const adapter = new LiveZernioAdapter({ apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' });
    const result = await adapter.selectFacebookPage({
      profileId: 'profile_1', pageId: 'page_1', tempToken: 'temporary-user-token', connectToken: 'short-lived-connect-token',
      userProfile: { id: 'user_1', name: 'Ngoc Hoang' },
      redirectUrl: 'https://ras.test/connect/callback?platform=facebook',
    });
    assert.deepEqual(result, { accountId: 'account_1', platform: 'facebook', username: 'page.one', displayName: 'Page One', isActive: true, selectedPageName: 'Page One' });
    assert.equal(calls[0].url, 'https://example.test/api/v1/connect/facebook/select-page');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as Record<string, string>)['x-connect-token'], 'short-lived-connect-token');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      profileId: 'profile_1', pageId: 'page_1', tempToken: 'temporary-user-token',
      userProfile: { id: 'user_1', name: 'Ngoc Hoang' },
      redirect_url: 'https://ras.test/connect/callback?platform=facebook',
    });
  } finally { globalThis.fetch = originalFetch; }
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
      accountId: 'account_1',
      platform: 'facebook',
      content: 'Xin chào RAS',
      mediaUrls: ['https://cdn.example/video.mp4'],
      scheduleAtIso: '2026-07-20T10:00:00.000Z',
      requestId: 'job_1',
    });

    assert.deepEqual(result, { zernioPostId: 'post_123', status: 'scheduled' });
    assert.equal(calls[0].url, 'https://example.test/api/v1/posts');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer test-key');
    assert.equal((calls[0].init.headers as Record<string, string>)['x-request-id'], 'job_1');
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
      accountId: 'account_1',
      platform: 'youtube',
      content: 'Video description here',
      mediaUrls: ['https://cdn.example/video.mp4', 'https://cdn.example/cover.png'],
      platformSpecificData: { title: 'My Video Title', visibility: 'public', madeForKids: false },
    }),
    {
      content: 'Video description here',
      platforms: [
        {
          platform: 'youtube',
          accountId: 'account_1',
          platformSpecificData: { title: 'My Video Title', visibility: 'public', madeForKids: false },
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

test('createPostPayload supports safe draft smoke tests', () => {
  assert.deepEqual(
    createPostPayload({
      accountId: 'account_1',
      platform: 'facebook',
      content: 'Draft smoke',
      isDraft: true,
      platformSpecificData: { draft: true },
    }),
    {
      content: 'Draft smoke',
      platforms: [{ platform: 'facebook', accountId: 'account_1', platformSpecificData: { draft: true } }],
      isDraft: true,
    },
  );
});

test('CreatePostInput intentionally rejects root profileId for Zernio /posts', () => {
  const validInput = {
    accountId: 'account_1',
    platform: 'facebook',
    content: 'Only account-scoped target',
  } satisfies Parameters<typeof createPostPayload>[0];

  assert.deepEqual(createPostPayload(validInput), {
    content: 'Only account-scoped target',
    platforms: [{ platform: 'facebook', accountId: 'account_1' }],
    publishNow: true,
  });

  assert.equal('profileId' in validInput, false);
});

test('LiveZernioAdapter sends a conversation message using documented inbox path and idempotency header', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ message: { platformMessageId: 'outbound_1' } }), { status: 200 });
  };
  try {
    const adapter = new LiveZernioAdapter({ apiKey: 'test_key', baseUrl: 'https://zernio.example/api/v1' });
    assert.deepEqual(await adapter.sendInboxMessage({ conversationId: 'conversation/1', accountId: 'account_1', text: 'Đã nhận ạ', requestId: 'reply_job_1' }), { providerMessageId: 'outbound_1' });
    assert.equal(calls[0].url, 'https://zernio.example/api/v1/inbox/conversations/conversation%2F1/messages');
    assert.equal((calls[0].init.headers as Record<string, string>)['x-request-id'], 'reply_job_1');
    assert.equal(calls[0].init.body, JSON.stringify({ accountId: 'account_1', message: 'Đã nhận ạ' }));
  } finally { globalThis.fetch = originalFetch; }
});

test('LiveZernioAdapter surfaces API errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'bad' }), {
    status: 429,
    headers: {
      'Retry-After': '30',
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': '1780000000',
    },
  });

  try {
    const adapter = new LiveZernioAdapter({ apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' });
    await assert.rejects(
      () => adapter.getConnectUrl({ profileId: 'profile_1', platform: 'facebook', redirectUrl: 'https://ras.test/callback' }),
      (error) => error instanceof ZernioApiError
        && error.status === 429
        && error.headers['retry-after'] === '30'
        && error.headers['x-ratelimit-reset'] === '1780000000',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
