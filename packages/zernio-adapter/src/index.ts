import type { ConnectedAccount, Platform, RasCustomer } from '../../shared/src/types.js';

export interface CreateProfileInput {
  customerId: string;
  name: string;
  email?: string;
}

export interface ConnectUrlInput {
  profileId: string;
  platform: Platform;
  redirectUrl: string;
}

export interface CreatePostInput {
  profileId: string;
  accountId: string;
  platform: Platform;
  content: string;
  mediaUrls?: string[];
  scheduleAtIso?: string;
  isDraft?: boolean;
  platformSpecificData?: Record<string, unknown>;
}

type MediaType = 'image' | 'video';

export interface PlatformTargetPayload {
  platform: Platform;
  accountId: string;
  customContent?: string;
  customMedia?: Array<{ type: MediaType; url: string }>;
  scheduledFor?: string;
  platformSpecificData?: Record<string, unknown>;
}

export interface ZernioPostPayload {
  content: string;
  platforms: PlatformTargetPayload[];
  publishNow?: boolean;
  scheduledFor?: string;
  isDraft?: boolean;
  mediaItems?: Array<{ type: MediaType; url: string }>;
  metadata?: Record<string, unknown>;
}

export interface CreatePostResult {
  zernioPostId: string;
  status: 'draft' | 'scheduled' | 'published' | 'queued';
}

export interface ZernioAdapter {
  createProfile(input: CreateProfileInput): Promise<RasCustomer>;
  getConnectUrl(input: ConnectUrlInput): Promise<string>;
  listAccounts(profileId: string): Promise<ConnectedAccount[]>;
  createPost(input: CreatePostInput): Promise<CreatePostResult>;
}

export class DryRunZernioAdapter implements ZernioAdapter {
  async createProfile(input: CreateProfileInput): Promise<RasCustomer> {
    return {
      id: input.customerId,
      name: input.name,
      email: input.email,
      zernioProfileId: `dry_profile_${input.customerId}`,
      status: 'active',
    };
  }

  async getConnectUrl(input: ConnectUrlInput): Promise<string> {
    const params = new URLSearchParams({
      profileId: input.profileId,
      redirect_url: input.redirectUrl,
      dry_run: 'true',
    });
    return `https://zernio.local/connect/${input.platform}?${params.toString()}`;
  }

  async listAccounts(profileId: string): Promise<ConnectedAccount[]> {
    return [
      {
        id: `dry_account_${profileId}_facebook`,
        customerId: 'dry_customer',
        zernioAccountId: `dry_zernio_account_${profileId}_facebook`,
        profileId,
        platform: 'facebook',
        username: 'dry-run-page',
        status: 'connected',
        capabilities: ['publish', 'comments', 'inbox'],
      },
    ];
  }

  async createPost(input: CreatePostInput): Promise<CreatePostResult> {
    return {
      zernioPostId: `dry_post_${input.profileId}_${input.platform}_${Date.now()}`,
      status: input.isDraft ? 'draft' : input.scheduleAtIso ? 'scheduled' : 'queued',
    };
  }
}

export interface LiveZernioAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class ZernioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ZernioApiError';
  }
}

export class LiveZernioAdapter implements ZernioAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: LiveZernioAdapterOptions) {
    if (!options.apiKey) throw new Error('Zernio API key is required for live adapter');
    this.baseUrl = (options.baseUrl ?? 'https://zernio.com/api/v1').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async createProfile(input: CreateProfileInput): Promise<RasCustomer> {
    const profile = await this.request<Record<string, unknown>>('/profiles', {
      method: 'POST',
      body: createProfilePayload(input),
    });

    return {
      id: input.customerId,
      name: stringFrom(profile, ['name'], input.name),
      email: input.email,
      zernioProfileId: stringFrom(profile, ['_id', 'id', 'profileId']),
      status: 'active',
    };
  }

  async getConnectUrl(input: ConnectUrlInput): Promise<string> {
    const params = new URLSearchParams({
      profileId: input.profileId,
      redirect_url: input.redirectUrl,
    });
    const response = await this.request<Record<string, unknown>>(`/connect/${input.platform}?${params.toString()}`);
    return stringFrom(response, ['authUrl', 'url', 'connectUrl']);
  }

