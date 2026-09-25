-- 系統信件範本（管理端「系統信件」）：只存管理者改過的語言版本，沒有的就用程式內建的預設範本
-- （src/email-templates.ts）。改回跟預設一模一樣時會刪掉這一筆，之後預設範本更新也會跟著套用。
CREATE TABLE IF NOT EXISTS email_templates (
  template_key TEXT NOT NULL,
  language TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  PRIMARY KEY (template_key, language)
);
