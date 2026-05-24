-- Per-user, per-group "fetch messages from this group?" flag, plus
-- incremental sync cursor (the last message id we've already pulled).
CREATE TABLE IF NOT EXISTS groupme_group_prefs (
  user_id TEXT NOT NULL REFERENCES users(id),
  group_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  last_synced_at TEXT,
  PRIMARY KEY (user_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_groupme_group_prefs_enabled
  ON groupme_group_prefs(user_id, enabled);
