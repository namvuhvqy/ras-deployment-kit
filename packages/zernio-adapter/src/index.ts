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

export interface FacebookPageOption {
  id: string;
  name: string;
  username?: string;
  category?: string;
  avatarUrl?: string;
  tasks: string[];
}

export interface FacebookPageSelectionInput {
  profileId: string;
  pageId: string;
  tempToken: string;
  connectToken: string;
  userProfile: Record<string, unknown>;
  redirectUrl?: string;
}

export interface FacebookPageSelectionResult {
  accountId: string;
  platform: 'facebook';
  username?: string;
  displayName?: string;
  isActive?: boolean;
  selectedPageName?: string;
}

export interface CreatePostInput {
  accountId: string;
  platform: Platform;
  content: string;
  mediaUrls?: string[];
  scheduleAtIso?: string;
  isDraft?: boolean;
  /** Stable caller identifier used by Zernio to deduplicate retry-safe requests. */
  requestId?: string;
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

export interface SendInboxMessageInput {
  conversationId: string;
  /** Required by Zernio to select the connected sender account. */
  accountId: string;
  text: string;
  requestId?: string;
}

export interface SendInboxMessageResult {
  providerMessageId: string;
}

export interface ZernioAdapter {
  createProfile(input: CreateProfileInput): Promise<RasCustomer>;
  getConnectUrl(input: ConnectUrlInput): Promise<string>;
  listFacebookPages(input: { profileId: string; tempToken: string; connectToken: string }): Promise<FacebookPageOption[]>;
  selectFacebookPage(input: FacebookPageSelectionInput): Promise<FacebookPageSelectionResult>;
  listAccounts(profileId: string): Promise<ConnectedAccount[]>;
  getAccount(accountId: string): Promise<ConnectedAccount>;
  disconnectAccount(accountId: string): Promise<void>;
  createPost(input: CreatePostInput): Promise<CreatePostResult>;
  sendInboxMessage(input: SendInboxMessageInput): Promise<SendInboxMessageResult>;
}

export class DryRunZernioAdapter implements ZernioAdapter {
  private readonly accountsByProfile = new Map<string, ConnectedAccount[]>();
  private profileSequenceByCustomer = new Map<string, number>();

  async createProfile(input: CreateProfileInput): Promise<RasCustomer> {
    const nextSequence = (this.profileSequenceByCustomer.get(input.customerId) ?? 0) + 1;
    this.profileSequenceByCustomer.set(input.customerId, nextSequence);
    const suffix = nextSequence === 1 ? '' : `_${nextSequence}`;
    return {
      id: input.customerId,
      name: input.name,
      email: input.email,
      zernioProfileId: `zernio_${input.customerId}${suffix}`,
      status: 'active',
    };
  }

  async getConnectUrl(input: ConnectUrlInput): Promise<string> {
    const params = new URLSearchParams({
      profileId: input.profileId,
      redirectUrl: input.redirectUrl,
      dry_run: 'true',
    });
    return `https://zernio.local/connect/${input.platform}?${params.toString()}`;
  }

  async listFacebookPages(): Promise<FacebookPageOption[]> {
    return [];
  }

  async selectFacebookPage(): Promise<FacebookPageSelectionResult> {
    throw new Error('Facebook page selection is unavailable in dry-run mode');
  }

  async listAccounts(profileId: string): Promise<ConnectedAccount[]> {
    return this.accountsByProfile.get(profileId) ?? [];
  }

  async getAccount(accountId: string): Promise<ConnectedAccount> {
    for (const accounts of this.accountsByProfile.values()) {
      const account = accounts.find((row) => row.zernioAccountId === accountId);
      if (account) return account;
    }
    throw new Error(`Dry-run Zernio account not found: ${accountId}`);
  }

  async disconnectAccount(accountId: string): Promise<void> {
    for (const [profileId, accounts] of this.accountsByProfile) {
      this.accountsByProfile.set(profileId, accounts.map((account) => account.zernioAccountId === accountId ? { ...account, status: 'disconnected' } : account));
    }
  }

  async createPost(input: CreatePostInput): Promise<CreatePostResult> {
    return {
      zernioPostId: `dry_post_${input.accountId}_${input.platform}_${Date.now()}`,
      status: input.isDraft ? 'draft' : input.scheduleAtIso ? 'scheduled' : 'queued',
    };
  }

