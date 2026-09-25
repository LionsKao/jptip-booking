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
  { key: 'booking_created_student', variables: ['studentName', 'teacherName', 'courseName', 'date', 'time', 'timezone', 'bookingCode', 'siteUrl'] },
  { key: 'booking_created_teacher', variables: ['studentName', 'teacherName', 'courseName', 'date', 'time', 'timezone', 'bookingCode', 'siteUrl'] },
  { key: 'booking_cancelled_student', variables: ['studentName', 'teacherName', 'courseName', 'date', 'time', 'timezone', 'bookingCode', 'siteUrl'] },
  { key: 'booking_cancelled_teacher', variables: ['studentName', 'teacherName', 'courseName', 'date', 'time', 'timezone', 'bookingCode', 'siteUrl'] },
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
}> = {
  'zh-Hant': {
    brand: 'JPTIP 線上一對一', auto: '此為系統自動寄送信件，請勿直接回覆。', button: '開啟預約系統',
    course: '課程', teacher: '老師', student: '學生', classTime: '上課時間', bookingCode: '預約編號',
    dateTime: '{{date}} {{time}}（{{timezone}}）',
  },
  ja: {
    brand: 'JPTIP オンライン1対1', auto: 'このメールはシステムから自動送信されています。ご返信いただいてもお答えできません。', button: '予約システムを開く',
    course: 'コース', teacher: '講師', student: '生徒', classTime: '授業日時', bookingCode: '予約番号',
    dateTime: '{{date}} {{time}}（{{timezone}}）',
  },
  en: {
    brand: 'JPTIP Online 1-on-1', auto: 'This is an automated message. Please do not reply.', button: 'Open booking system',
    course: 'Course', teacher: 'Teacher', student: 'Student', classTime: 'Class time', bookingCode: 'Booking code',
    dateTime: '{{date}} {{time}} ({{timezone}})',
  },
  vi: {
    brand: 'JPTIP Học trực tuyến 1 kèm 1', auto: 'Đây là email tự động từ hệ thống, vui lòng không trả lời.', button: 'Mở hệ thống đặt lịch',
    course: 'Khóa học', teacher: 'Giáo viên', student: 'Học viên', classTime: 'Thời gian học', bookingCode: 'Mã đặt lịch',
    dateTime: '{{date}} {{time}} ({{timezone}})',
  },
  my: {
    brand: 'JPTIP အွန်လိုင်း တစ်ဦးချင်း', auto: 'ဤအီးမေးလ်ကို စနစ်မှ အလိုအလျောက် ပို့ခြင်းဖြစ်ပါသည်၊ ပြန်စာ မပို့ပါနှင့်။', button: 'ဘွတ်ကင်စနစ် ဖွင့်ရန်',
    course: 'သင်တန်း', teacher: 'ဆရာ', student: 'ကျောင်းသား', classTime: 'သင်ခန်းစာအချိန်', bookingCode: 'ဘွတ်ကင်ကုဒ်',
    dateTime: '{{date}} {{time}} ({{timezone}})',
  },
};

