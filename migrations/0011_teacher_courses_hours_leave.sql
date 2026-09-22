ALTER TABLE teachers ADD COLUMN phone TEXT;
ALTER TABLE teachers ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'));
-- Receipt/payroll info (address, company, wage, tax rate, timezone, bank details) is
-- admin-only, rarely queried, and was already a loose free-form object in the mock
-- data — stored as one JSON blob instead of ~8 more columns.
ALTER TABLE teachers ADD COLUMN receipt_json TEXT;

CREATE TABLE IF NOT EXISTS teacher_courses (
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  PRIMARY KEY (teacher_id, course_id)
);

CREATE TABLE IF NOT EXISTS teacher_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday .. 6 = Saturday
  start_time TEXT NOT NULL, -- "HH:MM", UTC+8 baseline (matches the rest of the schema)
  end_time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teacher_hours_teacher ON teacher_hours(teacher_id);

CREATE TABLE IF NOT EXISTS teacher_leave (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  date TEXT NOT NULL, -- "YYYY-MM-DD", whole-day only
  UNIQUE (teacher_id, date)
);
CREATE INDEX IF NOT EXISTS idx_teacher_leave_teacher ON teacher_leave(teacher_id);
