-- 上課前提醒信：每門課可以個別設定提醒信要提前幾小時寄，預設 24 小時（跟 min_lead_hours 一樣是
-- 每堂課的時間規則，放在同一張表）。
ALTER TABLE courses ADD COLUMN reminder_hours_before INTEGER NOT NULL DEFAULT 24 CHECK (reminder_hours_before >= 0);

-- 記錄這筆預約有沒有寄過提醒信，排程（見 src/index.ts 的 scheduled）每次掃描時用來避免同一堂課
-- 重複寄信；還沒寄過是 NULL。
ALTER TABLE bookings ADD COLUMN reminder_sent_at TEXT;
