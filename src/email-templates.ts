// ==========================================================================
// 系統信件範本：系統會寄出的每一種信（登入驗證碼、預約成功／取消通知…）都有五種語言的預設範本，
// 收件人設定哪個語言就寄哪個版本。管理者可以在管理端「系統信件」修改 HTML，改過的存在 D1 的
// email_templates（見 src/index.ts 的 loadEmailTemplate），沒改過的就用這裡的預設範本。
//
// 範本裡用 {{變數名}} 代入寄信當下的資料（收件人姓名、驗證碼、上課時間…）。代入 HTML 時會先
// 跳脫，姓名裡就算有 < > 也不會變成 HTML；主旨是純文字，只會把換行換成空白。
// ==========================================================================

export const EMAIL_LANGUAGES = ['zh-Hant', 'ja', 'en', 'vi', 'my'] as const;
export type EmailLanguage = (typeof EMAIL_LANGUAGES)[number];

// 順序就是管理端「系統信件」卡片的順序
export const EMAIL_TEMPLATES = [
  { key: 'login_admin', variables: ['name', 'code', 'siteUrl'] },
  { key: 'login_teacher', variables: ['name', 'code', 'siteUrl'] },
  { key: 'login_student', variables: ['name', 'code', 'siteUrl'] },
  { key: 'booking_created_student', variables: ['bookingCode', 'courseName', 'studentName', 'teacherName', 'date', 'time', 'endTime', 'duration', 'timezone', 'bookingNumber', 'attendedCount', 'totalSessions', 'siteUrl'] },
  { key: 'booking_created_teacher', variables: ['bookingCode', 'courseName', 'studentName', 'teacherName', 'date', 'time', 'endTime', 'duration', 'timezone', 'bookingNumber', 'attendedCount', 'totalSessions', 'siteUrl'] },
  { key: 'booking_cancelled_student', variables: ['bookingCode', 'courseName', 'studentName', 'teacherName', 'date', 'time', 'endTime', 'duration', 'timezone', 'siteUrl'] },
  { key: 'booking_cancelled_teacher', variables: ['bookingCode', 'courseName', 'studentName', 'teacherName', 'date', 'time', 'endTime', 'duration', 'timezone', 'siteUrl'] },
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATES)[number]['key'];

export function isEmailTemplateKey(value: unknown): value is EmailTemplateKey {
  return EMAIL_TEMPLATES.some((tpl) => tpl.key === value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

// 把 {{變數名}} 換成實際資料；範本裡寫了不存在的變數就原樣留著，寄出去看得出來是哪裡打錯
export function fillEmailTemplate(template: string, vars: Record<string, string>, mode: 'html' | 'text'): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
    const value = vars[name];
    return mode === 'html' ? escapeHtml(value) : value.replace(/[\r\n]+/g, ' ');
  });
}

