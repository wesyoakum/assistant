-- Add source_type to pending_emails for multi-source collect
ALTER TABLE pending_emails ADD COLUMN source_type TEXT NOT NULL DEFAULT 'email';
