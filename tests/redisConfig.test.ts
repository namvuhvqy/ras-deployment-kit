import assert from 'node:assert/strict';
import test from 'node:test';
import { redisUrlFromEnv } from '../apps/ras-api/src/redisConfig.js';

test('constructs a valid Redis URL when the password contains URL delimiters', () => {
  const redisUrl = redisUrlFromEnv({
    RAS_REDIS_PASSWORD: 'secret/with@delimiters:and?query#fragment',
    RAS_REDIS_HOST: 'ras-redis',
    RAS_REDIS_DB: '0',
  });

  assert.ok(redisUrl);
  const parsed = new URL(redisUrl);
  assert.equal(parsed.protocol, 'redis:');
  assert.equal(parsed.hostname, 'ras-redis');
  assert.equal(parsed.pathname, '/0');
  assert.equal(decodeURIComponent(parsed.password), 'secret/with@delimiters:and?query#fragment');
});

test('preserves an explicitly configured Redis URL', () => {
  assert.equal(
    redisUrlFromEnv({ RAS_REDIS_URL: 'redis://redis.example:6380/2' }),
    'redis://redis.example:6380/2',
  );
});

test('leaves local fallback enabled when Redis is not configured', () => {
  assert.equal(redisUrlFromEnv({}), undefined);
});
