import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renderSqlMigration, RAS_SCHEMA_VERSION } from './dbSchema.js';
import type {
  ConnectedAccount,
  RasAgentInstance,
  RasCustomer,
  RasJob,
  RasSandboxEnvironment,
  RasServicePackage,
  RasSession,
  RasUser,
} from './types.js';

export interface RasPersistentState {
  schemaVersion: number;
  migratedAtIso: string;
  users: RasUser[];
  sessions: RasSession[];
  customers: RasCustomer[];
  sandboxes: RasSandboxEnvironment[];
  agents: RasAgentInstance[];
  servicePackages: RasServicePackage[];
  connectedAccounts: ConnectedAccount[];
  jobs: RasJob[];
  webhookEvents: StoredWebhookEvent[];
  webhookFailures: StoredWebhookFailure[];
  webhookStatus: StoredWebhookStatus;
  auditLogs: StoredAuditLog[];
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
      customers: [],
      sandboxes: [],
      agents: [],
      servicePackages: [],
      connectedAccounts: [],
      jobs: [],
      webhookEvents: [],
      webhookFailures: [],
      webhookStatus: { enabled: true, consecutiveFailures: 0 },
      auditLogs: [],
    };

    const previousVersion = state.schemaVersion ?? 0;
    state.schemaVersion = RAS_SCHEMA_VERSION;
    state.migratedAtIso = now;
    state.users ??= [];
    state.sessions ??= [];
    state.customers ??= [];
    state.sandboxes ??= [];
    state.agents ??= [];
    state.servicePackages ??= [];
    state.connectedAccounts ??= [];
    state.jobs ??= [];
    state.webhookEvents ??= [];
    state.webhookFailures ??= [];
    state.webhookStatus ??= { enabled: true, consecutiveFailures: 0 };
    state.auditLogs ??= [];
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
    return {
      user: safeUser,
      customer,
      sandboxes: state.sandboxes.filter((row) => row.customerId === customer.id),
      agents: state.agents.filter((row) => row.customerId === customer.id),
      servicePackages: state.servicePackages.filter((row) => row.id === customer.servicePackageId),
      connectedAccounts: state.connectedAccounts.filter((row) => row.customerId === customer.id),
    };
  }

  async upsertCustomer(customer: RasCustomer): Promise<RasCustomer> {
    const state = await this.load();
    const index = state.customers.findIndex((row) => row.id === customer.id);
    if (index >= 0) state.customers[index] = customer;
    else state.customers.push(customer);
    await this.write(state);
    return customer;
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

  async enqueueJob(job: RasJob): Promise<RasJob> {
    const state = await this.load();
    if (state.jobs.some((row) => row.id === job.id)) throw new Error(`Duplicate job id: ${job.id}`);
    state.jobs.push(job);
    await this.write(state);
    return job;
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

export function createStoreFromEnv(env: NodeJS.ProcessEnv = process.env): JsonRasStore {
  return new JsonRasStore(env.RAS_DB_PATH ?? '/data/ras-store.json');
}
