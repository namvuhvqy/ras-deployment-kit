import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POST_V1_PLATFORM_CONTRACT_VERSION,
  POST_V1_PLATFORM_CONTRACTS,
  POST_V1_PUBLIC_PLATFORMS,
  getPostV1PlatformSettings,
  validatePostV1PlatformSpecificData,
} from '../packages/shared/src/postV1PlatformContracts.js';

// P2 static allowlist: only manifest-verified setting samples are public.
test('P2 settings registry is typed, fail-closed, and absent for unsupported platforms', () => {
  assert.deepEqual(getPostV1PlatformSettings('facebook'), []);
  assert.deepEqual(getPostV1PlatformSettings('tiktok'), [{ key: 'privacyLevel', type: 'enum', values: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'] }]);
  assert.deepEqual(getPostV1PlatformSettings('youtube'), [
    { key: 'title', type: 'string', maxLength: 100 },
    { key: 'visibility', type: 'enum', values: ['public', 'unlisted', 'private'] },
    { key: 'madeForKids', type: 'boolean' },
  ]);
  assert.deepEqual(validatePostV1PlatformSpecificData('tiktok', { privacyLevel: 'SELF_ONLY' }), { privacyLevel: 'SELF_ONLY' });
  assert.deepEqual(validatePostV1PlatformSpecificData('youtube', { title: 'A title', visibility: 'unlisted', madeForKids: false }), { title: 'A title', visibility: 'unlisted', madeForKids: false });
  assert.equal(validatePostV1PlatformSpecificData('facebook', {}), undefined);
  assert.equal(validatePostV1PlatformSpecificData('facebook', { privacyLevel: 'SELF_ONLY' }), undefined);
  assert.equal(validatePostV1PlatformSpecificData('tiktok', { privacyLevel: 'PRIVATE' }), undefined);
  assert.equal(validatePostV1PlatformSpecificData('youtube', { title: 'x'.repeat(101) }), undefined);
  assert.equal(validatePostV1PlatformSpecificData('youtube', { madeForKids: 'false' }), undefined);
  assert.equal((POST_V1_PUBLIC_PLATFORMS as readonly string[]).includes('whatsapp'), false);
});

import { createPostPayload } from '../packages/zernio-adapter/src/index.js';
import { toZernioPostPlatform } from '../packages/zernio-adapter/src/postPlatformMapping.js';

const expectedPlatforms = [
  'twitter', 'instagram', 'tiktok', 'youtube', 'facebook', 'linkedin', 'bluesky', 'threads',
  'reddit', 'pinterest', 'telegram', 'snapchat', 'google_business', 'discord', 'slack',
] as const;

test('Post V1 registry is versioned and covers exactly the approved public platforms', () => {
  assert.equal(POST_V1_PLATFORM_CONTRACT_VERSION, '1');
  assert.deepEqual(POST_V1_PUBLIC_PLATFORMS, expectedPlatforms);
  assert.deepEqual(POST_V1_PLATFORM_CONTRACTS.map((contract) => contract.platform), expectedPlatforms);
  assert.equal((POST_V1_PUBLIC_PLATFORMS as readonly string[]).includes('whatsapp'), false);
});

test('Post V1 contracts define the current text-only boundary without provider identifiers', () => {
  for (const contract of POST_V1_PLATFORM_CONTRACTS) {
    assert.equal(typeof contract.text.defaultLimit, 'number');
    assert.ok(contract.text.defaultLimit > 0);
    assert.deepEqual(contract.supportedModes, ['publish_now', 'schedule', 'draft']);
    assert.deepEqual(contract.media, []);
    assert.equal('providerId' in contract, false);
    assert.equal('providerPlatform' in contract, false);
  }
});

test('Zernio mapping changes only google_business at the adapter boundary', () => {
  for (const platform of expectedPlatforms) {
    const providerPlatform = platform === 'google_business' ? 'googlebusiness' : platform;
    assert.equal(toZernioPostPlatform(platform), providerPlatform);
    assert.equal(createPostPayload({ accountId: 'account_1', platform, content: 'hello' }).platforms[0]?.platform, providerPlatform);
  }
});

// This is a compile-time DTO boundary assertion: provider identifiers cannot be assigned to public contracts.
test('public registry projection has no provider identifier field', () => {
  const publicProjection = POST_V1_PLATFORM_CONTRACTS.map(({ platform, text, supportedModes, media, platformSpecificData }) => ({ platform, text, supportedModes, media, platformSpecificData }));
  assert.deepEqual(publicProjection, POST_V1_PLATFORM_CONTRACTS);
});
