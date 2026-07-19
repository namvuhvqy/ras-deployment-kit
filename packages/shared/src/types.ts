export type Platform =
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'twitter'
  | 'tiktok'
  | 'youtube'
  | 'pinterest'
  | 'threads'
  | 'bluesky'
  | 'telegram';

export type JobPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export interface RasCustomer {
  id: string;
  name: string;
  email?: string;
  zernioProfileId: string;
  status: 'active' | 'paused' | 'offboarded';
}

export interface ConnectedAccount {
  id: string;
  customerId: string;
  zernioAccountId: string;
  profileId: string;
  platform: Platform;
  username?: string;
  status: 'connected' | 'expired' | 'revoked' | 'error';
  capabilities: string[];
}

export interface RasJob<TPayload = Record<string, unknown>> {
  id: string;
  customerId: string;
  profileId: string;
  accountId?: string;
  type: 'publish_post' | 'inbox_reply' | 'analytics_sync' | 'webhook_process';
  priority: JobPriority;
  payload: TPayload;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  retryCount: number;
  runAfterIso?: string;
  createdAtIso: string;
}
