import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexStatements, createTableStatements, renderSqlMigration, renderV2ToV3SqlMigration } from '../packages/shared/src/dbSchema.js';

const requiredTables = ['customers', 'connected_accounts', 'social_posts', 'job_queue', 'webhook_events', 'audit_logs'];

test('RAS schema includes all MVP tables', () => {
  const sql = renderSqlMigration();
  for (const table of requiredTables) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
});

test('RAS schema has tenant mapping and queue fairness fields', () => {
  const sql = renderSqlMigration();
  assert.match(sql, /zernio_profile_id TEXT UNIQUE/);
  assert.match(sql, /zernio_account_id TEXT NOT NULL/);
  assert.match(sql, /profile_id TEXT NOT NULL/);
  assert.match(sql, /priority TEXT NOT NULL/);
  assert.match(sql, /retry_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /run_after TEXT/);
});

test('RAS schema creates indexes for operational lookups', () => {
  assert.ok(createTableStatements.length >= requiredTables.length);
  assert.ok(createIndexStatements.some((statement) => statement.includes('idx_job_queue_profile_status')));
  assert.ok(createIndexStatements.some((statement) => statement.includes('idx_connected_accounts_customer_platform')));
});

test('v2 checkout intent migration rebuilds nullable customer identity while copying existing rows', () => {
  const sql = renderV2ToV3SqlMigration();
  assert.match(sql, /CREATE TABLE checkout_intents_v3/);
  assert.match(sql, /customer_id TEXT REFERENCES customers/);
  assert.match(sql, /purchaser_user_id TEXT/);
  assert.match(sql, /INSERT INTO checkout_intents_v3[\s\S]*SELECT id, customer_id/);
  assert.match(sql, /DROP TABLE checkout_intents/);
  assert.match(sql, /idx_checkout_intents_customer_status/);
});
