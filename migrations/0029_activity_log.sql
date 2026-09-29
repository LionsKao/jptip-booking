-- 所有課程的事件紀錄（預約、取消、老師標記完成/缺席/需處理、老師評分、學生評分），照時間排序，
-- 讓管理者看得到「誰在什麼時候做了什麼」的完整時間軸，不用分別去翻預約紀錄卡片。
-- 姓名／課程名稱／上課日期時間都是寫入當下存的快照，避免之後改名或資料被覆蓋掉，時間軸對不起來。
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'booking_created', 'booking_cancelled', 'booking_attended', 'booking_absent', 'booking_pending',
    'teacher_rated', 'student_rated'
  )),
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  booking_code TEXT NOT NULL,
  student_name TEXT NOT NULL,
  teacher_name TEXT NOT NULL,
  course_name TEXT NOT NULL,
  lesson_date TEXT NOT NULL,
  lesson_time TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('student', 'teacher', 'admin')),
  rating_value INTEGER,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX idx_activity_log_created ON activity_log(created_at);
CREATE INDEX idx_activity_log_booking ON activity_log(booking_id);
