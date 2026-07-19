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
} from './types.js';

export interface RasPersistentState {
  schemaVersion: number;
  migratedAtIso: string;
  customers: RasCustomer[];
  sandboxes: RasSandboxEnvironment[];
  agents: RasAgentInstance[];
  servicePackages: RasServicePackage[];
  connectedAccounts: ConnectedAccount[];
  jobs: RasJob[];
  webhookEvents: StoredWebhookEvent[];
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

export class JsonRasStore {
  constructor(private readonly path: string) {}

  async migrate(): Promise<MigrationResult> {
    const existing = await this.readIfExists();
    const now = new Date().toISOString();
    const state: RasPersistentState = existing ?? {
      schemaVersion: RAS_SCHEMA_VERSION,
      migratedAtIso: now,
      customers: [],
      sandboxes: [],
      agents: [],
      servicePackages: [],
      connectedAccounts: [],
      jobs: [],
      webhookEvents: [],
      auditLogs: [],
    };

    const previousVersion = state.schemaVersion ?? 0;
    state.schemaVersion = RAS_SCHEMA_VERSION;
    state.migratedAtIso = now;
    state.customers ??= [];
    state.sandboxes ??= [];
    state.agents ??= [];
    state.servicePackages ??= [];
    state.connectedAccounts ??= [];
    state.jobs ??= [];
    state.webhookEvents ??= [];
    state.auditLogs ??= [];
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

  async upsertCustomer(customer: RasCustomer): Promise<RasCustomer> {
    const state = await this.load();
    const index = state.customers.findIndex((row) => row.id === customer.id);
    if (index >= 0) state.customers[index] = customer;
    else state.customers.push(customer);
    await this.write(state);
    return customer;
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
    await this.write(state);
    return { inserted: true, event };
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
