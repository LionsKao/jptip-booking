-- 課程的預設堂數：管理者幫學生新增這門已購買課程時，堂數預設帶入這個值（可以針對個別學生調整）。
-- 原本新增已購買課程一律寫死 16 堂，這裡的預設值沿用 16，既有課程不受影響。
ALTER TABLE courses ADD COLUMN default_sessions INTEGER NOT NULL DEFAULT 16 CHECK (default_sessions >= 1);
