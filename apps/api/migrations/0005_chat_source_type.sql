PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS triage_items_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  source_type TEXT NOT NULL CHECK(source_type IN ('email', 'document', 'image', 'voice', 'chat', 'calendar', 'event')),
  source_ref TEXT,
  priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
  urgency INTEGER NOT NULL DEFAULT 3 CHECK(urgency BETWEEN 1 AND 5),
  category TEXT,
  summary TEXT,
  suggested_action TEXT,
  classifier_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'done', 'dismissed')),
  event_at TEXT,
  source_title TEXT,
  due_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  event_created_at TEXT,
  event_updated_at TEXT,
  source_url TEXT
);

INSERT INTO triage_items_new
  SELECT id, user_id, source_type, source_ref, priority, urgency, category, summary,
         suggested_action, classifier_json, status, event_at, source_title, due_at,
         created_at, updated_at, event_created_at, event_updated_at, source_url
  FROM triage_items;

DROP TABLE triage_items;
ALTER TABLE triage_items_new RENAME TO triage_items;

CREATE INDEX IF NOT EXISTS idx_triage_items_user_status ON triage_items(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_triage_items_user_priority ON triage_items(user_id, priority DESC, urgency DESC);

PRAGMA foreign_keys = ON;
