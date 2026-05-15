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

CREATE INDEX idx_ical_feeds_user ON ical_feeds(user_id);

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

CREATE INDEX idx_ical_events_user_start ON ical_events(user_id, start_iso);
