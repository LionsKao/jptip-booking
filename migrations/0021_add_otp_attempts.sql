-- 驗證碼的嘗試次數：防止暴力猜碼。每組驗證碼最多試 5 次（第 5 次錯就作廢），
-- 同一個帳號 1 小時內累計錯誤達 10 次就暫停驗證；成功登入那一次不算錯誤。
ALTER TABLE otp_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
