-- 學生可以對已完成（attended）的預約留下選填的 1-5 星評分＋留言（booking-history.html）；
-- 老師按下完成課程時可以留下選填的課堂記錄（lessons.html）。三欄皆可為 NULL、互相獨立。
-- 可見範圍由 src/index.ts 的 bookingRowToJson（viewerRole 參數）統一控制：
-- teacher_note 只有老師／管理者看得到（不回傳給學生）；rating／student_comment 只有學生本人／管理者看得到（不回傳給老師）。
ALTER TABLE bookings ADD COLUMN rating INTEGER CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE bookings ADD COLUMN student_comment TEXT;
ALTER TABLE bookings ADD COLUMN teacher_note TEXT;
