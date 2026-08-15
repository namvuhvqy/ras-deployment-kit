import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POST_V1_PLATFORM_CONTRACT_VERSION,
  POST_V1_PLATFORM_CONTRACTS,
  POST_V1_PUBLIC_PLATFORMS,
} from '../packages/shared/src/postV1PlatformContracts.js';
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
  const publicProjection = POST_V1_PLATFORM_CONTRACTS.map(({ platform, text, supportedModes, media }) => ({ platform, text, supportedModes, media }));
  assert.deepEqual(publicProjection, POST_V1_PLATFORM_CONTRACTS);
});
