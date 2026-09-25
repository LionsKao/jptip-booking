-- 已購買課程的 status 原本從來沒有自動改成 completed：堂數全部上完後還停在 ongoing，
-- 導致學生預約精靈（看 status）顯示「無次數」，而管理端／學生設定頁（看堂數）顯示「完成」。
-- 現在 PATCH /api/bookings 更新已上課次數時會一併重算 status，這裡把既有資料補齊。
UPDATE student_courses
SET status = 'completed'
WHERE status = 'ongoing' AND attended_count >= total_sessions;
