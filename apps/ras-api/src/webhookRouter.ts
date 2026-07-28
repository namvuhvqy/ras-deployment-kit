import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AjvImport, { type ValidateFunction } from 'ajv';
type AjvConstructor = new (options?: { allErrors?: boolean; strict?: boolean }) => { compile(schema: object): ValidateFunction };
const Ajv = AjvImport as unknown as AjvConstructor;
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonRasStore } from '../../../packages/shared/src/persistentStore.js';
import type { Platform, RasJob } from '../../../packages/shared/src/types.js';

export interface ZernioWebhookRouterOptions {
  store: JsonRasStore;
  secret?: string;
}

type WebhookPayload = Record<string, unknown>;
type AccountEvent = {
  accountId: string;
  profileId: string;
  platform: Platform;
  username: string;
  displayName?: string;
};

const accountEvents = new Set(['account.connected', 'account.disconnected']);
const allowedPlatforms = new Set<Platform>(['facebook', 'instagram', 'youtube', 'twitter', 'linkedin', 'tiktok', 'threads', 'bluesky']);

export function createZernioWebhookRouter(options: ZernioWebhookRouterOptions) {
  const validators = loadValidators();
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/webhooks/zernio') return false;

    const status = await options.store.getWebhookStatus();
    if (!status.enabled) return endFailure(options.store, res, undefined, 'webhook_disabled', 503);

    const rawBody = await readRawBody(req);
    const signature = verifySignature(rawBody, firstHeader(req, 'x-zernio-signature'), options.secret);
    if (signature !== 'verified') return endFailure(options.store, res, undefined, `${signature}_signature`, signature === 'missing' ? 400 : 401);

    let payload: WebhookPayload;
    try {
      payload = rawBody.length ? (JSON.parse(rawBody.toString('utf8')) as WebhookPayload) : {};
    } catch {
      return endFailure(options.store, res, undefined, 'invalid_json', 400);
    }

    const eventId = stringAt(payload, 'id');
    const eventType = stringAt(payload, 'event');
    if (!eventId) return endFailure(options.store, res, undefined, 'missing_event_id', 400);
    if (!eventType) return endFailure(options.store, res, eventId, 'missing_event_type', 400);

    const validator = validatorFor(eventType, validators);
    if (!validator || !validator(payload)) return endFailure(options.store, res, eventId, `schema_invalid_${eventType}`, 422);

    const account = extractAccount(payload);
    const profileId = account?.profileId ?? stringAt(payload, 'profileId');
    const accountId = account?.accountId ?? stringAt(payload, 'accountId');
    const event = await options.store.recordWebhookEvent({
      id: eventId,
      source: 'zernio',
      profileId,
      accountId,
      eventType,
      payload,
      processedAtIso: new Date().toISOString(),
      createdAtIso: new Date().toISOString(),
      signatureStatus: 'verified',
    });

    if (event.inserted && account && accountEvents.has(eventType)) {
      const customer = await customerForProfile(options.store, account.profileId);
      if (!customer) return endFailure(options.store, res, eventId, 'unknown_zernio_profile', 422);
      await options.store.enqueueJob(webhookJob(eventId, customer.id, account, eventType, payload));
    }

    res.statusCode = event.inserted ? 202 : 200;
    res.end(JSON.stringify({ ok: true, deduped: !event.inserted, eventId, signature: 'verified' }));
    return true;
  };
}

function webhookJob(eventId: string, customerId: string, account: AccountEvent, eventType: string, payload: WebhookPayload): RasJob {
  const now = new Date().toISOString();
  return {
    id: `zernio_webhook_${eventId}`,
    customerId,
    profileId: account.profileId,
    accountId: account.accountId,
    platform: account.platform,
    type: 'webhook_process',
    priority: 'P0',
    status: 'queued',
    retryCount: 0,
    payload: { eventId, eventType, account, webhookPayload: payload },
    createdAtIso: now,
  };
}

async function customerForProfile(store: JsonRasStore, profileId: string) {
  const state = await store.load();
  return state.customers.find((customer) => customer.zernioProfileId === profileId || customer.zernioProfileIds?.includes(profileId));
}

function loadValidators(): Map<string, ValidateFunction> {
  const schemaPath = resolve(process.cwd(), 'schemas/zernio-webhook-payload-schemas.json');
  const document = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    definitions?: Record<string, object>;
    events?: Record<string, { schema?: object }>;
  };
  const ajv = new Ajv({ allErrors: true, strict: false });
  const result = new Map<string, ValidateFunction>();
  for (const [name, entry] of Object.entries(document.events ?? {})) {
    if (entry.schema) {
      // Event schemas use local #/definitions references from the supplied document.
      result.set(name.replaceAll('_', '.'), ajv.compile({ ...entry.schema, definitions: document.definitions }));
    }
  }
  return result;
}

function validatorFor(eventType: string, validators: Map<string, ValidateFunction>): ValidateFunction | undefined {
  return validators.get(eventType);
}

function extractAccount(payload: WebhookPayload): AccountEvent | undefined {
  const record = asRecord(payload.account);
  const accountId = stringAt(record, 'accountId');
  const profileId = stringAt(record, 'profileId');
  const platform = stringAt(record, 'platform');
  const username = stringAt(record, 'username');
  if (!accountId || !profileId || !platform || !username || !allowedPlatforms.has(platform as Platform)) return undefined;
  const displayName = stringAt(record, 'displayName');
  return { accountId, profileId, platform: platform as Platform, username, ...(displayName ? { displayName } : {}) };
}

function asRecord(value: unknown): WebhookPayload {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as WebhookPayload) : {};
}

function stringAt(record: WebhookPayload, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function verifySignature(rawBody: Buffer, value: string | undefined, secret: string | undefined): 'verified' | 'invalid' | 'missing' {
  if (!secret) return 'missing';
  if (!value) return 'missing';
  const actual = value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!/^[a-f0-9]{64}$/i.test(actual)) return 'invalid';
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex')) ? 'verified' : 'invalid';
}

async function endFailure(store: JsonRasStore, res: ServerResponse, eventId: string | undefined, reason: string, statusCode: number): Promise<boolean> {
  const status = await store.recordWebhookFailure({ source: 'zernio', eventId, reason, statusCode });
  res.statusCode = status.enabled ? statusCode : 503;
  res.end(JSON.stringify({ ok: false, error: reason, disabled: !status.enabled }));
  return true;
}
