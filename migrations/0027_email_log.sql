-- 每次寄信（登入驗證碼、預約成功/取消通知、上課提醒信）不管成功失敗都記一筆，避免要查有沒有
-- 寄出去、寄失敗的原因是什麼時，只能跑去共用信箱翻寄件備份。
CREATE TABLE email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_key TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error TEXT,
  booking_id INTEGER,
  created_at TEXT DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX idx_email_log_created ON email_log(created_at);
CREATE INDEX idx_email_log_status ON email_log(status);
