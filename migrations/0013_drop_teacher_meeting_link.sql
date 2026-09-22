-- meeting_link was never wired up to any API or UI (unlike students.teams_link,
-- which is an intentionally-reserved field for the same kind of feature) —
-- dead column, safe to drop.
ALTER TABLE teachers DROP COLUMN meeting_link;
