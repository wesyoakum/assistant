-- Chat summaries for context window efficiency
-- kind: 'chunk' = summary of a batch of messages, 'mega' = rollup of all older chunks
CREATE TABLE IF NOT EXISTS chat_summaries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('chunk', 'mega')),
  summary TEXT NOT NULL,
  msg_start_id TEXT,
  msg_end_id TEXT,
  msg_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_summaries_user_kind ON chat_summaries(user_id, kind, created_at DESC);
