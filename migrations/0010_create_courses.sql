-- Courses, first real (non-mock) piece of the course/booking data model.
-- Column names follow the existing photo_path/created_at snake_case
-- convention; the API translates to/from the frontend's camelCase field
-- names (durationMinutes, image, ...).
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  photo_path TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  duration_minutes INTEGER NOT NULL DEFAULT 100,
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes INTEGER NOT NULL DEFAULT 20,
  schedule_increment TEXT NOT NULL DEFAULT '1 小時',
  min_lead_hours INTEGER NOT NULL DEFAULT 48,
  max_lead_days INTEGER NOT NULL DEFAULT 30,
  created_at TEXT DEFAULT (datetime('now', '+8 hours'))
);
