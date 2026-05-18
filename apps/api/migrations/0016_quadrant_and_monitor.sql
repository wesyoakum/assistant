-- Add classifier-predicted quadrant and Monitor re-check date to triage_items.
ALTER TABLE triage_items ADD COLUMN quadrant TEXT
  CHECK(quadrant IN ('hot', 'action', 'plan', 'monitor', 'noop'));
ALTER TABLE triage_items ADD COLUMN next_check_at TEXT;

CREATE INDEX IF NOT EXISTS idx_triage_items_monitor
  ON triage_items(user_id, quadrant, next_check_at)
  WHERE quadrant = 'monitor' AND status = 'open';

-- Backfill existing rows from (priority, urgency) using the old derivation.
-- No existing row gets 'monitor' — Monitor is new and only assigned by the
-- classifier going forward.
UPDATE triage_items SET quadrant = CASE
  WHEN priority >= 4 AND urgency >= 3 THEN 'hot'
  WHEN priority >= 4 AND urgency < 3 THEN 'plan'
  WHEN urgency >= 4 AND priority < 4 THEN 'action'
  WHEN priority = 3 AND urgency = 3 THEN 'plan'
  WHEN priority = 3 AND urgency < 3 THEN 'noop'
  WHEN priority < 3 AND urgency = 3 THEN 'action'
  ELSE 'noop'
END WHERE quadrant IS NULL;