const LOGIN_TEXT: Record<EmailLanguage, { subject: string; greeting: string; intro: string; expiry: string; ignore: string }> = {
  'zh-Hant': {
    subject: '【JPTIP】您的登入驗證碼',
    greeting: '{{name}} 您好，',
    intro: '您正在登入 JPTIP 預約系統，請於 <strong>5 分鐘內</strong>輸入以下驗證碼完成登入：',
    expiry: '驗證碼將於 5 分鐘後失效，請勿將驗證碼提供給任何人。',
    ignore: '如果這不是您本人的操作，請忽略這封信件即可，不會影響您的帳號安全。',
  },
  ja: {
    subject: '【JPTIP】ログイン認証コード',
    greeting: '{{name}} 様',
    intro: 'JPTIP 予約システムへのログインが行われています。<strong>5分以内</strong>に以下の認証コードを入力して、ログインを完了してください：',
    expiry: '認証コードの有効期限は5分です。認証コードは誰にも教えないでください。',
    ignore: 'お心当たりがない場合は、このメールを破棄してください。アカウントの安全には影響ありません。',
  },
  en: {
    subject: '[JPTIP] Your login verification code',
    greeting: 'Hello {{name}},',
    intro: 'You are signing in to the JPTIP booking system. Enter the code below within <strong>5 minutes</strong> to finish logging in:',
    expiry: 'This code expires in 5 minutes. Never share it with anyone.',
    ignore: "If you didn't try to sign in, you can safely ignore this email — your account is not affected.",
  },
  vi: {
    subject: '[JPTIP] Mã xác thực đăng nhập của bạn',
    greeting: 'Xin chào {{name}},',
    intro: 'Bạn đang đăng nhập vào hệ thống đặt lịch JPTIP. Vui lòng nhập mã xác thực dưới đây trong vòng <strong>5 phút</strong> để hoàn tất đăng nhập:',
    expiry: 'Mã xác thực sẽ hết hạn sau 5 phút. Vui lòng không cung cấp mã cho bất kỳ ai.',
    ignore: 'Nếu đây không phải là thao tác của bạn, vui lòng bỏ qua email này, tài khoản của bạn vẫn an toàn.',
  },
  my: {
    subject: '[JPTIP] သင်၏ အကောင့်ဝင်ရန် အတည်ပြုကုဒ်',
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
      subject: '【JPTIP】預約成功：{{courseName}} {{date}} {{time}}',
      greeting: '{{studentName}} 您好，',
      intro: '您的課程已預約成功，詳細資訊如下：',
      note: '上課時間到了，請從預約系統首頁的「會議室」進入線上課程。如需取消，請在課程規定的時限前到「我的課程」操作。',
    },
    ja: {
      subject: '【JPTIP】予約完了：{{courseName}} {{date}} {{time}}',
      greeting: '{{studentName}} 様',
      intro: '授業のご予約が完了しました。詳細は以下のとおりです：',
      note: '授業の時間になりましたら、予約システムのホームの「会議室」からオンライン授業にご参加ください。キャンセルする場合は、コースで定められた期限までに「私の授業」から操作してください。',
    },
    en: {
      subject: '[JPTIP] Booking confirmed: {{courseName}} {{date}} {{time}}',
      greeting: 'Hi {{studentName}},',
      intro: 'Your class has been booked. Here are the details:',
      note: 'When it’s time for class, join the online lesson from “Meeting Room” on the booking system’s home page. To cancel, go to “My Courses” before the course’s cancellation deadline.',
    },
    vi: {
      subject: '[JPTIP] Đặt lịch thành công: {{courseName}} {{date}} {{time}}',
      greeting: 'Xin chào {{studentName}},',
      intro: 'Bạn đã đặt lịch học thành công. Thông tin chi tiết như sau:',
      note: 'Khi đến giờ học, vui lòng vào lớp học trực tuyến từ mục “Phòng họp” trên trang chủ hệ thống đặt lịch. Nếu muốn hủy, vui lòng thao tác tại “Khóa học của tôi” trước thời hạn quy định của khóa học.',
    },
    my: {
      subject: '[JPTIP] ဘွတ်ကင် အောင်မြင်ပါသည်: {{courseName}} {{date}} {{time}}',
      greeting: 'မင်္ဂလာပါ {{studentName}}၊',
      intro: 'သင့်သင်ခန်းစာကို ဘွတ်ကင်လုပ်ပြီးပါပြီ။ အသေးစိတ်မှာ အောက်ပါအတိုင်းဖြစ်သည်-',
      note: 'သင်ခန်းစာချိန်ရောက်လျှင် ဘွတ်ကင်စနစ် ပင်မစာမျက်နှာရှိ “အစည်းအဝေးခန်း” မှ အွန်လိုင်းသင်ခန်းစာသို့ ဝင်ပါ။ ပယ်ဖျက်လိုပါက သင်တန်းသတ်မှတ်ထားသော အချိန်မတိုင်မီ “ကျွန်ုပ်၏ သင်တန်းများ” တွင် ပယ်ဖျက်ပါ။',
    },
  },
  created_teacher: {
    'zh-Hant': {
      subject: '【JPTIP】新預約：{{studentName}} {{date}} {{time}}',
      greeting: '{{teacherName}} 老師您好，',
      intro: '有學生預約了您的課程，詳細資訊如下：',
      note: '可以登入預約系統查看這堂課的詳細資訊。',
    },
    ja: {
      subject: '【JPTIP】新しい予約：{{studentName}} {{date}} {{time}}',
      greeting: '{{teacherName}} 先生',
      intro: '生徒から授業の予約が入りました。詳細は以下のとおりです：',
      note: '詳細は予約システムにログインしてご確認ください。',
    },
    en: {
      subject: '[JPTIP] New booking: {{studentName}} {{date}} {{time}}',
      greeting: 'Hi {{teacherName}},',
      intro: 'A student has booked a class with you. Here are the details:',
      note: 'Log in to the booking system for more details about this class.',
    },
    vi: {
      subject: '[JPTIP] Lịch đặt mới: {{studentName}} {{date}} {{time}}',
      greeting: 'Xin chào thầy/cô {{teacherName}},',
      intro: 'Có học viên vừa đặt lịch học với thầy/cô. Thông tin chi tiết như sau:',
      note: 'Vui lòng đăng nhập hệ thống đặt lịch để xem chi tiết buổi học.',
    },
    my: {
      subject: '[JPTIP] ဘွတ်ကင်အသစ်: {{studentName}} {{date}} {{time}}',
      greeting: 'မင်္ဂလာပါ ဆရာ {{teacherName}}၊',
      intro: 'ကျောင်းသားတစ်ဦးက သင့်သင်ခန်းစာကို ဘွတ်ကင်လုပ်ထားပါသည်။ အသေးစိတ်မှာ အောက်ပါအတိုင်းဖြစ်သည်-',
      note: 'အသေးစိတ်ကို ဘွတ်ကင်စနစ်သို့ ဝင်ရောက်၍ ကြည့်ရှုနိုင်ပါသည်။',
    },
  },
  cancelled_student: {
    'zh-Hant': {
      subject: '【JPTIP】預約已取消：{{courseName}} {{date}} {{time}}',
      greeting: '{{studentName}} 您好，',
      intro: '以下課程預約已取消，這堂課的堂數已退還：',
      note: '如需重新預約，請登入預約系統。如有疑問，請聯絡管理者。',
    },
    ja: {
      subject: '【JPTIP】予約キャンセル：{{courseName}} {{date}} {{time}}',
      greeting: '{{studentName}} 様',
      intro: '以下の授業の予約はキャンセルされました。この授業の回数は戻っています：',
      note: '再度予約する場合は、予約システムにログインしてください。ご不明な点は管理者までお問い合わせください。',
    },
    en: {
      subject: '[JPTIP] Booking cancelled: {{courseName}} {{date}} {{time}}',
      greeting: 'Hi {{studentName}},',
      intro: 'The following booking has been cancelled, and the session has been returned to your course:',
      note: 'To book again, log in to the booking system. If you have any questions, please contact an admin.',
    },
    vi: {
      subject: '[JPTIP] Đã hủy lịch học: {{courseName}} {{date}} {{time}}',
      greeting: 'Xin chào {{studentName}},',
      intro: 'Lịch học sau đã được hủy, buổi học này đã được hoàn lại:',
      note: 'Nếu muốn đặt lại, vui lòng đăng nhập hệ thống đặt lịch. Nếu có thắc mắc, vui lòng liên hệ quản trị viên.',
    },
    my: {
      subject: '[JPTIP] ဘွတ်ကင် ပယ်ဖျက်ပြီး: {{courseName}} {{date}} {{time}}',
      greeting: 'မင်္ဂလာပါ {{studentName}}၊',
      intro: 'အောက်ပါ သင်ခန်းစာ ဘွတ်ကင်ကို ပယ်ဖျက်ပြီးဖြစ်ပြီး ထိုအချိန်ပိုင်းကို ပြန်ပေးပြီးပါပြီ-',
      note: 'ထပ်မံဘွတ်ကင်လုပ်လိုပါက ဘွတ်ကင်စနစ်သို့ ဝင်ပါ။ မေးမြန်းလိုသည်များရှိပါက စီမံခန့်ခွဲသူထံ ဆက်သွယ်ပါ။',
    },
  },
  cancelled_teacher: {
    'zh-Hant': {
      subject: '【JPTIP】預約取消：{{studentName}} {{date}} {{time}}',
      greeting: '{{teacherName}} 老師您好，',
      intro: '以下課程預約已取消：',
      note: '可以登入預約系統查看最新的課程安排。',
    },
    ja: {
      subject: '【JPTIP】予約キャンセル：{{studentName}} {{date}} {{time}}',
      greeting: '{{teacherName}} 先生',
      intro: '以下の授業の予約がキャンセルされました：',
      note: '最新の授業スケジュールは予約システムにログインしてご確認ください。',
    },
    en: {
      subject: '[JPTIP] Booking cancelled: {{studentName}} {{date}} {{time}}',
      greeting: 'Hi {{teacherName}},',
      intro: 'The following booking has been cancelled:',
      note: 'Log in to the booking system to see your latest schedule.',
    },
    vi: {
      subject: '[JPTIP] Hủy lịch học: {{studentName}} {{date}} {{time}}',
      greeting: 'Xin chào thầy/cô {{teacherName}},',
      intro: 'Lịch học sau đã được hủy:',
      note: 'Vui lòng đăng nhập hệ thống đặt lịch để xem lịch dạy mới nhất.',
    },
    my: {
      subject: '[JPTIP] ဘွတ်ကင် ပယ်ဖျက်ခြင်း: {{studentName}} {{date}} {{time}}',
      greeting: 'မင်္ဂလာပါ ဆရာ {{teacherName}}၊',
      intro: 'အောက်ပါ သင်ခန်းစာ ဘွတ်ကင်ကို ပယ်ဖျက်လိုက်ပါပြီ-',
      note: 'နောက်ဆုံး သင်ခန်းစာအစီအစဉ်ကို ဘွတ်ကင်စနစ်သို့ ဝင်ရောက်၍ ကြည့်ရှုနိုင်ပါသည်။',
    },
  },
};

