-- 補償堂數紀錄：課堂不是學生的問題而中斷（例如老師方停電、臨時身體不適）時，管理者可以
-- 幫這位學生的某門課補一堂，並且一定要填原因，這裡存下來，避免日後查不到當初為什麼多一堂。
CREATE TABLE student_course_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_course_id INTEGER NOT NULL REFERENCES student_courses(id),
  sessions_delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX idx_student_course_adjustments_course ON student_course_adjustments(student_course_id);
