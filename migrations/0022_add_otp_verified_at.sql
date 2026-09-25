-- 驗證碼的使用紀錄：記下哪一組碼真的被用來登入成功，申請驗證碼的頻率限制只計算「沒有登入成功」
-- 的申請（同一個 Email 30 秒內不能重複申請、1 小時內最多 5 組），正常登入不受影響。
ALTER TABLE otp_codes ADD COLUMN verified_at TEXT;
-- 頻率限制查詢與定期清掉一天以前的舊紀錄都靠建立時間
CREATE INDEX IF NOT EXISTS idx_otp_created_at ON otp_codes(created_at);
