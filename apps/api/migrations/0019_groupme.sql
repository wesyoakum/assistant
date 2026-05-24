-- GroupMe access tokens (encrypted, per-user)
CREATE TABLE IF NOT EXISTS groupme_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(id),
  access_token_encrypted TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  groupme_user_id TEXT,
  groupme_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_groupme_tokens_user ON groupme_tokens(user_id);
