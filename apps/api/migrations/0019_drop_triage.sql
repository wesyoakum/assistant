-- Drop all triage / classifier tables and columns. The code that wrote to
-- them has been removed.

DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS calendar_suggestions;
DROP TABLE IF EXISTS triage_items;

-- user_settings backed the controlled-mode toggle, which only existed to
-- gate the classifier. The /control route is gone.
DROP TABLE IF EXISTS user_settings;

-- reminders.triage_item_id is now an orphan column. SQLite does support
-- DROP COLUMN as of 3.35, and D1 ships a recent SQLite, so this is safe.
ALTER TABLE reminders DROP COLUMN triage_item_id;

-- notification_log.triage_item_id is also orphaned.
ALTER TABLE notification_log DROP COLUMN triage_item_id;
