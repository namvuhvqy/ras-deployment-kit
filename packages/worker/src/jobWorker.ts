import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { FairProfileQueue } from '../../queue/src/fairQueue.js';
import type { RasJob } from '../../shared/src/types.js';
import type { JsonRasStore } from '../../shared/src/persistentStore.js';
import { ZernioApiError, type CreatePostInput, type ZernioAdapter } from '../../zernio-adapter/src/index.js';

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
  claimLeaseMs?: number;
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
    const leaseMs = this.options.claimLeaseMs ?? 60_000;
    const dueJobs = await this.store.getQueuedJobs(leaseMs);
    const queue = new FairProfileQueue();
    for (const job of dueJobs) queue.enqueue(job);

    const result: WorkerRunResult = { processed: 0, completed: 0, failed: 0, requeued: 0 };
    while (queue.size() > 0 && result.processed < this.options.batchSize) {
      const job = queue.dequeue();
      if (!job) break;
      const claimed = await this.store.claimQueuedJob(job.id, randomBytes(24).toString('hex'), leaseMs);
      if (!claimed) continue;
      result.processed += 1;
      const outcome = await this.processJob(claimed);
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
    try {
      const metadata = await this.execute(job);
      if (job.type === 'publish_post' && isSocialPostStatus(metadata.status)) await this.store.updateSocialPostStatus({ postId: socialPostId(job), status: metadata.status });
      const completed = await this.store.completeJob(job.id, metadata, job.claimToken);
      if (!completed) return 'requeued';
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
      if (isPermanentZernioClientError(error)) {
        await this.store.failJob(job.id, message, job.claimToken);
        if (job.type === 'publish_post') await this.failSocialPost(job, message);
        await this.options.notifier?.send(topicForJob(job), `❌ RAS job failed: ${job.type} / ${job.id}\n${message}`);
        return 'failed';
      }
      if (job.retryCount + 1 <= this.options.maxRetries) {
        const runAfterIso = new Date(Date.now() + retryDelayMs(job.retryCount, this.options.baseRetryMs)).toISOString();
        await this.store.requeueJob(job.id, message, runAfterIso, job.claimToken);
        await this.options.notifier?.send(topicForJob(job), `⚠️ RAS job requeued: ${job.type} / ${job.id}\n${message}`);
        return 'requeued';
      }
      await this.store.failJob(job.id, message, job.claimToken);
      if (job.type === 'publish_post') await this.failSocialPost(job, message);
      await this.options.notifier?.send(topicForJob(job), `❌ RAS job failed: ${job.type} / ${job.id}\n${message}`);
      return 'failed';
    }
  }

  private async failSocialPost(job: RasJob, message: string): Promise<void> {
    await this.store.updateSocialPostStatus({ postId: socialPostId(job), status: 'failed', errorMessage: message.slice(0, 500) });
  }

  private async execute(job: RasJob): Promise<Record<string, unknown>> {
    if (job.type === 'publish_post') {
      const input = assertPublishPostPayload(job);
      if (this.options.dryRun) {
        return { dryRun: true, zernioPostId: `dry_worker_${job.id}` };
      }
      const result = await this.adapter.createPost(input);
      await this.store.attachZernioPostId(job.id, result.zernioPostId);
      return { dryRun: false, ...result };
    }

    if (job.type === 'provision_entitlement') return this.provisionEntitlement(job);
    if (job.type === 'create_profile') return this.provisionConnectProfile(job);

    if (job.type === 'webhook_process' || job.type === 'inbox_process') return this.processZernioWebhook(job);

    if (job.type === 'inbox_reply') return this.processInboxReply(job);

    if (job.type === 'analytics_sync' && this.options.dryRun) {
      return { dryRun: true, skippedLiveSideEffect: job.type };
    }

    throw new Error(`Unsupported live job type: ${job.type}`);
  }

  private async provisionConnectProfile(job: RasJob): Promise<Record<string, unknown>> {
    const payload = asRecord(job.payload);
    const reason = requiredString(payload, 'reason');
    const platform = requiredString(payload, 'platform');
    if (reason !== 'initial_connect' && reason !== 'same_platform_connect') throw new Error('Invalid profile provisioning reason');
    if (!job.platform || job.platform !== platform) throw new Error('Profile provisioning platform mismatch');
    const state = await this.store.load();
    const customer = state.customers.find((row) => row.id === job.customerId);
    if (!customer) throw new Error(`Customer not found: ${job.customerId}`);
    const existingIds = Array.from(new Set([...(customer.zernioProfileIds ?? []), ...(customer.zernioProfileId ? [customer.zernioProfileId] : [])]));
    const platformAlreadyHasSpareProfile = state.connectedAccounts
      .filter((account) => account.customerId === customer.id && account.platform === platform && account.status === 'connected')
      .map((account) => account.zernioProfileId)
      .filter((profileId): profileId is string => Boolean(profileId));
    if ((reason === 'initial_connect' && existingIds.length > 0) || (reason === 'same_platform_connect' && existingIds.some((id) => !platformAlreadyHasSpareProfile.includes(id)))) {
      return { reason, platform, idempotent: true, profileIds: existingIds };
    }
    const profile = await this.adapter.createProfile({ customerId: customer.id, name: customer.name, email: customer.email });
    if (!profile.zernioProfileId) throw new Error('Zernio profile response missing profile id');
    await this.store.addCustomerZernioProfile(customer.id, profile.zernioProfileId);
    return { reason, platform, profileId: profile.zernioProfileId, idempotent: false };
  }

  private async provisionEntitlement(job: RasJob): Promise<Record<string, unknown>> {
    const paymentId = requiredString(asRecord(job.payload), 'paymentId');
    const payment = await this.store.getBillingPayment(paymentId);
    if (!payment) throw new Error(`Billing payment not found: ${paymentId}`);
    if (payment.customerId !== job.customerId) throw new Error('Billing payment customer mismatch');
    if (payment.status !== 'captured') throw new Error('Billing payment is not captured');
    if (payment.provisionStatus === 'provisioned') return { paymentId: payment.id, provisionStatus: 'provisioned', idempotent: true };

    const state = await this.store.load();
    const customer = state.customers.find((row) => row.id === job.customerId);
    if (!customer) throw new Error(`Customer not found: ${job.customerId}`);
    let zernioProfileId = customer.zernioProfileId;
    if (!zernioProfileId) {
      const profile = await this.adapter.createProfile({ customerId: customer.id, name: customer.name, email: customer.email });
      zernioProfileId = profile.zernioProfileId;
    }
    const includedSlots = customer.entitlement?.connectSlots.includedSlots ?? 1;
    const previouslyPurchasedSlots = customer.entitlement?.connectSlots.purchasedSlots ?? Math.max(0, (customer.maxConnectedAccounts ?? includedSlots) - includedSlots);
    const purchasedSlots = previouslyPurchasedSlots + payment.extraConnectSlots;
    const totalSlots = includedSlots + purchasedSlots;
    const activeConnectedAccounts = state.connectedAccounts.filter((row) => row.customerId === customer.id && row.status === 'connected').length;
    await this.store.upsertCustomerEntitlement({
      customerId: customer.id,
      maxConnectedAccounts: totalSlots,
      packageStatus: 'active',
      addOnStatus: { ...(customer.addOnStatus ?? {}), zernio: 'active' },
      zernioProfileId,
      entitlement: {
        basePlan: { planId: payment.plan, status: 'active', billingCycle: payment.billingCycle, vps: { type: 'dedicated' }, agents: { included: 2, kinds: ['ras1-hermes', 'ras2-openclaw'] }, activatedAtIso: new Date().toISOString() },
        connectSlots: { status: 'active', includedSlots, purchasedSlots, trialSlots: 0, totalSlots, activeConnectedAccounts },
        addOns: [{ id: 'zernio-connect', name: 'Zernio Connect', status: 'active', slots: totalSlots }],
      },
    });
    await this.store.markBillingPaymentProvisioned(payment.id);
    return { paymentId: payment.id, provisionStatus: 'provisioned', totalSlots, idempotent: false };
  }

  private async processZernioWebhook(job: RasJob): Promise<Record<string, unknown>> {
    const payload = asRecord(job.payload);
    const eventType = requiredString(payload, 'eventType');
    if (eventType === 'post.platform.published' || eventType === 'post.platform.failed') {
      const webhookPayload = asRecord(payload.webhookPayload);
      const post = asRecord(webhookPayload.post);
      const platform = asRecord(webhookPayload.platform);
      // Zernio WebhookPayloadPostPlatform: post._id/id is the Zernio post id;
      // platform.platformPostId/publishedUrl/error are terminal platform fields.
      const zernioPostId = optionalString(post._id) ?? optionalString(post.id) ?? optionalString(post.postId) ?? optionalString(webhookPayload.postId);
      const platformPostId = optionalString(platform.platformPostId) ?? optionalString(post.platformPostId) ?? optionalString(webhookPayload.platformPostId);
      const postId = zernioPostId ?? platformPostId;
      if (!postId) throw new Error('Webhook payload missing post id');
      const saved = await this.store.updateSocialPostStatus({
        postId,
        status: eventType === 'post.platform.published' ? 'published' : 'failed',
        publishedAtIso: optionalString(post.publishedAt) ?? optionalString(platform.publishedAt) ?? optionalString(webhookPayload.publishedAt),
        errorMessage: optionalString(platform.error) ?? optionalString(post.error) ?? optionalString(webhookPayload.error),
      });
      return { eventType, synced: true, zernioPostId: saved.zernioPostId, status: saved.status };
    }
    if (eventType === 'message.received' || eventType === 'message.sent' || eventType === 'message.delivered') return this.processInboxMessage(job, payload, eventType);
    if (eventType !== 'account.connected' && eventType !== 'account.disconnected') {
      return { ignored: true, eventType };
    }
    const account = asRecord(payload.account);
    const accountId = job.accountId ?? requiredString(account, 'accountId');
    if (this.options.dryRun) return { dryRun: true, eventType, accountId, skippedLiveSideEffect: 'account_refresh' };

    let detail;
    let verificationSource: 'get_account' | 'profile_list_fallback' = 'get_account';
    try {
      detail = await this.adapter.getAccount(accountId);
    } catch (error) {
      if (!(error instanceof ZernioApiError) || error.status !== 405) throw error;
      const accounts = await this.adapter.listAccounts(job.profileId);
      detail = accounts.find((candidate) => candidate.zernioAccountId === accountId);
      if (!detail) throw new Error(`Zernio account verification unavailable: ${accountId} was not found in profile list after GET returned 405`);
      verificationSource = 'profile_list_fallback';
    }
    const nowIso = new Date().toISOString();
    const status = eventType === 'account.disconnected' ? 'disconnected' : detail.status;
    const saved = await this.store.upsertAccountMapping({
      ...detail,
      id: detail.id || `${job.customerId}_${detail.platform}_${detail.zernioAccountId}`,
      customerId: job.customerId,
      zernioAccountId: detail.zernioAccountId || accountId,
      zernioProfileId: job.profileId,
      profileId: job.profileId,
      status,
      connectedAtIso: status === 'connected' ? (detail.connectedAtIso ?? nowIso) : detail.connectedAtIso,
      lastVerifiedAtIso: nowIso,
    });
    return {
      eventType,
      synced: true,
      accountId: saved.zernioAccountId,
      status: saved.status,
      verificationSource,
      capabilities: detail.capabilities ?? [],
      lastVerifiedAtIso: saved.lastVerifiedAtIso,
    };
  }

  private async processInboxReply(job: RasJob): Promise<Record<string, unknown>> {
    const payload = asRecord(job.payload);
    const draftId = requiredString(payload, 'draftId');
    const conversationId = requiredString(payload, 'conversationId');
    const text = requiredString(payload, 'text');
    if (this.options.dryRun) return { dryRun: true, draftId, conversationId, outboundSendAttempted: false };
    const accountId = requiredString(payload, 'accountId');
    const result = await this.adapter.sendInboxMessage({ conversationId, accountId, text, requestId: job.id });
    const draft = await this.store.markInboxDraftReplySent({ customerId: job.customerId, draftId, providerMessageId: result.providerMessageId });
    return { draftId: draft.id, conversationId, providerMessageId: result.providerMessageId, outboundSendAttempted: true };
  }

  private async processInboxMessage(job: RasJob, payload: Record<string, unknown>, eventType: 'message.received' | 'message.sent' | 'message.delivered'): Promise<Record<string, unknown>> {
    const webhookPayload = asRecord(payload.webhookPayload);
    const message = asRecord(webhookPayload.message);
    const conversation = asRecord(webhookPayload.conversation);
    const sender = asRecord(message.sender);
    const account = asRecord(webhookPayload.account);
    const providerMessageId = requiredString(message, 'platformMessageId');
    const conversationId = requiredString(message, 'conversationId');
    const accountId = job.accountId ?? requiredString(account, 'accountId');
    const platform = requiredString(message, 'platform') as RasJob['platform'];
    if (!platform) throw new Error('Inbox message missing platform');
    const saved = await this.store.recordInboxMessage({
      id: optionalString(message.id) ?? `inbox_${providerMessageId}`,
      customerId: job.customerId,
      accountId,
      platform,
      conversationId,
      providerMessageId,
      direction: requiredString(message, 'direction') === 'incoming' ? 'inbound' : 'outbound',
      text: optionalString(message.text),
      senderId: optionalString(sender.id),
      senderName: optionalString(sender.name),
      participantId: optionalString(conversation.participantId) ?? optionalString(sender.id),
      participantName: optionalString(conversation.participantName) ?? optionalString(sender.name),
      participantUsername: optionalString(conversation.participantUsername) ?? optionalString(sender.username),
      receivedAtIso: optionalString(message.sentAt) ?? new Date().toISOString(),
    });
    return {
      eventType,
      synced: saved.inserted,
      conversationId: saved.conversation.id,
      messageId: saved.message.id,
      mode: 'draft_only',
      outboundSendAttempted: false,
    };
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

function socialPostId(job: RasJob): string {
  return optionalString(asRecord(job.payload).postId) ?? job.id;
}

function assertPublishPostPayload(job: RasJob): CreatePostInput {
  const payload = asRecord(job.payload);
  const content = requiredString(payload, 'content');
  const platform = requiredString(payload, 'platform') as CreatePostInput['platform'];
  const accountId = optionalString(payload.providerAccountId) ?? job.accountId ?? requiredString(payload, 'accountId');
  const mediaUrls = arrayOfStrings(payload.mediaUrls);
  const scheduleAtIso = optionalString(payload.scheduleAtIso);
  const isDraft = optionalBoolean(payload.isDraft);
  const platformSpecificData = asOptionalRecord(payload.platformSpecificData);
  return {
    accountId,
    platform,
    content,
    mediaUrls,
    ...(scheduleAtIso ? { scheduleAtIso } : {}),
    ...(isDraft !== undefined ? { isDraft } : {}),
    requestId: job.id,
    ...(platformSpecificData ? { platformSpecificData } : {}),
  };
}

function isPermanentZernioClientError(error: unknown): boolean {
  return error instanceof ZernioApiError && error.status >= 400 && error.status < 500 && error.status !== 429;
}

function retryDelayMs(retryCount: number, baseRetryMs: number): number {
  return Math.min(baseRetryMs * 2 ** retryCount, 30 * 60_000);
}

function isSocialPostStatus(value: unknown): value is import('../../shared/src/types.js').SocialPost['status'] {
  return typeof value === 'string' && ['queued', 'draft', 'scheduled', 'published', 'failed'].includes(value);
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

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
