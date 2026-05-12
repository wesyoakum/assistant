-- User calendar preferences (which Google Calendars are enabled)
CREATE TABLE IF NOT EXISTS user_calendar_prefs (
  user_id TEXT NOT NULL REFERENCES users(id),
  calendar_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, calendar_id)
);
