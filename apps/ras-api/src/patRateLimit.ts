import { createConnection } from 'node:net';

type RedisReply = string | number | null | RedisReply[];

const TOKEN_BUCKET_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])
local values = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAtMs')
local tokens = tonumber(values[1])
local updatedAtMs = tonumber(values[2])
if not tokens then tokens = capacity end
if not updatedAtMs then updatedAtMs = nowMs end
local elapsed = math.max(0, nowMs - updatedAtMs)
tokens = math.min(capacity, tokens + (elapsed * refillPerMs))
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updatedAtMs', nowMs)
redis.call('PEXPIRE', KEYS[1], ttlMs)
local retryAfterMs = 0
if allowed == 0 then retryAfterMs = math.ceil((1 - tokens) / refillPerMs) end
return { allowed, math.floor(tokens), retryAfterMs }
`;

function encodeCommand(parts: Array<string | number>): string {
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(String(part))}\r\n${part}\r\n`).join('')}`;
}

function parseReply(input: Buffer): { reply?: RedisReply; consumed: number } {
  if (!input.length) return { consumed: 0 };
  const marker = String.fromCharCode(input[0]);
  const lineEnd = input.indexOf('\r\n');
  if (lineEnd < 0) return { consumed: 0 };
  const line = input.subarray(1, lineEnd).toString();
  if (marker === '+' || marker === '-') return { reply: line, consumed: lineEnd + 2 };
  if (marker === ':') return { reply: Number(line), consumed: lineEnd + 2 };
  if (marker === '$') {
    const length = Number(line);
    if (length === -1) return { reply: null, consumed: lineEnd + 2 };
    const start = lineEnd + 2;
    if (input.length < start + length + 2) return { consumed: 0 };
    return { reply: input.subarray(start, start + length).toString(), consumed: start + length + 2 };
  }
  if (marker === '*') {
    const count = Number(line);
    if (count === -1) return { reply: null, consumed: lineEnd + 2 };
    let consumed = lineEnd + 2;
    const values: RedisReply[] = [];
    for (let index = 0; index < count; index += 1) {
      const parsed = parseReply(input.subarray(consumed));
      if (parsed.reply === undefined || parsed.consumed === 0) return { consumed: 0 };
      values.push(parsed.reply);
      consumed += parsed.consumed;
    }
    return { reply: values, consumed };
  }
  throw new Error('redis_protocol_error');
}

async function redisCommand(url: URL, command: Array<string | number>): Promise<RedisReply> {
  if (url.protocol !== 'redis:') throw new Error('unsupported_redis_protocol');
  const port = Number(url.port || 6379);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port });
    let buffer = Buffer.alloc(0);
    let authenticated = !url.password;
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); reject(error); } };
    const timer = setTimeout(() => fail(new Error('redis_timeout')), 1500);
    socket.once('error', fail);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (!settled) {
        const parsed = parseReply(buffer);
        if (parsed.reply === undefined) return;
        buffer = buffer.subarray(parsed.consumed);
        if (typeof parsed.reply === 'string' && parsed.reply.startsWith('ERR')) { fail(new Error(parsed.reply)); return; }
        if (!authenticated) {
          if (parsed.reply !== 'OK') { fail(new Error('redis_auth_failed')); return; }
          authenticated = true;
          socket.write(encodeCommand(command));
          continue;
        }
        settled = true;
        clearTimeout(timer);
        socket.end();
        resolve(parsed.reply);
      }
    });
    socket.once('connect', () => socket.write(encodeCommand(url.password ? ['AUTH', decodeURIComponent(url.password)] : command)));
  });
}

export async function consumeRedisPatRateLimit(input: { redisUrl: string; customerId: string; tokenId: string; limit: number; nowMs?: number }): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const url = new URL(input.redisUrl);
  const nowMs = input.nowMs ?? Date.now();
  const refillPerMs = input.limit / 60_000;
  const key = `ras:pat-rate-limit:${input.customerId}:${input.tokenId}`;
  const reply = await redisCommand(url, ['EVAL', TOKEN_BUCKET_SCRIPT, 1, key, input.limit, refillPerMs, nowMs, 120_000]);
  if (!Array.isArray(reply) || reply.length !== 3 || !reply.every((value) => typeof value === 'number')) throw new Error('invalid_redis_rate_limit_reply');
  const [allowed, remaining, retryAfterMs] = reply as number[];
  return { allowed: allowed === 1, remaining, retryAfterSeconds: retryAfterMs > 0 ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : 0 };
}
