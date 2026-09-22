-- 管理端頁面開始翻譯了，admins 也比照 students/teachers 加上 language 欄位，
-- 讓管理者的語言設定能跨裝置同步（之前只能存 localStorage）。
ALTER TABLE admins ADD COLUMN language TEXT NOT NULL DEFAULT 'zh-Hant';
