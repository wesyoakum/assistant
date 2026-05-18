-- Thread grouping: group emails by Gmail thread ID
ALTER TABLE triage_items ADD COLUMN thread_id TEXT;

-- Document memory: store full extracted text from files, OCR, transcriptions
ALTER TABLE triage_items ADD COLUMN extracted_content TEXT;

-- Index for thread lookups
CREATE INDEX IF NOT EXISTS idx_triage_items_thread ON triage_items(user_id, thread_id);

-- Track calendar event IDs for change detection
CREATE TABLE IF NOT EXISTS calendar_sync_state (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  triage_item_id TEXT REFERENCES triage_items(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, calendar_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_user ON calendar_sync_state(user_id);
