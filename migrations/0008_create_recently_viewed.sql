-- Shared "recently viewed" tracking for the admin teacher/student/course list
-- pages: when one admin opens a detail page, that bump should be visible to
-- every other admin too, so this lives in D1 rather than localStorage.
-- (The list pages' search box text stays per-device in localStorage — see
-- the SEARCH_KEY handling in teachers.html/students.html/courses.html.)
CREATE TABLE IF NOT EXISTS recently_viewed (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('teacher', 'student', 'course')),
  entity_id INTEGER NOT NULL,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
