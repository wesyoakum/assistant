-- Users table
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

-- Triage items
CREATE TABLE IF NOT EXISTS triage_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  source_type TEXT NOT NULL CHECK(source_type IN ('email', 'document', 'image', 'voice')),
  source_ref TEXT,
  priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
  urgency INTEGER NOT NULL DEFAULT 3 CHECK(urgency BETWEEN 1 AND 5),
  category TEXT,
  summary TEXT,
  suggested_action TEXT,
  classifier_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'done', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_triage_items_user_status ON triage_items(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_triage_items_user_priority ON triage_items(user_id, priority DESC, urgency DESC);

-- Feedback
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  triage_item_id TEXT NOT NULL REFERENCES triage_items(id),
  kind TEXT NOT NULL CHECK(kind IN ('up', 'down', 'wrong_priority')),
  corrected_priority INTEGER CHECK(corrected_priority BETWEEN 1 AND 5),
  corrected_urgency INTEGER CHECK(corrected_urgency BETWEEN 1 AND 5),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, created_at DESC);

-- Calendar suggestions
CREATE TABLE IF NOT EXISTS calendar_suggestions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  triage_item_id TEXT REFERENCES triage_items(id),
  title TEXT NOT NULL,
  start_iso TEXT NOT NULL,
  end_iso TEXT NOT NULL,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
  google_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ingested files
CREATE TABLE IF NOT EXISTS ingested_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('pdf', 'image', 'audio')),
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'done', 'error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Push tokens
CREATE TABLE IF NOT EXISTS push_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expo_token TEXT UNIQUE NOT NULL,
  platform TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User calendar preferences
CREATE TABLE IF NOT EXISTS user_calendar_prefs (
  user_id TEXT NOT NULL REFERENCES users(id),
  calendar_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, calendar_id)
);

-- User context (people, relationships, activities)
CREATE TABLE IF NOT EXISTS user_context (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_context_user ON user_context(user_id);

-- Gmail sync state
CREATE TABLE IF NOT EXISTS gmail_sync_state (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(id),
  history_id TEXT,
  last_synced_at TEXT
);
