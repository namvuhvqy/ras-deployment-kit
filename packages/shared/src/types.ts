export type SocialPlatform = 'facebook' | 'instagram' | 'youtube' | 'twitter' | 'linkedin' | 'tiktok' | 'threads' | 'bluesky' | 'telegram' | 'whatsapp' | 'reddit';
export type Platform = SocialPlatform;

export type SandboxStatus = 'provisioning' | 'starting' | 'running' | 'degraded' | 'stopped' | 'failed';
export type AgentKind = 'ras1-hermes' | 'ras2-openclaw';
export type AgentStatus = 'unknown' | 'starting' | 'running' | 'degraded' | 'stopped' | 'failed';
export type ServicePackageStatus = 'draft' | 'active' | 'deprecated';
export type BillingStatus = 'trial' | 'active' | 'past_due' | 'cancelled';
export type EntitlementStatus = 'pending' | 'active' | 'inactive' | 'past_due' | 'cancelled';
export type RasUserRole = 'owner' | 'admin' | 'operator' | 'viewer';

export type RasBasePlanId = 'none' | 'lite' | 'pro' | 'max';
export type RasBillingCycle = 'monthly' | 'yearly';

export type RasBillingPaymentStatus = 'captured' | 'refunded' | 'failed';
export type RasCheckoutIntentStatus = 'created' | 'bound' | 'consumed' | 'expired';
export type RasProvisionStatus = 'pending' | 'pending_retry' | 'provisioned' | 'failed';

export interface RasCheckoutIntent {
  id: string;
  customerId: string;
  plan: Exclude<RasBasePlanId, 'none'>;
  billingCycle: RasBillingCycle;
  extraConnectSlots: number;
  amount: string;
  currency: 'USD';
  status: RasCheckoutIntentStatus;
  paypalOrderId?: string;
  boundAtIso?: string;
  consumedAtIso?: string;
  transactionId?: string;
  expiresAtIso: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface RasBillingPayment {
  id: string;
  provider: 'paypal';
  customerId: string;
  paypalOrderId: string;
  transactionId: string;
  status: RasBillingPaymentStatus;
  provisionStatus: RasProvisionStatus;
  amount: string;
  currency: string;
  plan: RasBasePlanId;
  billingCycle: RasBillingCycle;
  extraConnectSlots: number;
  rawCapture?: Record<string, unknown>;
  retryCount: number;
  lastError?: string;
  provisionedAtIso?: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface BasePlanEntitlement {
  planId: RasBasePlanId;
  status: EntitlementStatus;
  billingCycle?: RasBillingCycle;
  monthlyPriceUsd?: number;
  totalAmountUsd?: number;
  vps: {
    type: 'none' | 'dedicated' | 'shared';
    size?: 'small' | 'standard' | 'large' | string;
  };
  agents: {
    included: number;
    kinds: AgentKind[];
  };
  aiTokens?: {
    monthlyLimit: number;
    used?: number;
  };
  activatedAtIso?: string;
  expiresAtIso?: string;
}

export interface ConnectSlotEntitlement {
  status: EntitlementStatus;
  includedSlots: number;
  purchasedSlots: number;
  trialSlots: number;
  totalSlots: number;
  activeConnectedAccounts: number;
  trialExpiresAtIso?: string;
  soloApiEnabled?: boolean;
}

export interface AddOnEntitlement {
  id: string;
  name: string;
  status: EntitlementStatus;
  slots?: number;
  priceUsd?: number;
  expiresAtIso?: string;
}

export interface RasEntitlement {
  basePlan: BasePlanEntitlement;
  connectSlots: ConnectSlotEntitlement;
  addOns: AddOnEntitlement[];
}
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

/** External API token. The plaintext credential is never persisted. */
export interface RasPersonalAccessToken {
  id: string;
  customerId: string;
  createdByUserId: string;
  name: string;
  tokenPrefix: string;
  tokenHash: string;
  scopes: string[];
  expiresAtIso?: string;
  lastUsedAtIso?: string;
  revokedAtIso?: string;
  createdAtIso: string;
}

export interface RasPrincipal {
  authType: 'session' | 'pat';
  customerId: string;
  userId?: string;
  scopes: string[];
  tokenId?: string;
}

/** Persisted fixed-window limiter state. It deliberately never contains a bearer credential. */
export interface RasApiRateLimitBucket {
  key: string;
  customerId: string;
  tokenId: string;
  windowStartedAtIso: string;
  requestCount: number;
  updatedAtIso: string;
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
  entitlement?: RasEntitlement;
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

export type SocialPostStatus = 'queued' | 'scheduled' | 'published' | 'failed';

export interface SocialPost {
  id: string;
  customerId: string;
  jobId: string;
  platform: SocialPlatform;
  zernioPostId?: string;
  platformPostId?: string;
  status: SocialPostStatus;
  publishedAtIso?: string;
  errorMessage?: string;
  updatedAtIso: string;
}

export type InboxConversationStatus = 'open' | 'closed';
export type InboxMessageDirection = 'inbound' | 'outbound';

export interface InboxConversation {
  id: string;
  customerId: string;
  accountId: string;
  platform: SocialPlatform;
  providerConversationId: string;
  status: InboxConversationStatus;
  participantId?: string;
  participantName?: string;
  participantUsername?: string;
  lastMessageAtIso: string;
  unreadCount: number;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface InboxDraftReply {
  id: string;
  customerId: string;
  conversationId: string;
  text: string;
  status: 'pending_review' | 'queued' | 'sent' | 'failed';
  sendAttempted: boolean;
  createdByUserId: string;
  approvedByUserId?: string;
  approvedAtIso?: string;
  sentAtIso?: string;
  providerMessageId?: string;
  errorMessage?: string;
  createdAtIso: string;
}

export interface InboxMessage {
  id: string;
  customerId: string;
  accountId: string;
  platform: SocialPlatform;
  conversationId: string;
  providerMessageId: string;
  direction: InboxMessageDirection;
  text?: string;
  senderId?: string;
  senderName?: string;
  receivedAtIso: string;
  createdAtIso: string;
}

export type RasJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface RasJob {
  id: string;
  customerId: string;
  profileId: string;
  accountId?: string;
  platform?: SocialPlatform;
  type: 'publish_post' | 'create_profile' | 'provision_entitlement' | 'webhook_process' | 'inbox_process' | 'smoke_test' | 'inbox_reply' | 'analytics_sync';
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
