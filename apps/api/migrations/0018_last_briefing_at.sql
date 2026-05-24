-- Track when the user last received an auto-briefing on app open.
-- The briefing endpoint throttles itself to once every 3 hours.
ALTER TABLE user_settings ADD COLUMN last_briefing_at TEXT;
