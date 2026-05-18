-- Track ordering within compound (multi-item) classifications.
-- Most items have compound_idx = NULL (single-item input).
-- When an input produces N items, they get compound_idx 0, 1, 2, …
ALTER TABLE triage_items ADD COLUMN compound_idx INTEGER;
