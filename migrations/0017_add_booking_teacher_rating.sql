-- 老師按下完成課程時，除了選填的課堂記錄（teacher_note），也可以選填 1-5 星的老師評分。
-- 可見範圍比照 teacher_note：只有老師／管理者看得到，不回傳給學生（見 src/index.ts 的 bookingRowToJson）。
ALTER TABLE bookings ADD COLUMN teacher_rating INTEGER CHECK (teacher_rating BETWEEN 1 AND 5);
