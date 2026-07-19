import { setTimeout as sleep } from 'node:timers/promises';
import { FairProfileQueue } from '../../queue/src/fairQueue.js';
import type { RasJob } from '../../shared/src/types.js';
import type { JsonRasStore } from '../../shared/src/persistentStore.js';
import type { CreatePostInput, ZernioAdapter } from '../../zernio-adapter/src/index.js';

export interface WorkerTopicMap {
  backend: number;
  zernio: number;
  frontend: number;
  ops: number;
}

export interface WorkerOptions {
  batchSize: number;
  idleMs: number;
  maxRetries: number;
  baseRetryMs: number;
  singleRun: boolean;
  dryRun: boolean;
  notifier?: TopicNotifier;
}

export interface TopicNotifier {
  send(topicId: number, message: string): Promise<void>;
}

export interface WorkerRunResult {
  processed: number;
  completed: number;
  failed: number;
  requeued: number;
}

export class RasJobWorker {
  constructor(
    private readonly store: JsonRasStore,
    private readonly adapter: ZernioAdapter,
    private readonly options: WorkerOptions,
  ) {}

  async runOnce(): Promise<WorkerRunResult> {
    const dueJobs = await this.store.getQueuedJobs();
    const queue = new FairProfileQueue();
    for (const job of dueJobs) queue.enqueue(job);

    const result: WorkerRunResult = { processed: 0, completed: 0, failed: 0, requeued: 0 };
    while (queue.size() > 0 && result.processed < this.options.batchSize) {
      const job = queue.dequeue();
      if (!job) break;
      result.processed += 1;
      const outcome = await this.processJob(job);
      result.completed += outcome === 'completed' ? 1 : 0;
      result.failed += outcome === 'failed' ? 1 : 0;
      result.requeued += outcome === 'requeued' ? 1 : 0;
    }
    return result;
  }

  async runForever(signal?: AbortSignal): Promise<void> {
    await this.store.migrate();
    while (!signal?.aborted) {
      const result = await this.runOnce();
      if (this.options.singleRun) return;
      if (result.processed === 0) await sleep(this.options.idleMs, undefined, { signal }).catch(() => undefined);
    }
  }

  private async processJob(job: RasJob): Promise<'completed' | 'failed' | 'requeued'> {
    await this.store.markJobProcessing(job.id);
    try {
      const metadata = await this.execute(job);
      await this.store.completeJob(job.id, metadata);
      await this.store.appendAuditLog({
        id: `audit_${Date.now()}_${job.id}`,
        customerId: job.customerId,
        action: `job.${job.type}.completed`,
        targetType: 'job',
        targetId: job.id,
        metadata,
        createdAtIso: new Date().toISOString(),
      });
      await this.options.notifier?.send(topicForJob(job), `✅ RAS job completed: ${job.type} / ${job.id}`);
      return 'completed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (job.retryCount + 1 <= this.options.maxRetries) {
        const runAfterIso = new Date(Date.now() + retryDelayMs(job.retryCount, this.options.baseRetryMs)).toISOString();
        await this.store.requeueJob(job.id, message, runAfterIso);
        await this.options.notifier?.send(topicForJob(job), `⚠️ RAS job requeued: ${job.type} / ${job.id}\n${message}`);
        return 'requeued';
      }
      await this.store.failJob(job.id, message);
      await this.options.notifier?.send(topicForJob(job), `❌ RAS job failed: ${job.type} / ${job.id}\n${message}`);
      return 'failed';
    }
  }

  private async execute(job: RasJob): Promise<Record<string, unknown>> {
    if (job.type === 'publish_post') {
      const input = assertPublishPostPayload(job);
      if (this.options.dryRun) {
        return { dryRun: true, zernioPostId: `dry_worker_${job.id}` };
      }
      const result = await this.adapter.createPost(input);
      return { dryRun: false, ...result };
    }

    if (job.type === 'inbox_reply' || job.type === 'analytics_sync' || job.type === 'webhook_process') {
      if (this.options.dryRun) return { dryRun: true, skippedLiveSideEffect: job.type };
    }

    throw new Error(`Unsupported live job type: ${job.type}`);
  }
}

export function workerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env, notifier?: TopicNotifier): WorkerOptions {
  return {
    batchSize: numberFromEnv(env.RAS_WORKER_BATCH_SIZE, 20),
    idleMs: numberFromEnv(env.RAS_WORKER_IDLE_MS, 5_000),
    maxRetries: numberFromEnv(env.RAS_WORKER_MAX_RETRIES, 5),
    baseRetryMs: numberFromEnv(env.RAS_WORKER_BASE_RETRY_MS, 60_000),
    singleRun: env.RAS_WORKER_SINGLE_RUN === 'true',
    dryRun: (env.ZERNIO_MODE ?? env.RAS_ZERNIO_MODE ?? 'dry-run') !== 'live',
    notifier,
  };
}

function assertPublishPostPayload(job: RasJob): CreatePostInput {
  const payload = asRecord(job.payload);
  const content = requiredString(payload, 'content');
  const platform = requiredString(payload, 'platform') as CreatePostInput['platform'];
  const accountId = job.accountId ?? requiredString(payload, 'accountId');
  const mediaUrls = arrayOfStrings(payload.mediaUrls);
  const scheduleAtIso = optionalString(payload.scheduleAtIso);
  const platformSpecificData = asOptionalRecord(payload.platformSpecificData);
  return {
    profileId: job.profileId,
    accountId,
    platform,
    content,
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
    ...(scheduleAtIso ? { scheduleAtIso } : {}),
    ...(platformSpecificData ? { platformSpecificData } : {}),
  };
}

function retryDelayMs(retryCount: number, baseRetryMs: number): number {
  return Math.min(baseRetryMs * 2 ** retryCount, 30 * 60_000);
}

function topicForJob(job: RasJob): number {
  if (job.type === 'publish_post' || job.type === 'inbox_reply') return 29;
  if (job.type === 'analytics_sync') return 33;
  return 28;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : undefined;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Job payload missing required string: ${key}`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}
