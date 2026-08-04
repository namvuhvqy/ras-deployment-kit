type RedisEnvironment = Record<string, string | undefined>;

/** Build the Redis URL at runtime so credentials are encoded as URL userinfo. */
export function redisUrlFromEnv(env: RedisEnvironment): string | undefined {
  if (env.RAS_REDIS_URL) return env.RAS_REDIS_URL;
  if (!env.RAS_REDIS_PASSWORD) return undefined;

  const host = env.RAS_REDIS_HOST ?? 'ras-redis';
  const port = env.RAS_REDIS_PORT ?? '6379';
  const database = env.RAS_REDIS_DB ?? '0';
  return `redis://:${encodeURIComponent(env.RAS_REDIS_PASSWORD)}@${host}:${port}/${database}`;
}
