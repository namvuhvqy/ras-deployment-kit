export const RAS_SCHEMA_VERSION = 3;

export const createTableStatements = [
  `CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    zernio_profile_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS connected_accounts (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    zernio_account_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    username TEXT,
    status TEXT NOT NULL DEFAULT 'connected',
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    connected_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(customer_id, zernio_account_id)
  )`,
  `CREATE TABLE IF NOT EXISTS social_posts (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    zernio_post_id TEXT,
    content TEXT NOT NULL,
    platforms_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    scheduled_at TEXT,
    published_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS inbox_conversations (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    account_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    provider_conversation_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    unread_count INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(customer_id, provider_conversation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id),
    provider_message_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    text TEXT,
    received_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(customer_id, provider_message_id)
  )`,
  `CREATE TABLE IF NOT EXISTS inbox_draft_replies (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id),
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_review',
    send_attempted INTEGER NOT NULL DEFAULT 0,
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS job_queue (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    profile_id TEXT NOT NULL,
    account_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    retry_count INTEGER NOT NULL DEFAULT 0,
    run_after TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    profile_id TEXT,
    account_id TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    processed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(source, id)
  )`,
  `CREATE TABLE IF NOT EXISTS checkout_intents (
    id TEXT PRIMARY KEY,
    customer_id TEXT REFERENCES customers(id),
    purchaser_user_id TEXT,
    purchaser_email TEXT,
    plan TEXT NOT NULL,
    billing_cycle TEXT NOT NULL,
    extra_connect_slots INTEGER NOT NULL,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    paypal_order_id TEXT UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    customer_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
];

export const createIndexStatements = [
  `CREATE INDEX IF NOT EXISTS idx_customers_zernio_profile_id ON customers(zernio_profile_id)`,
  `CREATE INDEX IF NOT EXISTS idx_connected_accounts_customer_platform ON connected_accounts(customer_id, platform)`,
  `CREATE INDEX IF NOT EXISTS idx_social_posts_customer_status ON social_posts(customer_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_job_queue_status_priority_run_after ON job_queue(status, priority, run_after)`,
  `CREATE INDEX IF NOT EXISTS idx_job_queue_profile_status ON job_queue(profile_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_events_profile_created ON webhook_events(profile_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_customer_created ON audit_logs(customer_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_checkout_intents_customer_status ON checkout_intents(customer_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_checkout_intents_purchaser_status ON checkout_intents(purchaser_user_id, status)`,
];

export function renderSqlMigration(): string {
  return [
    `-- RAS schema v${RAS_SCHEMA_VERSION}`,
    `PRAGMA foreign_keys = ON;`,
    ...createTableStatements.map((statement) => `${statement};`),
    ...createIndexStatements.map((statement) => `${statement};`),
  ].join('\n\n');
}
