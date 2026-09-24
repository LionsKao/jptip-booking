-- 統一學生／老師的時區標籤寫法，對齊各頁時區下拉選單的選項（不加括號、偏移量補零）：
--   'UTC+06:30 仰光' / 'UTC+07:00 河內、胡志明市' / 'UTC+08:00 台北' / 'UTC+09:00 大阪、札幌、東京'
-- 舊資料有好幾種寫法（例：'(UTC+8) 台北'、'(UTC+6:30) 仰光'、'(UTC+9) 東京'、'(UTC+09:00) 台北'），
-- 跟選項對不上時，編輯頁的下拉選單會什麼都沒選到，這時按「確認編輯」會把時區存成空白。
-- 依標籤開頭的 UTC 偏移量（去掉括號後、第一個空白之前的部分）對應到選項的標準寫法，城市名稱
-- 也一併對齊選項；對不到的值維持原樣。

CREATE TABLE _tz_label_map (variant TEXT PRIMARY KEY, label TEXT NOT NULL);
INSERT INTO _tz_label_map (variant, label) VALUES
  ('UTC+6:30',  'UTC+06:30 仰光'),
  ('UTC+06:30', 'UTC+06:30 仰光'),
  ('UTC+7',     'UTC+07:00 河內、胡志明市'),
  ('UTC+7:00',  'UTC+07:00 河內、胡志明市'),
  ('UTC+07',    'UTC+07:00 河內、胡志明市'),
  ('UTC+07:00', 'UTC+07:00 河內、胡志明市'),
  ('UTC+8',     'UTC+08:00 台北'),
  ('UTC+8:00',  'UTC+08:00 台北'),
  ('UTC+08',    'UTC+08:00 台北'),
  ('UTC+08:00', 'UTC+08:00 台北'),
  ('UTC+9',     'UTC+09:00 大阪、札幌、東京'),
  ('UTC+9:00',  'UTC+09:00 大阪、札幌、東京'),
  ('UTC+09',    'UTC+09:00 大阪、札幌、東京'),
  ('UTC+09:00', 'UTC+09:00 大阪、札幌、東京');

-- 偏移量部分：去掉括號，取第一個空白之前（'(UTC+6:30) 仰光' → 'UTC+6:30'；'UTC+06:30 仰光' → 'UTC+06:30'）
UPDATE students
SET timezone = (
  SELECT label FROM _tz_label_map
  WHERE variant = trim(replace(replace(
    substr(students.timezone, 1, CASE WHEN instr(students.timezone, ' ') > 0 THEN instr(students.timezone, ' ') - 1 ELSE length(students.timezone) END),
    '(', ''), ')', ''))
)
WHERE timezone IS NOT NULL
  AND trim(replace(replace(
    substr(timezone, 1, CASE WHEN instr(timezone, ' ') > 0 THEN instr(timezone, ' ') - 1 ELSE length(timezone) END),
    '(', ''), ')', '')) IN (SELECT variant FROM _tz_label_map);

-- 老師的時區存在 receipt_json 的 timezone 欄位裡
UPDATE teachers
SET receipt_json = json_set(receipt_json, '$.timezone', (
  SELECT label FROM _tz_label_map
  WHERE variant = trim(replace(replace(
    substr(json_extract(teachers.receipt_json, '$.timezone'), 1,
      CASE WHEN instr(json_extract(teachers.receipt_json, '$.timezone'), ' ') > 0
        THEN instr(json_extract(teachers.receipt_json, '$.timezone'), ' ') - 1
        ELSE length(json_extract(teachers.receipt_json, '$.timezone')) END),
    '(', ''), ')', ''))
))
WHERE json_valid(receipt_json)
  AND json_extract(receipt_json, '$.timezone') IS NOT NULL
  AND trim(replace(replace(
    substr(json_extract(receipt_json, '$.timezone'), 1,
      CASE WHEN instr(json_extract(receipt_json, '$.timezone'), ' ') > 0
        THEN instr(json_extract(receipt_json, '$.timezone'), ' ') - 1
        ELSE length(json_extract(receipt_json, '$.timezone')) END),
    '(', ''), ')', '')) IN (SELECT variant FROM _tz_label_map);

DROP TABLE _tz_label_map;
