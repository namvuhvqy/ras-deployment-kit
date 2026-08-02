import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renderSqlMigration, RAS_SCHEMA_VERSION } from './dbSchema.js';
import type {
  AddOnEntitlement,
  ConnectedAccount,
  RasAgentInstance,
  RasBillingPayment,
  RasCustomer,
  RasEntitlement,
  RasJob,
  InboxConversation,
  InboxDraftReply,
  InboxMessage,
  RasSandboxEnvironment,
  RasServicePackage,
  RasSession,
  RasPersonalAccessToken,
  RasPrincipal,
  RasApiRateLimitBucket,
  SocialPost,
  RasUser,
} from './types.js';

export interface RasPersistentState {
  schemaVersion: number;
  migratedAtIso: string;
  users: RasUser[];
  sessions: RasSession[];
  personalAccessTokens: RasPersonalAccessToken[];
  apiRateLimitBuckets: RasApiRateLimitBucket[];
  customers: RasCustomer[];
  sandboxes: RasSandboxEnvironment[];
  agents: RasAgentInstance[];
  servicePackages: RasServicePackage[];
  connectedAccounts: ConnectedAccount[];
  socialPosts: SocialPost[];
  inboxConversations: InboxConversation[];
  inboxMessages: InboxMessage[];
  inboxDraftReplies: InboxDraftReply[];
  jobs: RasJob[];
  webhookEvents: StoredWebhookEvent[];
  webhookFailures: StoredWebhookFailure[];
  webhookStatus: StoredWebhookStatus;
  auditLogs: StoredAuditLog[];
  billingPayments: RasBillingPayment[];
}

export interface StoredWebhookEvent {
  id: string;
  source: string;
  profileId?: string;
  accountId?: string;
  eventType: string;
  payload: Record<string, unknown>;
  processedAtIso?: string;
  createdAtIso: string;
  signatureStatus?: 'verified' | 'skipped';
}

export interface StoredWebhookFailure {
  id: string;
  source: string;
  eventId?: string;
  reason: string;
  statusCode: number;
  createdAtIso: string;
}

export interface StoredWebhookStatus {
  enabled: boolean;
  consecutiveFailures: number;
  disabledAtIso?: string;
}

export interface StoredAuditLog {
  id: string;
  customerId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata: Record<string, unknown>;
  createdAtIso: string;
}

export interface MigrationResult {
  created: boolean;
  previousVersion: number;
  currentVersion: number;
  sql: string;
}

export interface RasDashboard {
  user: Omit<RasUser, 'password'>;
  customer: RasCustomer;
  state: 'ready' | 'needs_plan';
  entitlement: RasEntitlement & {
    /** Backward-compatible plan label for older frontend consumers. */
    plan: 'none' | string;
    /** Backward-compatible connect slot quota. Prefer entitlement.connectSlots.totalSlots. */
    maxConnectedAccounts: number;
    /** Backward-compatible connected account count. Prefer entitlement.connectSlots.activeConnectedAccounts. */
    activeConnectedAccounts: number;
    /** Backward-compatible add-on status map. Prefer entitlement.addOns. */
    addOnStatus: Record<string, string>;
  };
  cta?: {
    label: string;
    href: string;
  };
  sandboxes: RasSandboxEnvironment[];
  agents: RasAgentInstance[];
  servicePackages: RasServicePackage[];
  connectedAccounts: ConnectedAccount[];
}

export interface CustomerLifecycleStatus {
  customer: RasCustomer;
  sandbox?: RasSandboxEnvironment;
  agents: RasAgentInstance[];
  healthy: boolean;
  blockers: string[];
}

export interface CustomerMapping {
  tenantId?: string;
  customerId: string;
  zernioProfileId?: string;
  zernioProfileIds: string[];
  maxConnectedAccounts: number;
  activeConnectedAccounts: number;
  packageStatus: string;
  addOnStatus: Record<string, string>;
  accounts: AccountMapping[];
}

export interface AccountMapping {
  accountId: string;
  customerId: string;
  platform: ConnectedAccount['platform'];
  zernioProfileId?: string;
  zernioAccountId: string;
  handle?: string;
  username?: string;
  status: ConnectedAccount['status'];
  connectedAtIso?: string;
  lastVerifiedAtIso?: string;
  createPostScope: {
    platforms: Array<{ platform: ConnectedAccount['platform']; accountId: string }>;
  };
}

function toAccountMapping(account: ConnectedAccount): AccountMapping {
  return {
    accountId: account.id,
    customerId: account.customerId,
    platform: account.platform,
    zernioProfileId: account.zernioProfileId,
    zernioAccountId: account.zernioAccountId,
    handle: account.handle,
    username: account.username,
    status: account.status,
    connectedAtIso: account.connectedAtIso,
    lastVerifiedAtIso: account.lastVerifiedAtIso,
    createPostScope: {
      platforms: [{ platform: account.platform, accountId: account.zernioAccountId }],
    },
  };
}