// --------------------------------------------------------------------------
// 預設範本
// --------------------------------------------------------------------------
const COMMON_TEXT: Record<EmailLanguage, {
  brand: string; auto: string; button: string;
  course: string; teacher: string; student: string; classTime: string; bookingCode: string;
  dateTime: string;
  bookingNumberLabel: string; bookingNumberValue: string;
  attendedLabel: string; attendedValue: string;
}> = {
  'zh-Hant': {
    brand: '線上一對一', auto: '此為系統自動寄送信件，請勿直接回覆。', button: '開啟預約系統',
    course: '課程', teacher: '老師', student: '學生', classTime: '上課時間', bookingCode: '預約編號',
    dateTime: '{{date}}<br>{{time}} - {{endTime}}<br>{{duration}}<br>{{timezone}}',
    bookingNumberLabel: '第幾次預約', bookingNumberValue: '{{bookingNumber}} / {{totalSessions}} 堂',
    attendedLabel: '已上課堂數', attendedValue: '{{attendedCount}} / {{totalSessions}} 堂',
  },
  ja: {
    brand: 'オンライン1対1', auto: 'このメールはシステムから自動送信されています。ご返信いただいてもお答えできません。', button: '予約システムを開く',
    course: 'コース', teacher: '講師', student: '生徒', classTime: '授業日時', bookingCode: '予約番号',
    dateTime: '{{date}}<br>{{time}} - {{endTime}}<br>{{duration}}<br>{{timezone}}',
    bookingNumberLabel: '予約回数', bookingNumberValue: '{{bookingNumber}} / {{totalSessions}} 回',
    attendedLabel: '受講済み回数', attendedValue: '{{attendedCount}} / {{totalSessions}} 回',
  },
  en: {
    brand: 'Online 1-on-1', auto: 'This is an automated message. Please do not reply.', button: 'Open booking system',
    course: 'Course', teacher: 'Teacher', student: 'Student', classTime: 'Class time', bookingCode: 'Booking code',
    dateTime: '{{date}}<br>{{time}} - {{endTime}}<br>{{duration}}<br>{{timezone}}',
    bookingNumberLabel: 'Booking number', bookingNumberValue: '{{bookingNumber}} / {{totalSessions}}',
    attendedLabel: 'Lessons completed', attendedValue: '{{attendedCount}} / {{totalSessions}}',
  },
  vi: {
    brand: 'Học trực tuyến 1 kèm 1', auto: 'Đây là email tự động từ hệ thống, vui lòng không trả lời.', button: 'Mở hệ thống đặt lịch',
    course: 'Khóa học', teacher: 'Giáo viên', student: 'Học viên', classTime: 'Thời gian học', bookingCode: 'Mã đặt lịch',
    dateTime: '{{date}}<br>{{time}} - {{endTime}}<br>{{duration}}<br>{{timezone}}',
    bookingNumberLabel: 'Lần đặt lịch', bookingNumberValue: '{{bookingNumber}} / {{totalSessions}} buổi',
    attendedLabel: 'Số buổi đã học', attendedValue: '{{attendedCount}} / {{totalSessions}} buổi',
  },
  my: {
    brand: 'အွန်လိုင်း တစ်ဦးချင်း', auto: 'ဤအီးမေးလ်ကို စနစ်မှ အလိုအလျောက် ပို့ခြင်းဖြစ်ပါသည်၊ ပြန်စာ မပို့ပါနှင့်။', button: 'ဘွတ်ကင်စနစ် ဖွင့်ရန်',
    course: 'သင်တန်း', teacher: 'ဆရာ', student: 'ကျောင်းသား', classTime: 'သင်ခန်းစာအချိန်', bookingCode: 'ဘွတ်ကင်ကုဒ်',
    dateTime: '{{date}}<br>{{time}} - {{endTime}}<br>{{duration}}<br>{{timezone}}',
    bookingNumberLabel: 'ဘွတ်ကင် အကြိမ်', bookingNumberValue: '{{bookingNumber}} / {{totalSessions}} ကြိမ်',
    attendedLabel: 'တက်ရောက်ပြီးသင်ခန်းစာ', attendedValue: '{{attendedCount}} / {{totalSessions}} ကြိမ်',
  },
};

// 上課時長的顯示文字，跟前端 i18n 的 common.duration* 用同一套措辭（見 public/i18n/*.json）
const DURATION_TEXT: Record<EmailLanguage, { both: (h: number, m: number) => string; hourOnly: (h: number) => string; minuteOnly: (m: number) => string }> = {
  'zh-Hant': { both: (h, m) => `${h} 時 ${m} 分`, hourOnly: (h) => `${h} 時`, minuteOnly: (m) => `${m} 分` },
  ja: { both: (h, m) => `${h}時間${m}分`, hourOnly: (h) => `${h}時間`, minuteOnly: (m) => `${m}分` },
  en: { both: (h, m) => `${h}h ${m}m`, hourOnly: (h) => `${h}h`, minuteOnly: (m) => `${m}m` },
  vi: { both: (h, m) => `${h} giờ ${m} phút`, hourOnly: (h) => `${h} giờ`, minuteOnly: (m) => `${m} phút` },
  my: { both: (h, m) => `${h} နာရီ ${m} မိနစ်`, hourOnly: (h) => `${h} နာရီ`, minuteOnly: (m) => `${m} မိနစ်` },
};

