-- Per-account UI language preference, freely switchable by the student/teacher
-- themselves; the DB value is the source of truth so it follows them across
-- devices (localStorage is only a fast local cache for pre-login/first paint).
ALTER TABLE students ADD COLUMN language TEXT NOT NULL DEFAULT 'zh-Hant';
ALTER TABLE teachers ADD COLUMN language TEXT NOT NULL DEFAULT 'zh-Hant';