function normalizeEntitlement(customer: RasCustomer, activeConnectedAccounts: number): RasEntitlement {
  const packageStatus = customer.packageStatus ?? (customer.billingStatus === 'active' ? 'active' : 'pending');
  const addOnStatus = customer.addOnStatus ?? {};
  const maxConnectedAccounts = customer.maxConnectedAccounts ?? 0;
  const baseStatus = customer.entitlement?.basePlan.status ?? (packageStatus === 'active' ? 'active' : 'pending');
  const zernioStatus = addOnStatus.zernio ?? customer.entitlement?.connectSlots.status ?? 'inactive';
  const includedSlots = customer.entitlement?.connectSlots.includedSlots ?? 0;
  const purchasedSlots = customer.entitlement?.connectSlots.purchasedSlots ?? maxConnectedAccounts;
  const trialSlots = customer.entitlement?.connectSlots.trialSlots ?? 0;
  const totalSlots = customer.entitlement?.connectSlots.totalSlots ?? includedSlots + purchasedSlots + trialSlots;
  const existingAddOns = customer.entitlement?.addOns ?? [];
  const zernioAddon: AddOnEntitlement = existingAddOns.find((row) => row.id === 'zernio-connect') ?? {
    id: 'zernio-connect',
    name: 'Zernio Connect Slots',
    status: zernioStatus,
    slots: totalSlots,
  };

  return {
    basePlan: {
      planId: customer.entitlement?.basePlan.planId ?? (packageStatus === 'active' ? 'lite' : 'none'),
      status: baseStatus,
      billingCycle: customer.entitlement?.basePlan.billingCycle,
      monthlyPriceUsd: customer.entitlement?.basePlan.monthlyPriceUsd ?? (packageStatus === 'active' ? 19 : undefined),
      vps: customer.entitlement?.basePlan.vps ?? {
        type: packageStatus === 'active' ? 'dedicated' : 'none',
        size: packageStatus === 'active' ? 'small' : undefined,
      },
      agents: customer.entitlement?.basePlan.agents ?? {
        included: packageStatus === 'active' ? 1 : 0,
        kinds: packageStatus === 'active' ? ['ras1-hermes'] : [],
      },
      aiTokens: customer.entitlement?.basePlan.aiTokens,
      activatedAtIso: customer.entitlement?.basePlan.activatedAtIso,
      expiresAtIso: customer.entitlement?.basePlan.expiresAtIso,
    },
    connectSlots: {
      status: zernioStatus,
      includedSlots,
      purchasedSlots,
      trialSlots,
      totalSlots,
      activeConnectedAccounts,
      trialExpiresAtIso: customer.entitlement?.connectSlots.trialExpiresAtIso,
      soloApiEnabled: customer.entitlement?.connectSlots.soloApiEnabled,
    },
    addOns: [zernioAddon, ...existingAddOns.filter((row) => row.id !== 'zernio-connect')],
  };
}

export class JsonRasStore {
  constructor(private readonly path: string) {}

  async migrate(): Promise<MigrationResult> {
    const existing = await this.readIfExists();
    const now = new Date().toISOString();
    const state: RasPersistentState = existing ?? {
      schemaVersion: RAS_SCHEMA_VERSION,
      migratedAtIso: now,
      users: [],
      sessions: [],
      personalAccessTokens: [],
      apiRateLimitBuckets: [],
      customers: [],
      sandboxes: [],
      agents: [],
      servicePackages: [],
      connectedAccounts: [],
      socialPosts: [],
      inboxConversations: [],
      inboxMessages: [],
      inboxDraftReplies: [],
      jobs: [],
      webhookEvents: [],
      webhookFailures: [],
      webhookStatus: { enabled: true, consecutiveFailures: 0 },
      auditLogs: [],
      billingPayments: [],
    };

    const previousVersion = state.schemaVersion ?? 0;
    state.schemaVersion = RAS_SCHEMA_VERSION;
    state.migratedAtIso = now;
    state.users ??= [];
    state.sessions ??= [];
    state.personalAccessTokens ??= [];
    state.apiRateLimitBuckets ??= [];
    state.customers ??= [];
    state.sandboxes ??= [];
    state.agents ??= [];
    state.servicePackages ??= [];
    state.connectedAccounts ??= [];
    state.socialPosts ??= [];
    state.inboxConversations ??= [];
    state.inboxMessages ??= [];
    state.inboxDraftReplies ??= [];
    state.jobs ??= [];
    state.webhookEvents ??= [];
    state.webhookFailures ??= [];
    state.webhookStatus ??= { enabled: true, consecutiveFailures: 0 };
    state.auditLogs ??= [];
    state.billingPayments ??= [];
    this.pruneWebhookLogs(state, now);
    await this.write(state);

    return {
      created: existing === undefined,
      previousVersion,
      currentVersion: RAS_SCHEMA_VERSION,
      sql: renderSqlMigration(),
    };
  }

  async load(): Promise<RasPersistentState> {
    return (await this.readIfExists()) ?? (await this.createEmpty());
  }

  async upsertUser(user: RasUser): Promise<RasUser> {
    const state = await this.load();
    const normalized = { ...user, email: user.email.toLowerCase() };
    const index = state.users.findIndex((row) => row.id === user.id || row.email.toLowerCase() === normalized.email);
    if (index >= 0) state.users[index] = normalized;
    else state.users.push(normalized);
    await this.write(state);
    return normalized;
  }

  async createSession(input: { userId: string; ttlMs?: number; nowIso?: string }): Promise<RasSession> {
    const now = input.nowIso ?? new Date().toISOString();
    const ttlMs = input.ttlMs ?? 24 * 60 * 60 * 1000;
    const entropy = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const session: RasSession = {
      id: `session_${entropy}`,
      token: `sess_${entropy}`,
      userId: input.userId,
      createdAtIso: now,
      expiresAtIso: new Date(Date.parse(now) + ttlMs).toISOString(),
    };
    const state = await this.load();
    state.sessions.push(session);
    await this.write(state);
    return session;
  }