export function formatEmailDuration(minutes: number, lang: EmailLanguage): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const text = DURATION_TEXT[lang];
  if (h && m) return text.both(h, m);
  if (h) return text.hourOnly(h);
  return text.minuteOnly(m);
}

// 長日期格式用的星期幾／月份名稱，跟前端 public/script.js 的 formatDateLong 同一套文字
// （緬甸文不透過 Intl 查，原因見前端該檔案的說明：不少環境沒有內建緬甸文語系資料）
const WEEKDAY_TEXT_MY = ['တနင်္ဂနွေ', 'တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ', 'စနေ'];
const MONTH_TEXT_MY = [
  'ဇန်နဝါရီ', 'ဖေဖော်ဝါရီ', 'မတ်', 'ဧပြီ', 'မေ', 'ဇွန်',
  'ဇူလိုင်', 'သြဂုတ်', 'စက်တင်ဘာ', 'အောက်တိုဘာ', 'နိုဝင်ဘာ', 'ဒီဇင်ဘာ',
];
const DATE_LOCALE_MAP: Record<EmailLanguage, string> = {
  'zh-Hant': 'zh-TW', ja: 'ja-JP', en: 'en-GB', vi: 'vi-VN', my: 'my-MM-u-nu-latn',
};

// date 是 'YYYY/MM/DD'（已經換算成收件人時區的日曆日期）。跟前端 formatDateLong 用同一套排法，
// 含星期幾的長格式，例如「2026 年 10 月 05 日 星期一」；不用再考慮時區（該用哪個時區已經反映在
// 這個日期本身上了），固定用 UTC 讀年月日／星期幾，避免受執行環境時區影響。
export function formatEmailDateLong(date: string, lang: EmailLanguage): string {
  const [y, m, d] = date.split('/').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  if (lang === 'my') {
    return `${y} ${MONTH_TEXT_MY[m - 1]} ${d} ${WEEKDAY_TEXT_MY[utcDate.getUTCDay()]}`;
  }
  const locale = DATE_LOCALE_MAP[lang];
  if (lang === 'zh-Hant') {
    const month = String(m).padStart(2, '0');
    const day = String(d).padStart(2, '0');
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(utcDate);
    return `${y} 年 ${month} 月 ${day} 日 ${weekday}`;
  }
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC' }).format(utcDate);
}

