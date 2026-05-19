-- Minimal schema: raw data collection + generic chat only.
-- No triage, classification, feedback, context, preferences, or push.
-- This mirrors migrations/0001_init.sql.

-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  picture_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- OAuth tokens (encrypted)
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  access_token_encrypted TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  scope TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id);

-- Gmail incremental sync state
CREATE TABLE IF NOT EXISTS gmail_sync_state (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(id),
  history_id TEXT,
  last_synced_at TEXT
);

-- Raw collected emails (no classification — pulled and stored as-is)
CREATE TABLE IF NOT EXISTS raw_emails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  message_id TEXT NOT NULL,
  thread_id TEXT,
  subject TEXT,
  from_addr TEXT,
  email_date TEXT,
  snippet TEXT,
  body_text TEXT,
  collected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_emails_user_msg ON raw_emails(user_id, message_id);
CREATE INDEX IF NOT EXISTS idx_raw_emails_user ON raw_emails(user_id, collected_at DESC);

-- Ingested files (raw upload to R2 — stored, not analyzed)
CREATE TABLE IF NOT EXISTS ingested_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('pdf', 'image', 'audio')),
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stored' CHECK(status IN ('stored', 'error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- iCal feed subscriptions
CREATE TABLE IF NOT EXISTS ical_feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  url TEXT NOT NULL,
  name TEXT,
  color TEXT DEFAULT '#8B5CF6',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_etag TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ical_feeds_user ON ical_feeds(user_id);

-- Events parsed from iCal feeds
CREATE TABLE IF NOT EXISTS ical_events (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES ical_feeds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  uid TEXT NOT NULL,
  summary TEXT,
  description TEXT,
  location TEXT,
  start_iso TEXT NOT NULL,
  end_iso TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(feed_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_ical_events_user_start ON ical_events(user_id, start_iso);

-- Generic chat transcript (persisted, no summarization/context)
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id, created_at);