  async upsertGoogleUser(input: { email: string; displayName?: string; nowIso?: string }): Promise<RasUser> {
    const state = await this.load();
    const now = input.nowIso ?? new Date().toISOString();
    const email = input.email.toLowerCase();
    const existing = state.users.find((row) => row.email.toLowerCase() === email);
    if (existing) {
      const updated: RasUser = {
        ...existing,
        displayName: input.displayName ?? existing.displayName,
        status: 'active',
        updatedAtIso: now,
      };
      await this.upsertUser(updated);
      return updated;
    }

    const slug = email.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'google_user';
    const entropy = Math.random().toString(36).slice(2, 8);
    const customerId = `cust_${slug}_${entropy}`;
    const user: RasUser = {
      id: `user_${slug}_${entropy}`,
      email,
      displayName: input.displayName,
      role: 'owner',
      customerId,
      status: 'active',
      createdAtIso: now,
      updatedAtIso: now,
    };
    const customer: RasCustomer = {
      id: customerId,
      name: input.displayName ?? email,
      email,
      status: 'pending',
      billingStatus: 'trial',
      packageStatus: 'pending',
      maxConnectedAccounts: 0,
      activeConnectedAccounts: 0,
      addOnStatus: {},
      createdAtIso: now,
      updatedAtIso: now,
    };
    await this.upsertCustomer({
      ...customer,
      entitlement: normalizeEntitlement(customer, 0),
    });
    return this.upsertUser(user);
  }

  async createSessionForGoogleUser(input: { email: string; displayName?: string; nowIso?: string; ttlMs?: number }): Promise<RasSession> {
    const user = await this.upsertGoogleUser(input);
    return this.createSession({ userId: user.id, nowIso: input.nowIso, ttlMs: input.ttlMs });
  }

  async login(input: { email: string; password: string; nowIso?: string }): Promise<RasSession | undefined> {
    const state = await this.load();
    const email = input.email.toLowerCase();
    const user = state.users.find(
      (row) => row.email.toLowerCase() === email && row.status === 'active' && row.password === input.password,
    );
    if (!user) return undefined;
    return this.createSession({ userId: user.id, nowIso: input.nowIso });
  }

  async getDashboardForSession(token: string, nowIso: string = new Date().toISOString()): Promise<RasDashboard | undefined> {
    const state = await this.load();
    const session = state.sessions.find((row) => row.token === token && Date.parse(row.expiresAtIso) > Date.parse(nowIso));
    if (!session) return undefined;
    const user = state.users.find((row) => row.id === session.userId && row.status === 'active');
    if (!user) return undefined;
    const customer = state.customers.find((row) => row.id === user.customerId);
    if (!customer) return undefined;
    const { password: _password, ...safeUser } = user;
    const connectedAccounts = state.connectedAccounts.filter((row) => row.customerId === customer.id);
    const activeConnectedAccounts = connectedAccounts.filter((row) => row.status === 'connected').length;
    const maxConnectedAccounts = customer.maxConnectedAccounts ?? 0;
    const addOnStatus = customer.addOnStatus ?? {};
    const hasActivePlan = customer.packageStatus === 'active' || customer.billingStatus === 'active' || maxConnectedAccounts > 0;
    const dashboardState: RasDashboard['state'] = hasActivePlan ? 'ready' : 'needs_plan';
    const entitlement = normalizeEntitlement(customer, activeConnectedAccounts);
    return {
      user: safeUser,
      customer: { ...customer, entitlement },
      state: dashboardState,
      entitlement: {
        ...entitlement,
        plan: entitlement.basePlan.planId,
        maxConnectedAccounts: entitlement.connectSlots.totalSlots,
        activeConnectedAccounts,
        addOnStatus,
      },
      cta: dashboardState === 'needs_plan' ? { label: 'Chọn gói để kích hoạt workspace', href: '/pay' } : undefined,
      sandboxes: state.sandboxes.filter((row) => row.customerId === customer.id),
      agents: state.agents.filter((row) => row.customerId === customer.id),
      servicePackages: state.servicePackages.filter((row) => row.id === customer.servicePackageId),
      connectedAccounts,
    };
  }

  async resolvePrincipal(token: string, nowIso: string = new Date().toISOString()): Promise<RasPrincipal | undefined> {
    const state = await this.load();
    const session = state.sessions.find((row) => row.token === token && Date.parse(row.expiresAtIso) > Date.parse(nowIso));
    if (session) {
      const user = state.users.find((row) => row.id === session.userId && row.status === 'active');
      if (user) return { authType: 'session', customerId: user.customerId, userId: user.id, scopes: ['*'] };
    }
    const pat = state.personalAccessTokens.find((row) => row.tokenHash === hashPat(token) && !row.revokedAtIso && (!row.expiresAtIso || Date.parse(row.expiresAtIso) > Date.parse(nowIso)));
    if (!pat) return undefined;
    pat.lastUsedAtIso = nowIso;
    await this.write(state);
    return { authType: 'pat', customerId: pat.customerId, userId: pat.createdByUserId, scopes: pat.scopes, tokenId: pat.id };
  }

