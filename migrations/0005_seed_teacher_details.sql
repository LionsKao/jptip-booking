-- Fill in specialty / motto / photo_path for the 3 existing test teachers,
-- and add the remaining 5 to reach 8 total.
UPDATE teachers SET specialty = '日文會話・5 年教學經驗', motto = '一緒に学び、共に成長していきましょう。', photo_path = 'assets/teachers/teacher-1.jpg' WHERE email = 'teacher1@jptip.co.jp';
UPDATE teachers SET specialty = '商用日文・JLPT N1', motto = '失敗を恐れず、新しい世界へ踏み出そう！', photo_path = 'assets/teachers/teacher-2.jpg' WHERE email = 'teacher2@jptip.co.jp';
UPDATE teachers SET specialty = '日文文法・JLPT 檢定專攻', motto = '毎日の小さな積み重ねが、大きな力になる。', photo_path = 'assets/teachers/teacher-3.jpg' WHERE email = 'teacher3@jptip.co.jp';

INSERT OR IGNORE INTO teachers (name, email, specialty, motto, photo_path) VALUES
  ('山田老師', 'teacher4@jptip.co.jp', '動漫日文・流行文化會話', '臭豆腐の美味しさがわかる人は、もう私の仲間です。', 'assets/teachers/teacher-4.jpg'),
  ('高橋老師', 'teacher5@jptip.co.jp', '會話練習・生活日文', '授業よりも、放課後の台湾夜市グルメが本番です。', 'assets/teachers/teacher-5.jpg'),
  ('中村老師', 'teacher6@jptip.co.jp', '聽力訓練・新聞日文', '私の体の半分は、タピオカミルクティーとルーロー飯でできています。', 'assets/teachers/teacher-6.jpg'),
  ('小林老師', 'teacher7@jptip.co.jp', '文法解析・句型整理', '質問は大歓迎！でもパクチーは大盛りでよろしく。', 'assets/teachers/teacher-7.jpg'),
  ('渡辺老師', 'teacher8@jptip.co.jp', '作文指導・寫作技巧', '私の体の半分は、タピオカミルクティーとルーロー飯でできています。', 'assets/teachers/teacher-8.jpg');
