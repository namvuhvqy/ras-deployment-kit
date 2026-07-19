import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renderSqlMigration, RAS_SCHEMA_VERSION } from './dbSchema.js';
import type { ConnectedAccount, RasCustomer, RasJob } from './types.js';

export interface RasPersistentState {
  schemaVersion: number;
  migratedAtIso: string;
  customers: RasCustomer[];
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
      connectedAccounts: [],
      jobs: [],
      webhookEvents: [],
      auditLogs: [],
    };

    const previousVersion = state.schemaVersion ?? 0;
    state.schemaVersion = RAS_SCHEMA_VERSION;
    state.migratedAtIso = now;
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
