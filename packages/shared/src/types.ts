export type SocialPlatform = 'facebook' | 'instagram' | 'youtube' | 'twitter' | 'linkedin' | 'tiktok' | 'threads' | 'bluesky';
export type Platform = SocialPlatform;

export type SandboxStatus = 'provisioning' | 'starting' | 'running' | 'degraded' | 'stopped' | 'failed';
export type AgentKind = 'ras1-hermes' | 'ras2-openclaw';
export type AgentStatus = 'unknown' | 'starting' | 'running' | 'degraded' | 'stopped' | 'failed';
export type ServicePackageStatus = 'draft' | 'active' | 'deprecated';
export type BillingStatus = 'trial' | 'active' | 'past_due' | 'cancelled';
export type RasUserRole = 'owner' | 'admin' | 'operator' | 'viewer';
export type RasUserStatus = 'active' | 'disabled';

export interface RasUser {
  id: string;
  email: string;
  displayName?: string;
  role: RasUserRole;
  customerId: string;
  status: RasUserStatus;
  password?: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface RasSession {
  id: string;
  token: string;
  userId: string;
  expiresAtIso: string;
  createdAtIso: string;
}

export interface RasCustomer {
  id: string;
  tenantId?: string;
  name: string;
  email?: string;
  zernioProfileId?: string;
  zernioProfileIds?: string[];
  maxConnectedAccounts?: number;
  activeConnectedAccounts?: number;
  packageStatus?: 'pending' | 'active' | 'past_due' | 'cancelled';
  addOnStatus?: Record<string, 'pending' | 'active' | 'inactive' | 'cancelled'>;
  status?: 'pending' | 'active' | 'disabled' | 'error';
  sandboxId?: string;
  servicePackageId?: string;
  billingStatus?: BillingStatus;
  createdAtIso?: string;
  updatedAtIso?: string;
}

export interface RasSandboxEnvironment {
  id: string;
  customerId: string;
  provider: 'vps' | 'cloud';
  region?: string;
  status: SandboxStatus;
  endpoint?: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface RasAgentInstance {
  id: string;
  customerId: string;
  sandboxId: string;
  kind: AgentKind;
  status: AgentStatus;
  version?: string;
  healthUrl?: string;
  lastHeartbeatAtIso?: string;
  lastLogExcerpt?: string;
  updatedAtIso: string;
}

export interface RasServicePackage {
  id: string;
  name: string;
  description?: string;
  status: ServicePackageStatus;
  monthlyPriceVnd?: number;
  includedAgents: number;
  includedSocialAccounts?: number;
  features: string[];
  createdAtIso: string;
  updatedAtIso: string;
}

export interface ConnectedAccount {
  id: string;
  customerId: string;
  platform: SocialPlatform;
  zernioAccountId: string;
  zernioProfileId?: string;
  profileId?: string;
  handle?: string;
  username?: string;
  status: 'pending' | 'connected' | 'disconnected' | 'error';
  capabilities?: string[];
  connectedAtIso?: string;
  lastVerifiedAtIso?: string;
}

export type RasJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface RasJob {
  id: string;
  customerId: string;
  profileId: string;
  accountId?: string;
  platform?: SocialPlatform;
  type: 'publish_post' | 'create_profile' | 'webhook_process' | 'smoke_test' | 'inbox_reply' | 'analytics_sync';
  priority: number | 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  status: RasJobStatus;
  payload: Record<string, unknown>;
  retryCount: number;
  maxRetries?: number;
  runAfterIso?: string;
  processingStartedAtIso?: string;
  completedAtIso?: string;
  failedAtIso?: string;
  lastError?: string;
  result?: Record<string, unknown>;
  createdAtIso: string;
}