  async listAccounts(profileId: string): Promise<ConnectedAccount[]> {
    const params = new URLSearchParams({ profileId });
    const response = await this.request<unknown>(`/accounts?${params.toString()}`);
    const rows = Array.isArray(response) ? response : arrayFrom(response, ['accounts', 'data', 'items']);

    return rows.map((row, index) => {
      const account = asRecord(row);
      const platform = stringFrom(account, ['platform']) as Platform;
      const zernioAccountId = stringFrom(account, ['_id', 'id', 'accountId']);
      return {
        id: stringFrom(account, ['externalId'], `${profileId}_${platform}_${index}`),
        customerId: stringFrom(account, ['customerId', 'externalCustomerId'], ''),
        zernioAccountId,
        profileId,
        platform,
        username: optionalStringFrom(account, ['username', 'handle', 'name']),
        status: normalizeAccountStatus(optionalStringFrom(account, ['status'])),
        capabilities: arrayFrom(account, ['capabilities']).map(String),
      };
    });
  }

  async createPost(input: CreatePostInput): Promise<CreatePostResult> {
    const response = await this.request<Record<string, unknown>>('/posts', {
      method: 'POST',
      body: createPostPayload(input),
    });

    return {
      zernioPostId: stringFrom(response, ['_id', 'id', 'postId']),
      status: normalizePostStatus(optionalStringFrom(response, ['status']), Boolean(input.scheduleAtIso)),
    };
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown; requestId?: string } = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          ...(init.requestId ? { 'x-request-id': init.requestId } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const text = await response.text();
      const body = text ? safeJson(text) : null;
      if (!response.ok) {
        throw new ZernioApiError(`Zernio API ${response.status} for ${path}`, response.status, body, rateLimitHeaders(response.headers));
      }
      return body as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createZernioAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): ZernioAdapter {
  const mode = env.ZERNIO_MODE ?? env.RAS_ZERNIO_MODE ?? 'dry-run';
  if (mode === 'live') {
    return new LiveZernioAdapter({
      apiKey: env.ZERNIO_API_KEY ?? '',
      baseUrl: env.ZERNIO_BASE_URL,
      timeoutMs: env.ZERNIO_TIMEOUT_MS ? Number(env.ZERNIO_TIMEOUT_MS) : undefined,
    });
  }
  return new DryRunZernioAdapter();
}

function rateLimitHeaders(headers: Headers): Record<string, string> {
  const keys = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
  return Object.fromEntries(keys.flatMap((key) => {
    const value = headers.get(key);
    return value === null ? [] : [[key, value]];
  }));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function stringFrom(record: Record<string, unknown>, keys: string[], fallback?: string): string {
  const value = optionalStringFrom(record, keys);
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required string field: ${keys.join('|')}`);
}

function optionalStringFrom(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function arrayFrom(value: unknown, keys?: string[]): unknown[] {
  const source = keys ? keys.map((key) => asRecord(value)[key]).find(Array.isArray) : value;
  return Array.isArray(source) ? source : [];
}

function normalizeAccountStatus(status?: string): ConnectedAccount['status'] {
  if (status === 'expired' || status === 'revoked' || status === 'error') return status;
  return 'connected';
}

export function createProfilePayload(input: CreateProfileInput): { name: string; description: string; color?: string; isDefault?: boolean } {
  return {
    name: input.name,
    ...(input.email ? { description: `RAS customer ${input.customerId} <${input.email}>` } : { description: `RAS customer ${input.customerId}` }),
  };
}

export function createPostPayload(input: CreatePostInput): ZernioPostPayload {
  const platformTarget: ZernioPostPayload['platforms'][number] = {
    platform: input.platform,
    accountId: input.accountId,
    ...(input.platformSpecificData ? { platformSpecificData: input.platformSpecificData } : {}),
  };
  return {
    content: input.content,
    platforms: [platformTarget],
    ...(input.isDraft ? { isDraft: true } : input.scheduleAtIso ? { scheduledFor: input.scheduleAtIso } : { publishNow: true }),
    ...(input.mediaUrls && input.mediaUrls.length > 0 ? { mediaItems: input.mediaUrls.map(mediaItemFromUrl) } : {}),
  };
}

function mediaItemFromUrl(url: string): { type: MediaType; url: string } {
  return { type: inferMediaType(url), url };
}

function inferMediaType(url: string): MediaType {
  const pathname = safeUrlPath(url).toLowerCase();
  if (/\.(mp4|mov|m4v|webm)(\?|#|$)/.test(pathname)) return 'video';
  return 'image';
}

function safeUrlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function normalizePostStatus(status: string | undefined, scheduled: boolean): CreatePostResult['status'] {
  if (status === 'draft' || status === 'scheduled' || status === 'published' || status === 'queued') return status;
  return scheduled ? 'scheduled' : 'queued';
}
