-- 取消預約的原因跟是誰取消的：學生自己取消 vs 管理者取消（例如系統/老師方問題），才查得到
-- 「這堂課是因為誰的問題被取消」，而不是全部混在同一個 cancelled 狀態裡看不出差異。
ALTER TABLE bookings ADD COLUMN cancel_reason TEXT;
ALTER TABLE bookings ADD COLUMN cancelled_by TEXT CHECK (cancelled_by IN ('student', 'admin'));
