-- Per-user runtime settings (spend control / controlled mode)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  mode TEXT NOT NULL DEFAULT 'normal' CHECK(mode IN ('normal', 'controlled')),
  controlled_batch_size INTEGER NOT NULL DEFAULT 1 CHECK(controlled_batch_size BETWEEN 1 AND 20),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Emails collected (raw pull) but not yet classified — the controlled-mode buffer
CREATE TABLE IF NOT EXISTS pending_emails (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_emails_user_msg ON pending_emails(user_id, message_id);
CREATE INDEX IF NOT EXISTS idx_pending_emails_user ON pending_emails(user_id, collected_at);