  async sendInboxMessage(input: SendInboxMessageInput): Promise<SendInboxMessageResult> {
    return { providerMessageId: `dry_inbox_${input.conversationId}_${input.requestId ?? Date.now()}` };
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
    const response = await this.request<Record<string, unknown>>('/profiles', {
      method: 'POST',
      body: createProfilePayload(input),
    });
    // Zernio returns either the profile directly or wraps it as { profile: {...} }.
    const profile = unwrapRecord(response, ['profile', 'data']);

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
      headless: 'true',
    });
    const response = await this.request<Record<string, unknown>>(`/connect/${input.platform}?${params.toString()}`);
    return stringFrom(response, ['authUrl', 'url', 'connectUrl']);
  }

  async listFacebookPages(input: { profileId: string; tempToken: string; connectToken: string }): Promise<FacebookPageOption[]> {
    const params = new URLSearchParams({ profileId: input.profileId, tempToken: input.tempToken });
    const response = await this.request<Record<string, unknown>>(`/connect/facebook/select-page?${params.toString()}`, { connectToken: input.connectToken });
    return arrayFrom(response, ['pages', 'data', 'items']).map((row) => {
      const page = asRecord(row);
      return {
        id: stringFrom(page, ['id']),
        name: stringFrom(page, ['name']),
        username: optionalStringFrom(page, ['username']),
        category: optionalStringFrom(page, ['category']),
        avatarUrl: facebookPageAvatarUrl(page),
        tasks: arrayFrom(page, ['tasks']).map(String),
      };
    });
  }

  async selectFacebookPage(input: FacebookPageSelectionInput): Promise<FacebookPageSelectionResult> {
    const response = await this.request<Record<string, unknown>>('/connect/facebook/select-page', {
      method: 'POST',
      body: {
        profileId: input.profileId,
        pageId: input.pageId,
        tempToken: input.tempToken,
        userProfile: input.userProfile,
        ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
      },
      connectToken: input.connectToken,
    });
    const account = unwrapRecord(response, ['account', 'data']);
    return {
      accountId: stringFrom(account, ['accountId', '_id', 'id']),
      platform: 'facebook',
      username: optionalStringFrom(account, ['username']),
      displayName: optionalStringFrom(account, ['displayName']),
      isActive: typeof account.isActive === 'boolean' ? account.isActive : undefined,
      selectedPageName: optionalStringFrom(account, ['selectedPageName']),
    };
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

  async getAccount(accountId: string): Promise<ConnectedAccount> {
    const response = await this.request<Record<string, unknown>>(`/accounts/${encodeURIComponent(accountId)}`);
    return connectedAccountFromRecord(unwrapRecord(response, ['account', 'data']), accountId);
  }

  async disconnectAccount(accountId: string): Promise<void> {
    await this.request(`/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
  }

  async createPost(input: CreatePostInput): Promise<CreatePostResult> {
    const response = await this.request<Record<string, unknown>>('/posts', {
      method: 'POST',
      body: createPostPayload(input),
      requestId: input.requestId,
    });
    const post = unwrapRecord(response, ['post', 'data']);

    return {
      zernioPostId: stringFrom(post, ['_id', 'id', 'postId']),
      status: normalizePostStatus(optionalStringFrom(post, ['status']), Boolean(input.scheduleAtIso)),
    };
  }

  async sendInboxMessage(input: SendInboxMessageInput): Promise<SendInboxMessageResult> {
    const response = await this.request<Record<string, unknown>>(`/inbox/conversations/${encodeURIComponent(input.conversationId)}/messages`, {
      method: 'POST',
      body: { accountId: input.accountId, message: input.text },
      requestId: input.requestId,
    });
    const message = unwrapRecord(response, ['message', 'data']);
    return { providerMessageId: stringFrom(message, ['platformMessageId', '_id', 'id', 'messageId']) };
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown; requestId?: string; connectToken?: string } = {}): Promise<T> {
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
          ...(init.connectToken ? { 'x-connect-token': init.connectToken } : {}),
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

function facebookPageAvatarUrl(page: Record<string, unknown>): string | undefined {
  const direct = optionalStringFrom(page, ['picture', 'profilePicture', 'avatarUrl', 'avatar']);
  if (direct) return direct;
  const picture = asRecord(page.picture);
  const data = asRecord(picture.data);
  return optionalStringFrom(data, ['url']) ?? optionalStringFrom(picture, ['url']);
}

function arrayFrom(value: unknown, keys?: string[]): unknown[] {
  const source = keys ? keys.map((key) => asRecord(value)[key]).find(Array.isArray) : value;
  return Array.isArray(source) ? source : [];
}

function unwrapRecord(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const nested = asRecord(value[key]);
    if (Object.keys(nested).length > 0) return nested;
  }
  return value;
}

function connectedAccountFromRecord(account: Record<string, unknown>, fallbackAccountId: string): ConnectedAccount {
  const platform = stringFrom(account, ['platform']) as Platform;
  return {
    id: stringFrom(account, ['externalId', '_id', 'id'], fallbackAccountId),
    customerId: stringFrom(account, ['customerId', 'externalCustomerId'], ''),
    zernioAccountId: stringFrom(account, ['_id', 'id', 'accountId'], fallbackAccountId),
    zernioProfileId: optionalStringFrom(account, ['profileId']),
    profileId: optionalStringFrom(account, ['profileId']),
    platform,
    username: optionalStringFrom(account, ['username', 'handle', 'name']),
    status: normalizeAccountStatus(optionalStringFrom(account, ['status', 'connectionStatus'])),
    capabilities: arrayFrom(account, ['capabilities']).map(String),
  };
}

function normalizeAccountStatus(status?: string): ConnectedAccount['status'] {
  if (status === 'error') return 'error';
  if (status === 'expired' || status === 'revoked' || status === 'disconnected') return 'disconnected';
  if (status === 'pending') return 'pending';
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