const LOGIN_TEXT: Record<EmailLanguage, { subject: string; greeting: string; intro: string; expiry: string; ignore: string }> = {
  'zh-Hant': {
    subject: '🔑 您的登入驗證碼',
    greeting: '{{name}} 您好，',
    intro: '您正在登入 JPTIP 預約系統，請於 <strong>5 分鐘內</strong>輸入以下驗證碼完成登入：',
    expiry: '驗證碼將於 5 分鐘後失效，請勿將驗證碼提供給任何人。',
    ignore: '如果這不是您本人的操作，請忽略這封信件即可，不會影響您的帳號安全。',
  },
  ja: {
    subject: '🔑 ログイン認証コード',
    greeting: '{{name}} 様',
    intro: 'JPTIP 予約システムへのログインが行われています。<strong>5分以内</strong>に以下の認証コードを入力して、ログインを完了してください：',
    expiry: '認証コードの有効期限は5分です。認証コードは誰にも教えないでください。',
    ignore: 'お心当たりがない場合は、このメールを破棄してください。アカウントの安全には影響ありません。',
  },
  en: {
    subject: '🔑 Your login verification code',
    greeting: 'Hello {{name}},',
    intro: 'You are signing in to the JPTIP booking system. Enter the code below within <strong>5 minutes</strong> to finish logging in:',
    expiry: 'This code expires in 5 minutes. Never share it with anyone.',
    ignore: "If you didn't try to sign in, you can safely ignore this email — your account is not affected.",
  },
  vi: {
    subject: '🔑 Mã xác thực đăng nhập của bạn',
    greeting: 'Xin chào {{name}},',
    intro: 'Bạn đang đăng nhập vào hệ thống đặt lịch JPTIP. Vui lòng nhập mã xác thực dưới đây trong vòng <strong>5 phút</strong> để hoàn tất đăng nhập:',
    expiry: 'Mã xác thực sẽ hết hạn sau 5 phút. Vui lòng không cung cấp mã cho bất kỳ ai.',
    ignore: 'Nếu đây không phải là thao tác của bạn, vui lòng bỏ qua email này, tài khoản của bạn vẫn an toàn.',
  },
  my: {
    subject: '🔑 သင်၏ အကောင့်ဝင်ရန် အတည်ပြုကုဒ်',
    greeting: 'မင်္ဂလာပါ {{name}}၊',
    intro: 'သင်သည် JPTIP ဘွတ်ကင်စနစ်သို့ အကောင့်ဝင်နေပါသည်။ အကောင့်ဝင်ခြင်း ပြီးမြောက်ရန် အောက်ပါ အတည်ပြုကုဒ်ကို <strong>၅ မိနစ်အတွင်း</strong> ထည့်သွင်းပါ-',
    expiry: 'အတည်ပြုကုဒ်သည် ၅ မိနစ်အကြာတွင် သက်တမ်းကုန်ပါမည်။ မည်သူ့ကိုမျှ မပေးပါနှင့်။',
    ignore: 'ဤလုပ်ဆောင်ချက်ကို သင်ကိုယ်တိုင် မလုပ်ခဲ့ပါက ဤအီးမေးလ်ကို လျစ်လျူရှုနိုင်ပါသည်၊ သင့်အကောင့် လုံခြုံမှုကို မထိခိုက်ပါ။',
  },
};

type BookingEmailKind = 'created_student' | 'created_teacher' | 'cancelled_student' | 'cancelled_teacher';
type BookingText = { subject: string; greeting: string; intro: string; note: string };

