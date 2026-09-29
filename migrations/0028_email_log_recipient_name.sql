-- 寄信紀錄順便存收件人姓名（學生/老師/管理者），畫面上才看得出來是誰，不用只看 email 去猜。
ALTER TABLE email_log ADD COLUMN recipient_name TEXT;