  async consumePatRateLimit(input: { customerId: string; tokenId: string; limit: number; windowMs: number; nowIso?: string }): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
    const state = await this.load();
    const nowMs = Date.parse(input.nowIso ?? new Date().toISOString());
    const windowStartedAtMs = Math.floor(nowMs / input.windowMs) * input.windowMs;
    const key = `${input.customerId}:${input.tokenId}:${windowStartedAtMs}`;
    state.apiRateLimitBuckets = state.apiRateLimitBuckets.filter((row) => Date.parse(row.windowStartedAtIso) >= windowStartedAtMs - input.windowMs);
    let bucket = state.apiRateLimitBuckets.find((row) => row.key === key);
    if (!bucket) {
      bucket = { key, customerId: input.customerId, tokenId: input.tokenId, windowStartedAtIso: new Date(windowStartedAtMs).toISOString(), requestCount: 0, updatedAtIso: new Date(nowMs).toISOString() };
      state.apiRateLimitBuckets.push(bucket);
    }
    if (bucket.requestCount >= input.limit) {
      await this.write(state);
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((windowStartedAtMs + input.windowMs - nowMs) / 1000)) };
    }
    bucket.requestCount += 1;
    bucket.updatedAtIso = new Date(nowMs).toISOString();
    await this.write(state);
    return { allowed: true, remaining: input.limit - bucket.requestCount, retryAfterSeconds: 0 };
  }

  async createPersonalAccessToken(input: { customerId: string; createdByUserId: string; name: string; scopes: string[]; expiresAtIso?: string }): Promise<{ token: RasPersonalAccessToken; plaintext: string }> {
    const state = await this.load();
    const plaintext = `ras_pat_${randomBytes(32).toString('base64url')}`;
    const token: RasPersonalAccessToken = {
      id: `pat_${randomBytes(12).toString('hex')}`,
      customerId: input.customerId,
      createdByUserId: input.createdByUserId,
      name: input.name,
      tokenPrefix: plaintext.slice(0, 16),
      tokenHash: hashPat(plaintext),
      scopes: [...new Set(input.scopes)].sort(),
      expiresAtIso: input.expiresAtIso,
      createdAtIso: new Date().toISOString(),
    };
    state.personalAccessTokens.push(token);
    await this.write(state);
    return { token, plaintext };
  }

  async rotatePersonalAccessToken(input: { customerId: string; tokenId: string; createdByUserId: string; expiresAtIso?: string }): Promise<{ token: RasPersonalAccessToken; plaintext: string } | undefined> {
    const state = await this.load();
    const previous = state.personalAccessTokens.find((row) => row.id === input.tokenId && row.customerId === input.customerId);
    if (!previous || previous.revokedAtIso || (previous.expiresAtIso && Date.parse(previous.expiresAtIso) <= Date.now())) return undefined;
    const plaintext = `ras_pat_${randomBytes(32).toString('base64url')}`;
    const now = new Date().toISOString();
    const token: RasPersonalAccessToken = {
      id: `pat_${randomBytes(12).toString('hex')}`,
      customerId: previous.customerId,
      createdByUserId: input.createdByUserId,
      name: previous.name,
      tokenPrefix: plaintext.slice(0, 16),
      tokenHash: hashPat(plaintext),
      scopes: [...previous.scopes],
      expiresAtIso: input.expiresAtIso ?? previous.expiresAtIso,
      createdAtIso: now,
    };
    previous.revokedAtIso = now;
    state.personalAccessTokens.push(token);
    await this.write(state);
    return { token, plaintext };
  }

  async listPersonalAccessTokens(customerId: string): Promise<Array<Omit<RasPersonalAccessToken, 'tokenHash'>>> {
    const state = await this.load();
    return state.personalAccessTokens.filter((row) => row.customerId === customerId).map(({ tokenHash: _hash, ...safe }) => safe);
  }

  async revokePersonalAccessToken(input: { customerId: string; tokenId: string }): Promise<boolean> {
    const state = await this.load();
    const token = state.personalAccessTokens.find((row) => row.id === input.tokenId && row.customerId === input.customerId);
    if (!token || token.revokedAtIso) return false;
    token.revokedAtIso = new Date().toISOString();
    await this.write(state);
    return true;
  }

  async upsertCustomer(customer: RasCustomer): Promise<RasCustomer> {
    const state = await this.load();
    const index = state.customers.findIndex((row) => row.id === customer.id);
    if (index >= 0) state.customers[index] = customer;
    else state.customers.push(customer);
    await this.write(state);
    return customer;
  }

  async recordBillingPaymentCapture(input: Omit<RasBillingPayment, 'id' | 'provisionStatus' | 'retryCount'> & Partial<Pick<RasBillingPayment, 'id' | 'provisionStatus' | 'retryCount'>>): Promise<RasBillingPayment> {
    const state = await this.load();
    const id = input.id ?? `${input.provider}:${input.paypalOrderId}`;
    const existing = state.billingPayments.find((row) => row.id === id || row.paypalOrderId === input.paypalOrderId);
    const payment: RasBillingPayment = {
      ...existing,
      ...input,
      id,
      provisionStatus: existing?.provisionStatus ?? input.provisionStatus ?? 'pending',
      retryCount: existing?.retryCount ?? input.retryCount ?? 0,
      updatedAtIso: input.updatedAtIso,
    };
    const index = state.billingPayments.findIndex((row) => row.id === id || row.paypalOrderId === input.paypalOrderId);
    if (index >= 0) state.billingPayments[index] = payment;
    else state.billingPayments.push(payment);
    await this.write(state);
    return payment;
  }

  async getBillingPayment(id: string): Promise<RasBillingPayment | undefined> {
    const state = await this.load();
    return state.billingPayments.find((row) => row.id === id || row.paypalOrderId === id || row.transactionId === id);
  }

  async markBillingPaymentProvisionFailed(id: string, error: string, nowIso: string = new Date().toISOString()): Promise<RasBillingPayment | undefined> {
    const state = await this.load();
    const payment = state.billingPayments.find((row) => row.id === id || row.paypalOrderId === id || row.transactionId === id);
    if (!payment) return undefined;
    const updated: RasBillingPayment = {
      ...payment,
      provisionStatus: 'pending_retry',
      retryCount: payment.retryCount + 1,
      lastError: error,
      updatedAtIso: nowIso,
    };
    state.billingPayments[state.billingPayments.indexOf(payment)] = updated;
    await this.write(state);
    return updated;
  }

  async markBillingPaymentProvisioned(id: string, nowIso: string = new Date().toISOString()): Promise<RasBillingPayment | undefined> {
    const state = await this.load();
    const payment = state.billingPayments.find((row) => row.id === id || row.paypalOrderId === id || row.transactionId === id);
    if (!payment) return undefined;
    const updated: RasBillingPayment = {
      ...payment,
      provisionStatus: 'provisioned',
      lastError: undefined,
      provisionedAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    state.billingPayments[state.billingPayments.indexOf(payment)] = updated;
    await this.write(state);
    return updated;
  }

  async getCustomerMapping(customerId: string): Promise<CustomerMapping | undefined> {
    const state = await this.load();
    const customer = state.customers.find((row) => row.id === customerId);
    if (!customer) return undefined;
    const accounts = state.connectedAccounts.filter((row) => row.customerId === customer.id);
    return {
      tenantId: customer.tenantId,
      customerId: customer.id,
      zernioProfileId: customer.zernioProfileId,
      zernioProfileIds: customer.zernioProfileIds ?? (customer.zernioProfileId ? [customer.zernioProfileId] : []),
      maxConnectedAccounts: customer.maxConnectedAccounts ?? 0,
      activeConnectedAccounts: accounts.filter((row) => row.status === 'connected').length,
      packageStatus: customer.packageStatus ?? customer.billingStatus ?? 'trial',
      addOnStatus: customer.addOnStatus ?? {},
      accounts: accounts.map(toAccountMapping),
    };
  }

  async upsertCustomerEntitlement(input: {
    customerId: string;
    maxConnectedAccounts: number;
    packageStatus?: RasCustomer['packageStatus'];
    addOnStatus?: RasCustomer['addOnStatus'];
    zernioProfileId?: string;
    zernioProfileIds?: string[];
    entitlement?: RasCustomer['entitlement'];
  }): Promise<CustomerMapping> {
    const state = await this.load();
    const customer = state.customers.find((row) => row.id === input.customerId);
    if (!customer) throw new Error(`Customer not found: ${input.customerId}`);
    const profileIds = Array.from(
      new Set([
        ...(customer.zernioProfileIds ?? []),
        ...(customer.zernioProfileId ? [customer.zernioProfileId] : []),
        ...(input.zernioProfileIds ?? []),
        ...(input.zernioProfileId ? [input.zernioProfileId] : []),
      ]),
    );
    await this.upsertCustomer({
      ...customer,
      zernioProfileId: input.zernioProfileId ?? customer.zernioProfileId ?? profileIds[0],
      zernioProfileIds: profileIds,
      maxConnectedAccounts: input.maxConnectedAccounts,
      activeConnectedAccounts: state.connectedAccounts.filter(
        (row) => row.customerId === customer.id && row.status === 'connected',
      ).length,
      entitlement: input.entitlement ?? customer.entitlement,
      packageStatus: input.packageStatus ?? customer.packageStatus ?? 'active',
      addOnStatus: input.addOnStatus ?? customer.addOnStatus,
      updatedAtIso: new Date().toISOString(),
    });
    const mapping = await this.getCustomerMapping(input.customerId);
    if (!mapping) throw new Error(`Customer not found: ${input.customerId}`);
    return mapping;
  }

  async addCustomerZernioProfile(customerId: string, profileId: string): Promise<CustomerMapping> {
    const state = await this.load();
    const customer = state.customers.find((row) => row.id === customerId);
    if (!customer) throw new Error(`Customer not found: ${customerId}`);
    const profileIds = Array.from(new Set([...(customer.zernioProfileIds ?? []), customer.zernioProfileId, profileId].filter(Boolean) as string[]));
    await this.upsertCustomer({
      ...customer,
      zernioProfileId: customer.zernioProfileId ?? profileId,
      zernioProfileIds: profileIds,
      updatedAtIso: new Date().toISOString(),
    });
    const mapping = await this.getCustomerMapping(customerId);
    if (!mapping) throw new Error(`Customer not found: ${customerId}`);
    return mapping;
  }

  async upsertSandbox(sandbox: RasSandboxEnvironment): Promise<RasSandboxEnvironment> {
    const state = await this.load();
    const index = state.sandboxes.findIndex((row) => row.id === sandbox.id);
    if (index >= 0) state.sandboxes[index] = sandbox;
    else state.sandboxes.push(sandbox);
    await this.write(state);
    return sandbox;
  }

  async upsertAgent(agent: RasAgentInstance): Promise<RasAgentInstance> {
    const state = await this.load();
    const index = state.agents.findIndex((row) => row.id === agent.id);
    if (index >= 0) state.agents[index] = agent;
    else state.agents.push(agent);
    await this.write(state);
    return agent;
  }

  async upsertServicePackage(servicePackage: RasServicePackage): Promise<RasServicePackage> {
    const state = await this.load();
    const index = state.servicePackages.findIndex((row) => row.id === servicePackage.id);
    if (index >= 0) state.servicePackages[index] = servicePackage;
    else state.servicePackages.push(servicePackage);
    await this.write(state);
    return servicePackage;
  }

  async upsertConnectedAccount(account: ConnectedAccount): Promise<ConnectedAccount> {
    const state = await this.load();
    const index = state.connectedAccounts.findIndex(
      (row) => row.customerId === account.customerId && row.zernioAccountId === account.zernioAccountId,
    );
    if (index >= 0) state.connectedAccounts[index] = account;
    else state.connectedAccounts.push(account);
    await this.write(state);
    return account;
  }

  async upsertAccountMapping(account: ConnectedAccount): Promise<AccountMapping> {
    const state = await this.load();
    const customer = state.customers.find((row) => row.id === account.customerId);
    if (!customer) throw new Error(`Customer not found: ${account.customerId}`);
    const allowedProfileIds = new Set([...(customer.zernioProfileIds ?? []), customer.zernioProfileId].filter(Boolean));
    if (allowedProfileIds.size > 0 && account.zernioProfileId && !allowedProfileIds.has(account.zernioProfileId)) {
      throw new Error(`Zernio profile mismatch: ${account.zernioProfileId}`);
    }
    const saved = await this.upsertConnectedAccount(account);
    return toAccountMapping(saved);
  }

  async getConnectedAccount(accountId: string): Promise<ConnectedAccount | undefined> {
    const state = await this.load();
    return state.connectedAccounts.find((account) => account.id === accountId);
  }

  async updateSocialPostStatus(input: {
    postId: string;
    status: SocialPost['status'];
    publishedAtIso?: string;
    errorMessage?: string;
  }): Promise<SocialPost> {
    const state = await this.load();
    const index = state.socialPosts.findIndex((post) => post.zernioPostId === input.postId || post.platformPostId === input.postId || post.id === input.postId);
    if (index < 0) throw new Error(`Social post not found: ${input.postId}`);
    const updated: SocialPost = {
      ...state.socialPosts[index],
      status: input.status,
      ...(input.publishedAtIso ? { publishedAtIso: input.publishedAtIso } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      updatedAtIso: new Date().toISOString(),
    };
    state.socialPosts[index] = updated;
    await this.write(state);
    return updated;
  }

  async upsertSocialPost(input: SocialPost): Promise<SocialPost> {
    const state = await this.load();
    const index = state.socialPosts.findIndex((post) => post.id === input.id || post.jobId === input.jobId);
    if (index < 0) state.socialPosts.push(input);
    else state.socialPosts[index] = { ...state.socialPosts[index], ...input, updatedAtIso: new Date().toISOString() };
    await this.write(state);
    return index < 0 ? input : state.socialPosts[index];
  }

  async attachZernioPostId(jobId: string, zernioPostId: string): Promise<SocialPost> {
    const state = await this.load();
    const index = state.socialPosts.findIndex((post) => post.jobId === jobId);
    if (index < 0) throw new Error(`Social post not found for job: ${jobId}`);
    const updated = { ...state.socialPosts[index], zernioPostId, updatedAtIso: new Date().toISOString() };
    state.socialPosts[index] = updated;
    await this.write(state);
    return updated;
  }

  async recordInboxMessage(input: Omit<InboxMessage, 'createdAtIso'> & {
    createdAtIso?: string;
    participantId?: string;
    participantName?: string;
    participantUsername?: string;
  }): Promise<{ inserted: boolean; message: InboxMessage; conversation: InboxConversation }> {
    const state = await this.load();
    const existing = state.inboxMessages.find((row) => row.customerId === input.customerId && row.providerMessageId === input.providerMessageId);
    if (existing) {
      const conversation = state.inboxConversations.find((row) => row.customerId === input.customerId && row.id === existing.conversationId);
      if (!conversation) throw new Error(`Inbox conversation missing for message: ${existing.id}`);
      return { inserted: false, message: existing, conversation };
    }
    const nowIso = input.createdAtIso ?? new Date().toISOString();
    const message: InboxMessage = { ...input, text: input.text || undefined, createdAtIso: nowIso };
    const conversationIndex = state.inboxConversations.findIndex((row) => row.customerId === input.customerId && row.id === input.conversationId);
    const existingConversation = conversationIndex >= 0 ? state.inboxConversations[conversationIndex] : undefined;
    const conversation: InboxConversation = {
      id: input.conversationId,
      customerId: input.customerId,
      accountId: input.accountId,
      platform: input.platform,
      providerConversationId: existingConversation?.providerConversationId ?? input.conversationId,
      status: existingConversation?.status ?? 'open',
      participantId: input.participantId ?? existingConversation?.participantId,
      participantName: input.participantName ?? existingConversation?.participantName,
      participantUsername: input.participantUsername ?? existingConversation?.participantUsername,
      lastMessageAtIso: input.receivedAtIso,
      unreadCount: (existingConversation?.unreadCount ?? 0) + (input.direction === 'inbound' ? 1 : 0),
      createdAtIso: existingConversation?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
    };
    if (conversationIndex >= 0) state.inboxConversations[conversationIndex] = conversation;
    else state.inboxConversations.push(conversation);
    state.inboxMessages.push(message);
    await this.write(state);
    return { inserted: true, message, conversation };
  }

  async listInboxConversations(customerId: string): Promise<InboxConversation[]> {
    const state = await this.load();
    return state.inboxConversations
      .filter((row) => row.customerId === customerId)
      .sort((left, right) => Date.parse(right.lastMessageAtIso) - Date.parse(left.lastMessageAtIso));
  }

  async listInboxMessages(customerId: string, conversationId: string): Promise<InboxMessage[]> {
    const state = await this.load();
    return state.inboxMessages
      .filter((row) => row.customerId === customerId && row.conversationId === conversationId)
      .sort((left, right) => Date.parse(left.receivedAtIso) - Date.parse(right.receivedAtIso));
  }

  async createInboxDraftReply(input: Omit<InboxDraftReply, 'id' | 'status' | 'sendAttempted' | 'createdAtIso'>): Promise<InboxDraftReply> {
    const state = await this.load();
    const conversation = state.inboxConversations.find((row) => row.customerId === input.customerId && row.id === input.conversationId);
    if (!conversation) throw new Error('inbox_conversation_not_found');
    const text = input.text.trim();
    if (!text) throw new Error('inbox_draft_text_required');
    const draft: InboxDraftReply = {
      id: `inbox_draft_${crypto.randomUUID()}`,
      ...input,
      text,
      status: 'pending_review',
      sendAttempted: false,
      createdAtIso: new Date().toISOString(),
    };
    state.inboxDraftReplies.push(draft);
    await this.write(state);
    return draft;
  }

  async approveInboxDraftReply(input: { customerId: string; draftId: string; approvedByUserId: string }): Promise<{ draft: InboxDraftReply; job: RasJob }> {
    const state = await this.load();
    const index = state.inboxDraftReplies.findIndex((row) => row.customerId === input.customerId && row.id === input.draftId);
    if (index < 0) throw new Error('inbox_draft_not_found');
    const existing = state.inboxDraftReplies[index];
    if (existing.status !== 'pending_review') throw new Error('inbox_draft_not_pending_review');
    const conversation = state.inboxConversations.find((row) => row.customerId === input.customerId && row.id === existing.conversationId);
    if (!conversation) throw new Error('inbox_conversation_not_found');
    const nowIso = new Date().toISOString();
    const job: RasJob = {
      id: `inbox_reply_${existing.id}`,
      customerId: input.customerId,
      profileId: '',
      accountId: conversation.accountId,
      platform: conversation.platform,
      type: 'inbox_reply',
      priority: 'P1',
      status: 'queued',
      retryCount: 0,
      payload: { draftId: existing.id, conversationId: conversation.id, accountId: conversation.accountId, text: existing.text },
      createdAtIso: nowIso,
    };
    if (state.jobs.some((row) => row.id === job.id)) throw new Error('inbox_reply_job_exists');
    const draft: InboxDraftReply = { ...existing, status: 'queued', approvedByUserId: input.approvedByUserId, approvedAtIso: nowIso };
    state.inboxDraftReplies[index] = draft;
    state.jobs.push(job);
    await this.write(state);
    return { draft, job };
  }

  async markInboxDraftReplySent(input: { customerId: string; draftId: string; providerMessageId: string }): Promise<InboxDraftReply> {
    const state = await this.load();
    const index = state.inboxDraftReplies.findIndex((row) => row.customerId === input.customerId && row.id === input.draftId);
    if (index < 0) throw new Error('inbox_draft_not_found');
    const existing = state.inboxDraftReplies[index];
    const saved: InboxDraftReply = {
      ...existing,
      status: 'sent',
      sendAttempted: true,
      providerMessageId: input.providerMessageId,
      sentAtIso: new Date().toISOString(),
      errorMessage: undefined,
    };
    state.inboxDraftReplies[index] = saved;
    await this.write(state);
    return saved;
  }

  async getConnectedAccountsForCustomer(customerId: string): Promise<ConnectedAccount[]> {
    const state = await this.load();
    return state.connectedAccounts.filter((account) => account.customerId === customerId);
  }

  async getConnectionSummary(customerId: string): Promise<{ connected: boolean; accounts: ConnectedAccount[] }> {
    const accounts = await this.getConnectedAccountsForCustomer(customerId);
    return {
      connected: accounts.some(
        (account) =>
          account.status === 'connected' && Boolean(account.connectedAtIso) && Boolean(account.lastVerifiedAtIso),
      ),
      accounts,
    };
  }

  async getCustomerLifecycleStatus(customerId: string): Promise<CustomerLifecycleStatus | undefined> {
    const state = await this.load();
    const customer = state.customers.find((row) => row.id === customerId);
    if (!customer) return undefined;

    const sandbox = customer.sandboxId ? state.sandboxes.find((row) => row.id === customer.sandboxId) : undefined;
    const agents = state.agents.filter((row) => row.customerId === customer.id);
    const blockers: string[] = [];

    if (!sandbox) blockers.push('missing_sandbox');
    else if (sandbox.status !== 'running') blockers.push(`sandbox_${sandbox.status}`);

    const requiredAgentKinds: RasAgentInstance['kind'][] = ['ras1-hermes', 'ras2-openclaw'];
    for (const kind of requiredAgentKinds) {
      const agent = agents.find((row) => row.kind === kind);
      if (!agent) blockers.push(`missing_${kind}`);
      else {
        if (sandbox && agent.sandboxId !== sandbox.id) blockers.push(`${kind}_wrong_sandbox`);
        if (agent.status !== 'running') blockers.push(`${kind}_${agent.status}`);
      }
    }

    return {
      customer,
      sandbox,
      agents,
      healthy: blockers.length === 0,
      blockers,
    };
  }

  async setConnectedAccountVerification(
    update: Pick<ConnectedAccount, 'id' | 'status' | 'connectedAtIso' | 'lastVerifiedAtIso'>,
  ): Promise<ConnectedAccount> {
    const state = await this.load();
    const index = state.connectedAccounts.findIndex((account) => account.id === update.id);
    if (index < 0) throw new Error(`Connected account not found: ${update.id}`);
    const updated = { ...state.connectedAccounts[index], ...update };
    state.connectedAccounts[index] = updated;
    await this.write(state);
    return updated;
  }

  async enqueueJobIfAbsent(job: RasJob): Promise<{ inserted: boolean; job: RasJob }> {
    const state = await this.load();
    const existing = state.jobs.find((row) => row.id === job.id);
    if (existing) return { inserted: false, job: existing };
    if (job.type === 'publish_post' && !state.socialPosts.some((post) => post.jobId === job.id)) {
      const platform = typeof job.payload.platform === 'string' ? job.payload.platform : job.platform;
      if (!platform) throw new Error(`Publish job missing platform: ${job.id}`);
      state.socialPosts.push({ id: job.id, jobId: job.id, customerId: job.customerId, platform: platform as SocialPost['platform'], status: 'queued', updatedAtIso: new Date().toISOString() });
    }
    state.jobs.push(job);
    await this.write(state);
    return { inserted: true, job };
  }

  async enqueueJob(job: RasJob): Promise<RasJob> {
    const inserted = await this.enqueueJobIfAbsent(job);
    if (!inserted.inserted) throw new Error(`Duplicate job id: ${job.id}`);
    return inserted.job;
  }


  async getQueuedJobs(): Promise<RasJob[]> {
    const state = await this.load();
    const now = Date.now();
    return state.jobs.filter(
      (job) => job.status === 'queued' && (!job.runAfterIso || Date.parse(job.runAfterIso) <= now),
    );
  }

  async markJobProcessing(jobId: string): Promise<RasJob> {
    return this.updateJob(jobId, (job) => ({
      ...job,
      status: 'processing',
      processingStartedAtIso: new Date().toISOString(),
      lastError: undefined,
    }));
  }

  async completeJob(jobId: string, result: Record<string, unknown>): Promise<RasJob> {
    return this.updateJob(jobId, (job) => ({
      ...job,
      status: 'completed',
      completedAtIso: new Date().toISOString(),
      result,
      lastError: undefined,
    }));
  }

  async requeueJob(jobId: string, lastError: string, runAfterIso: string): Promise<RasJob> {
    return this.updateJob(jobId, (job) => ({
      ...job,
      status: 'queued',
      retryCount: job.retryCount + 1,
      runAfterIso,
      lastError,
    }));
  }

  async failJob(jobId: string, lastError: string): Promise<RasJob> {
    return this.updateJob(jobId, (job) => ({
      ...job,
      status: 'failed',
      retryCount: job.retryCount + 1,
      failedAtIso: new Date().toISOString(),
      lastError,
    }));
  }

  async recordWebhookEvent(event: StoredWebhookEvent): Promise<{ inserted: boolean; event: StoredWebhookEvent }> {
    const state = await this.load();
    const duplicate = state.webhookEvents.find((row) => row.source === event.source && row.id === event.id);
    if (duplicate) return { inserted: false, event: duplicate };
    state.webhookEvents.push(event);
    state.webhookStatus = { enabled: true, consecutiveFailures: 0 };
    this.pruneWebhookLogs(state);
    await this.write(state);
    return { inserted: true, event };
  }

  async recordWebhookFailure(
    failure: Omit<StoredWebhookFailure, 'id' | 'createdAtIso'> & { createdAtIso?: string },
  ): Promise<StoredWebhookStatus> {
    const state = await this.load();
    const createdAtIso = failure.createdAtIso ?? new Date().toISOString();
    const current = state.webhookStatus ?? { enabled: true, consecutiveFailures: 0 };
    const consecutiveFailures = failure.reason === 'webhook_disabled' ? current.consecutiveFailures : current.consecutiveFailures + 1;
    state.webhookFailures.push({
      id: `webhook_failure_${Date.now()}_${state.webhookFailures.length}`,
      source: failure.source,
      eventId: failure.eventId,
      reason: failure.reason,
      statusCode: failure.statusCode,
      createdAtIso,
    });
    state.webhookStatus = {
      enabled: current.enabled && consecutiveFailures < 10,
      consecutiveFailures,
      disabledAtIso: current.disabledAtIso ?? (consecutiveFailures >= 10 ? createdAtIso : undefined),
    };
    this.pruneWebhookLogs(state, createdAtIso);
    await this.write(state);
    return state.webhookStatus;
  }

  async getWebhookStatus(): Promise<StoredWebhookStatus & { recentEvents: StoredWebhookEvent[]; recentFailures: StoredWebhookFailure[] }> {
    const state = await this.load();
    this.pruneWebhookLogs(state);
    await this.write(state);
    return {
      ...(state.webhookStatus ?? { enabled: true, consecutiveFailures: 0 }),
      recentEvents: [...state.webhookEvents].sort((left, right) => Date.parse(right.createdAtIso) - Date.parse(left.createdAtIso)),
      recentFailures: [...state.webhookFailures].sort((left, right) => Date.parse(right.createdAtIso) - Date.parse(left.createdAtIso)),
    };
  }

  async appendAuditLog(log: StoredAuditLog): Promise<StoredAuditLog> {
    const state = await this.load();
    state.auditLogs.push(log);
    await this.write(state);
    return log;
  }

  private async createEmpty(): Promise<RasPersistentState> {
    await this.migrate();
    return (await this.readIfExists())!;
  }

  private async updateJob(jobId: string, updater: (job: RasJob) => RasJob): Promise<RasJob> {
    const state = await this.load();
    const index = state.jobs.findIndex((job) => job.id === jobId);
    if (index < 0) throw new Error(`Job not found: ${jobId}`);
    const updated = updater(state.jobs[index]);
    state.jobs[index] = updated;
    await this.write(state);
    return updated;
  }

  private pruneWebhookLogs(state: RasPersistentState, nowIso: string = new Date().toISOString()): void {
    const cutoff = Date.parse(nowIso) - 30 * 24 * 60 * 60 * 1000;
    state.webhookEvents = (state.webhookEvents ?? []).filter((row) => Date.parse(row.createdAtIso) >= cutoff);
    state.webhookFailures = (state.webhookFailures ?? []).filter((row) => Date.parse(row.createdAtIso) >= cutoff);
  }

  private async readIfExists(): Promise<RasPersistentState | undefined> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw) as RasPersistentState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async write(state: RasPersistentState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function hashPat(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createStoreFromEnv(env: NodeJS.ProcessEnv = process.env): JsonRasStore {
  return new JsonRasStore(env.RAS_DB_PATH ?? '/data/ras-store.json');
}