const BOOKING_TEXT: Record<BookingEmailKind, Record<EmailLanguage, BookingText>> = {
  created_student: {
    'zh-Hant': {
      subject: '✅ 預約成功：{{studentName}} {{courseName}} {{date}} {{time}}',
      greeting: '{{studentName}} 您好，',
      intro: '您的課程已預約成功，詳細資訊如下：',
      note: '上課時間到了，請從預約系統首頁的「會議室」進入線上課程。如需取消，請在課程規定的時限前到「我的課程」操作。',
    },
    ja: {
      subject: '✅ 予約完了：{{studentName}} {{courseName}} {{date}} {{time}}',
      greeting: '{{studentName}} 様',
      intro: '授業のご予約が完了しました。詳細は以下のとおりです：',
      note: '授業の時間になりましたら、予約システムのホームの「会議室」からオンライン授業にご参加ください。キャンセルする場合は、コースで定められた期限までに「私の授業」から操作してください。',
    },
    en: {
      subject: '✅ Booking confirmed: {{studentName}} {{courseName}} {{date}} {{time}}',
      greeting: 'Hi {{studentName}},',
      intro: 'Your class has been booked. Here are the details:',
      note: 'When it’s time for class, join the online lesson from “Meeting Room” on the booking system’s home page. To cancel, go to “My Courses” before the course’s cancellation deadline.',
    },
    vi: {
      subject: '✅ Đặt lịch thành công: {{studentName}} {{courseName}} {{date}} {{time}}',
      greeting: 'Xin chào {{studentName}},',
      intro: 'Bạn đã đặt lịch học thành công. Thông tin chi tiết như sau:',
      note: 'Khi đến giờ học, vui lòng vào lớp học trực tuyến từ mục “Phòng họp” trên trang chủ hệ thống đặt lịch. Nếu muốn hủy, vui lòng thao tác tại “Khóa học của tôi” trước thời hạn quy định của khóa học.',
    },
    my: {
      subject: '✅ ဘွတ်ကင် အောင်မြင်ပါသည်: {{studentName}} {{courseName}} {{date}} {{time}}',
      greeting: 'မင်္ဂလာပါ {{studentName}}၊',
      intro: 'သင့်သင်ခန်းစာကို ဘွတ်ကင်လုပ်ပြီးပါပြီ။ အသေးစိတ်မှာ အောက်ပါအတိုင်းဖြစ်သည်-',
      note: 'သင်ခန်းစာချိန်ရောက်လျှင် ဘွတ်ကင်စနစ် ပင်မစာမျက်နှာရှိ “အစည်းအဝေးခန်း” မှ အွန်လိုင်းသင်ခန်းစာသို့ ဝင်ပါ။ ပယ်ဖျက်လိုပါက သင်တန်းသတ်မှတ်ထားသော အချိန်မတိုင်မီ “ကျွန်ုပ်၏ သင်တန်းများ” တွင် ပယ်ဖျက်ပါ။',
    },
  },
  created_teacher: {
    'zh-Hant': {
      subject: '✅ 新預約：{{studentName}} {{date}} {{time}}',
      greeting: '{{teacherName}} 老師您好，',
      intro: '有學生預約了您的課程，詳細資訊如下：',
      note: '可以登入預約系統查看這堂課的詳細資訊。',
    },
    ja: {
      subject: '✅ 新しい予約：{{studentName}} {{date}} {{time}}',
      greeting: '{{teacherName}} 先生',
      intro: '生徒から授業の予約が入りました。詳細は以下のとおりです：',
      note: '詳細は予約システムにログインしてご確認ください。',
    },
    en: {
      subject: '✅ New booking: {{studentName}} {{date}} {{time}}',
      greeting: 'Hi {{teacherName}},',
      intro: 'A student has booked a class with you. Here are the details:',
      note: 'Log in to the booking system for more details about this class.',
    },
    vi: {
      subject: '✅ Lịch đặt mới: {{studentName}} {{date}} {{time}}',
      greeting: 'Xin chào thầy/cô {{teacherName}},',
      intro: 'Có học viên vừa đặt lịch học với thầy/cô. Thông tin chi tiết như sau:',
      note: 'Vui lòng đăng nhập hệ thống đặt lịch để xem chi tiết buổi học.',
    },
    my: {
      subject: '✅ ဘွတ်ကင်အသစ်: {{studentName}} {{date}} {{time}}',
      greeting: 'မင်္ဂလာပါ ဆရာ {{teacherName}}၊',
      intro: 'ကျောင်းသားတစ်ဦးက သင့်သင်ခန်းစာကို ဘွတ်ကင်လုပ်ထားပါသည်။ အသေးစိတ်မှာ အောက်ပါအတိုင်းဖြစ်သည်-',
      note: 'အသေးစိတ်ကို ဘွတ်ကင်စနစ်သို့ ဝင်ရောက်၍ ကြည့်ရှုနိုင်ပါသည်။',
    },
  },
  cancelled_student: {
    'zh-Hant': {
      subject: '❌ 預約已取消：{{studentName}} {{courseName}} {{date}} {{time}}',
      greeting: '{{studentName}} 您好，',
      intro: '以下課程預約已取消，這堂課的堂數已退還：',
      note: '如需重新預約，請登入預約系統。如有疑問，請聯絡管理者。',
    },
    ja: {
      subject: '❌ 予約キャンセル：{{studentName}} {{courseName}} {{date}} {{time}}',
      greeting: '{{studentName}} 様',
      intro: '以下の授業の予約はキャンセルされました。この授業の回数は戻っています：',
      note: '再度予約する場合は、予約システムにログインしてください。ご不明な点は管理者までお問い合わせください。',
    },
    en: {
      subject: '❌ Booking cancelled: {{studentName}} {{courseName}} {{date}} {{time}}',
      greeting: 'Hi {{studentName}},',
      intro: 'The following booking has been cancelled, and the session has been returned to your course:',
      note: 'To book again, log in to the booking system. If you have any questions, please contact an admin.',
    },
    vi: {
      subject: '❌ Đã hủy lịch học: {{studentName}} {{courseName}} {{date}} {{time}}',
      greeting: 'Xin chào {{studentName}},',
      intro: 'Lịch học sau đã được hủy, buổi học này đã được hoàn lại:',
      note: 'Nếu muốn đặt lại, vui lòng đăng nhập hệ thống đặt lịch. Nếu có thắc mắc, vui lòng liên hệ quản trị viên.',
    },
    my: {
      subject: '❌ ဘွတ်ကင် ပယ်ဖျက်ပြီး: {{studentName}} {{courseName}} {{date}} {{time}}',
      greeting: 'မင်္ဂလာပါ {{studentName}}၊',
      intro: 'အောက်ပါ သင်ခန်းစာ ဘွတ်ကင်ကို ပယ်ဖျက်ပြီးဖြစ်ပြီး ထိုအချိန်ပိုင်းကို ပြန်ပေးပြီးပါပြီ-',
      note: 'ထပ်မံဘွတ်ကင်လုပ်လိုပါက ဘွတ်ကင်စနစ်သို့ ဝင်ပါ။ မေးမြန်းလိုသည်များရှိပါက စီမံခန့်ခွဲသူထံ ဆက်သွယ်ပါ။',
    },
  },
  cancelled_teacher: {
    'zh-Hant': {
      subject: '❌ 預約取消：{{studentName}} {{date}} {{time}}',
      greeting: '{{teacherName}} 老師您好，',
      intro: '以下課程預約已取消：',
      note: '可以登入預約系統查看最新的課程安排。',
    },
    ja: {
      subject: '❌ 予約キャンセル：{{studentName}} {{date}} {{time}}',
      greeting: '{{teacherName}} 先生',
      intro: '以下の授業の予約がキャンセルされました：',
      note: '最新の授業スケジュールは予約システムにログインしてご確認ください。',
    },
    en: {
      subject: '❌ Booking cancelled: {{studentName}} {{date}} {{time}}',
      greeting: 'Hi {{teacherName}},',
      intro: 'The following booking has been cancelled:',
      note: 'Log in to the booking system to see your latest schedule.',
    },
    vi: {
      subject: '❌ Hủy lịch học: {{studentName}} {{date}} {{time}}',
      greeting: 'Xin chào thầy/cô {{teacherName}},',
      intro: 'Lịch học sau đã được hủy:',
      note: 'Vui lòng đăng nhập hệ thống đặt lịch để xem lịch dạy mới nhất.',
    },
    my: {
      subject: '❌ ဘွတ်ကင် ပယ်ဖျက်ခြင်း: {{studentName}} {{date}} {{time}}',
      greeting: 'မင်္ဂလာပါ ဆရာ {{teacherName}}၊',
      intro: 'အောက်ပါ သင်ခန်းစာ ဘွတ်ကင်ကို ပယ်ဖျက်လိုက်ပါပြီ-',
      note: 'နောက်ဆုံး သင်ခန်းစာအစီအစဉ်ကို ဘွတ်ကင်စနစ်သို့ ဝင်ရောက်၍ ကြည့်ရှုနိုင်ပါသည်။',
    },
  },
};