// 所有系統信共用的外框：藍色標題列（圖示＋品牌名稱）、白色內容區、米色頁尾
function emailLayout(lang: EmailLanguage, icon: string, body: string): string {
  const common = COMMON_TEXT[lang];
  return `<!doctype html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FFF8EC;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF8EC;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:24px;border:3px solid #F0E6D8;overflow:hidden;font-family:'Manrope','Noto Sans TC',sans-serif;">
        <tr><td style="background:#3AA0C9;padding:28px 32px;text-align:center;">
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
  return { subject: text.subject, html: emailLayout(lang, 'key.png', body) };
}

function bookingEmail(kind: BookingEmailKind, lang: EmailLanguage): { subject: string; html: string } {
  const text = BOOKING_TEXT[kind][lang];
  const common = COMMON_TEXT[lang];
  // 寄給老師的信先列學生是誰，寄給學生的信先列老師是誰
  const person: [string, string] = kind.endsWith('_teacher') ? [common.student, '{{studentName}}'] : [common.teacher, '{{teacherName}}'];
  const rows: [string, string][] = [[common.course, '{{courseName}}'], person, [common.classTime, common.dateTime], [common.bookingCode, '{{bookingCode}}']];
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
  const icon = kind.startsWith('created') ? 'icon-check.png' : 'close.png';
  return { subject: text.subject, html: emailLayout(lang, icon, body) };
}

export function defaultEmailTemplate(key: EmailTemplateKey, lang: EmailLanguage): { subject: string; html: string } {
  if (key.startsWith('login_')) return loginEmail(lang);
  return bookingEmail(key.replace(/^booking_/, '') as BookingEmailKind, lang);
}
