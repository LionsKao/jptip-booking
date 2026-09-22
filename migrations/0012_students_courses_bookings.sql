ALTER TABLE students ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'));
ALTER TABLE students ADD COLUMN timezone TEXT;
-- Reserved for a future "admin sets a student's dedicated meeting-room link"
-- feature — intentionally nullable and not yet written by any UI.
ALTER TABLE students ADD COLUMN teams_link TEXT;

CREATE TABLE IF NOT EXISTS student_courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  status TEXT NOT NULL DEFAULT 'ongoing' CHECK (status IN ('ongoing', 'completed')),
  attended_count INTEGER NOT NULL DEFAULT 0,
  booked_count INTEGER NOT NULL DEFAULT 0,
  total_sessions INTEGER NOT NULL DEFAULT 16
);
CREATE INDEX IF NOT EXISTS idx_student_courses_student ON student_courses(student_id);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_code TEXT NOT NULL UNIQUE,
  student_id INTEGER NOT NULL REFERENCES students(id),
  student_course_id INTEGER NOT NULL REFERENCES student_courses(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  date TEXT NOT NULL, -- "YYYY-MM-DD"
  time TEXT NOT NULL, -- "HH:MM", start time
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'attended', 'cancelled', 'absent', 'pending')),
  created_at TEXT DEFAULT (datetime('now', '+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_student ON bookings(student_id);
CREATE INDEX IF NOT EXISTS idx_bookings_teacher_date ON bookings(teacher_id, date);