// 所有系統信共用的外框：標題列（圖示＋品牌名稱，顏色依信件類型而定）、白色內容區、米色頁尾
function emailLayout(lang: EmailLanguage, icon: string, color: string, body: string): string {
  const common = COMMON_TEXT[lang];
  return `<!doctype html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FFF8EC;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF8EC;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:24px;border:3px solid #F0E6D8;overflow:hidden;font-family:'Manrope','Noto Sans TC',sans-serif;">
        <tr><td style="background:${color};padding:28px 32px;text-align:center;">
          <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 10px;">
            <tr><td width="56" height="56" style="background:#ffffff;border-radius:50%;text-align:center;vertical-align:middle;">
              <img src="{{siteUrl}}/assets/icons/${icon}" width="32" height="32" alt="" style="display:inline-block;vertical-align:middle;">
            </td></tr>
          </table>
          <div style="font-size:18px;font-weight:800;color:#ffffff;letter-spacing:.02em;">${common.brand}</div>
        </td></tr>
        <tr><td style="padding:32px;">
${body}
        </td></tr>
        <tr><td style="padding:20px 32px;background:#FFF8EC;text-align:center;border-top:3px solid #F0E6D8;">
          <div style="font-size:12px;color:#8f8a87;line-height:1.6;">${common.auto}<br>© JPTIP</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function loginEmail(lang: EmailLanguage): { subject: string; html: string } {
  const text = LOGIN_TEXT[lang];
  const body = `          <div style="font-size:15px;color:#454545;margin-bottom:20px;">${text.greeting}</div>
          <div style="font-size:15px;color:#454545;line-height:1.8;margin-bottom:24px;">${text.intro}</div>
          <div style="text-align:center;margin-bottom:28px;">
            <span style="display:inline-block;font-size:32px;font-weight:800;letter-spacing:.3em;color:#1F6E8C;background:#E3F4FA;border-radius:16px;padding:16px 28px;">{{code}}</span>
          </div>
          <div style="font-size:13px;color:#8f8a87;line-height:1.7;border-top:3px solid #F0E6D8;padding-top:16px;">${text.expiry}<br>${text.ignore}</div>`;
  return { subject: text.subject, html: emailLayout(lang, 'key.png', '#3AA0C9', body) };
}

function bookingEmail(kind: BookingEmailKind, lang: EmailLanguage): { subject: string; html: string } {
  const text = BOOKING_TEXT[kind][lang];
  const common = COMMON_TEXT[lang];
  const rows: [string, string][] = [
    [common.bookingCode, '{{bookingCode}}'],
    [common.course, '{{courseName}}'],
    [common.student, '{{studentName}}'],
    [common.teacher, '{{teacherName}}'],
    [common.classTime, common.dateTime],
  ];
  // 課程進度只在「預約成功」信裡有意義：取消當下 student_courses 的堂數已經扣掉這筆，
  // 放進取消信會讓人誤以為這筆還算在裡面
  if (kind.startsWith('created')) {
    rows.push([common.bookingNumberLabel, common.bookingNumberValue], [common.attendedLabel, common.attendedValue]);
  }
  const rowHtml = rows.map(([label, value]) => `            <tr>
              <td style="padding:10px 12px 10px 0;border-bottom:2px solid #F0E6D8;font-size:14px;color:#8f8a87;white-space:nowrap;vertical-align:top;">${label}</td>
              <td style="padding:10px 0;border-bottom:2px solid #F0E6D8;font-size:15px;font-weight:700;color:#454545;">${value}</td>
            </tr>`).join('\n');
  const body = `          <div style="font-size:15px;color:#454545;margin-bottom:20px;">${text.greeting}</div>
          <div style="font-size:15px;color:#454545;line-height:1.8;margin-bottom:16px;">${text.intro}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
${rowHtml}
          </table>
          <div style="font-size:14px;color:#454545;line-height:1.8;margin-bottom:24px;">${text.note}</div>
          <div style="text-align:center;">
            <a href="{{siteUrl}}" style="display:inline-block;background:#3AA0C9;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;border-radius:999px;padding:12px 28px;">${common.button}</a>
          </div>`;
  const icon = kind.startsWith('created') ? 'check.png' : 'close.png';
  const color = kind.startsWith('created') ? '#78b154' : '#f73b5d';
  return { subject: text.subject, html: emailLayout(lang, icon, color, body) };
}

export function defaultEmailTemplate(key: EmailTemplateKey, lang: EmailLanguage): { subject: string; html: string } {
  if (key.startsWith('login_')) return loginEmail(lang);
  return bookingEmail(key.replace(/^booking_/, '') as BookingEmailKind, lang);
}
