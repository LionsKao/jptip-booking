import { defaultEmailTemplate, EMAIL_TEMPLATES, fillEmailTemplate, formatEmailDateLong, formatEmailDuration, isEmailTemplateKey, type EmailTemplateKey } from './email-templates';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AVATARS: R2Bucket;
  // 寄驗證碼 Email 用的 Microsoft Graph（client credentials）：租用戶／應用程式 ID 跟寄件信箱是
  // wrangler.jsonc 的 vars，MS_CLIENT_SECRET 是 Worker secret。沒設定 secret 就不寄信
  // （本機開發用 ALLOW_ANY_OTP 任意驗證碼登入，測試也不會真的寄出信件）。本機想真的寄信測試，
  // 把 secret 放進 .dev.vars 即可，寄出的信標題會加上「[測試]」（見 mailSubjectPrefix）。
  MS_TENANT_ID?: string;
  MS_CLIENT_ID?: string;
  MS_SENDER_EMAIL?: string;
  MS_CLIENT_SECRET?: string;
  // Dev/test-site only: when 'true', /api/otp/verify accepts any 6-digit code.
  // Must never be set in the production deployment's vars/secrets.
  ALLOW_ANY_OTP?: string;
}

const ROLE_TABLES: Record<string, string> = {
  student: 'students',
  teacher: 'teachers',
  admin: 'admins',
};

// UI language, stored per-account so it follows a student/teacher across
// devices — switching pages re-reads it from their own record rather than
// trusting a client-supplied value.
const SUPPORTED_LANGUAGES = ['zh-Hant', 'ja', 'en', 'vi', 'my'] as const;
type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

// 使用者操作時可能碰到的錯誤（Email 重複、時段被搶走、超過取消期限…）多帶一個 code，前端
// script.js 的 apiErrorMessage() 用它找目前介面語言的翻譯（i18n 的 apiError.<code>，params 是
// 裡面的 {{變數}}）。error 維持中文說明方便看 API 回應除錯；沒帶 code 的錯誤前端只顯示通用的失敗訊息。
function apiError(status: number, code: string, error: string, params?: Record<string, number>): Response {
  return Response.json(params ? { error, code, params } : { error, code }, { status });
}

// Self-service language switch — the student/teacher/admin themselves updates
// only this one field on their own row (identified by session.userId, never a
// client-supplied id), separate from the admin-only full-profile PATCH.
async function handleOwnLanguageUpdate(request: Request, env: Env, session: Session): Promise<Response> {
  const table = ROLE_TABLES[session.role];
  const body = await request.json<{ language?: string }>();
  if (!isSupportedLanguage(body.language)) {
    return Response.json({ error: '不支援的語言' }, { status: 400 });
  }
  await env.DB.prepare(`UPDATE ${table} SET language = ? WHERE id = ?`).bind(body.language, session.userId).run();
  return Response.json({ language: body.language });
}

// The options every timezone dropdown offers (the admin student/teacher pages
// and the self-service settings pages) — self-service input is held to this
// list rather than trusted as free text.
const TIMEZONE_LABELS = ['UTC+08:00 台北', 'UTC+09:00 大阪、札幌、東京', 'UTC+07:00 河內、胡志明市', 'UTC+06:30 仰光'];
// Bundled animal avatars under public/assets/avatars/, e.g. '001-bear.png'.
const BUNDLED_AVATAR_RE = /^\d{3}-[a-z0-9-]+\.png$/;

// Which fields a student/teacher may change on their own settings page. Name,
// email (the login identity), the Teams link, status, assigned courses and the
// receipt (wage/tax/bank) stay admin-managed. An uploaded photo goes through
// PUT /api/me/avatar instead; `avatar` here only picks a bundled animal.
const OWN_PROFILE_FIELDS: Record<string, readonly string[]> = {
  student: ['phone', 'timezone', 'avatar'],
  teacher: ['phone', 'timezone', 'avatar', 'specialty', 'motto'],
};
const OWN_PROFILE_MAX_LENGTH: Record<string, number> = { specialty: 100, motto: 200 };

async function handleOwnProfileUpdate(request: Request, env: Env, session: Session): Promise<Response> {
  const allowed = OWN_PROFILE_FIELDS[session.role];
  const body = await request.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ error: '資料格式錯誤' }, { status: 400 });
  }
  const keys = Object.keys(body);
  if (keys.length === 0) {
    return Response.json({ error: '沒有要更新的欄位' }, { status: 400 });
  }
  if (keys.some((key) => !allowed.includes(key))) {
    return Response.json({ error: '包含不能自行修改的欄位' }, { status: 400 });
  }
  if (keys.some((key) => typeof body[key] !== 'string')) {
    return Response.json({ error: '資料格式錯誤' }, { status: 400 });
  }
  const fields = body as Record<string, string>;
  const isTeacher = session.role === 'teacher';
  const table = ROLE_TABLES[session.role];

  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.phone !== undefined) {
    const phone = fields.phone.replace(/\D/g, '');
    // The admin pages require a student's phone, so a student can't blank it either.
    if (phone.length > 15 || (!isTeacher && !phone)) {
      return Response.json({ error: '手機號碼格式不對' }, { status: 400 });
    }
    sets.push('phone = ?');
    values.push(phone || null);
  }
  if (fields.timezone !== undefined) {
    if (!TIMEZONE_LABELS.includes(fields.timezone)) {
      return Response.json({ error: '不支援的時區' }, { status: 400 });
    }
    // A teacher's timezone lives inside the receipt blob (see teacher-basic.html);
    // json_set keeps the rest of the receipt (wage, bank…) untouched.
    if (isTeacher) {
      sets.push(`receipt_json = json_set(CASE WHEN json_valid(receipt_json) THEN receipt_json ELSE '{}' END, '$.timezone', ?)`);
    } else {
      sets.push('timezone = ?');
    }
    values.push(fields.timezone);
  }
  if (fields.avatar !== undefined && !BUNDLED_AVATAR_RE.test(fields.avatar)) {
    return Response.json({ error: '無效的頭像' }, { status: 400 });
  }
  for (const key of ['specialty', 'motto']) {
    if (fields[key] === undefined) continue;
    const value = fields[key].trim();
    if (value.length > OWN_PROFILE_MAX_LENGTH[key]) {
      return Response.json({ error: '內容太長' }, { status: 400 });
    }
    sets.push(`${key} = ?`);
    values.push(value || null);
  }

  let replacedPhoto: string | null = null;
  if (fields.avatar !== undefined) {
    const previous = await env.DB.prepare(`SELECT photo_path FROM ${table} WHERE id = ?`).bind(session.userId).first<{ photo_path: string | null }>();
    replacedPhoto = previous?.photo_path ?? null;
    sets.push('photo_path = ?');
    values.push(fields.avatar);
  }

  await env.DB.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).bind(...values, session.userId).run();
  // Switching from an uploaded photo back to an animal leaves nothing pointing at the old object.
  if (replacedPhoto !== fields.avatar) await deleteUploadedImage(env, replacedPhoto);

  return isTeacher ? handleTeacherSelf(env, session) : handleStudentSelf(env, session);
}

// 管理端頁面開始翻譯了，管理者也需要知道自己帳號存的語言——不像老師是整份
// 名單都能撈（GET /api/teachers 任何登入身分都能看），管理者名單本來就不公開
// 查詢，所以另外開一個窄的自查端點，只回傳自己這筆需要的欄位。
async function handleAdminSelf(env: Env, session: Session): Promise<Response> {
  const row = await env.DB.prepare(`SELECT language FROM admins WHERE id = ?`).bind(session.userId).first<{ language: string }>();
  if (!row) {
    return Response.json({ error: '找不到管理者' }, { status: 404 });
  }
  return Response.json({ language: row.language });
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// 驗證碼用密碼學等級的亂數（Math.random 可被預測）；拒絕取樣避免取餘數造成的分布偏差。
function generateCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 900000) * 900000;
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return String(100000 + (buf[0] % 900000));
}

// ==========================================================================
// Sessions — issued by handleOtpVerify, checked by getSession() on every
// protected page/API request via the `session` HttpOnly cookie. Replaces the
// old client-only sessionStorage flag, which the server never verified.
// ==========================================================================
interface Session {
  role: string;
  userId: number;
  email: string;
}

const SESSION_COOKIE = 'session';
const SESSION_DAYS = 7;

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// `Secure` only works over HTTPS — local `wrangler dev` serves plain HTTP,
// so it's dropped there (matched on the request's own scheme, not an env
// flag) and only applied for the real deployment.
function sessionCookieHeader(request: Request, token: string, maxAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookieHeader(request: Request): string {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}

async function getSession(request: Request, env: Env): Promise<Session | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT role, user_id, email FROM sessions WHERE token = ? AND expires_at > datetime('now', '+8 hours')`
  ).bind(token).first<{ role: string; user_id: number; email: string }>();
  if (!row) return null;
  return { role: row.role, userId: row.user_id, email: row.email };
}

async function handleSessionInfo(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return Response.json({ error: '未登入' }, { status: 401 });
  return Response.json(session);
}

// 帳號被停用時，已經登入的裝置也要立刻登出（停用的帳號也不能再取得驗證碼，見 handleOtpRequest）
async function revokeSessions(env: Env, role: string, userId: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE role = ? AND user_id = ?`).bind(role, userId).run();
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  }
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookieHeader(request) } });
}

// ==========================================================================
// 系統信件（登入驗證碼、預約成功／取消通知）——透過 Microsoft Graph 用 one-on-one@jptip.co.jp
// 寄出（需要 Azure 應用程式註冊有 Mail.Send 應用程式權限）。信件依收件人設定的語言寄出，
// 內容是管理端「系統信件」可修改的範本（見 src/email-templates.ts）。
// ==========================================================================
let cachedGraphToken: { token: string; expiresAt: number } | null = null;
let warnedMissingMailSecret = false;

async function getGraphToken(env: Env): Promise<string> {
  if (cachedGraphToken && cachedGraphToken.expiresAt - 60_000 > Date.now()) return cachedGraphToken.token;
  const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID ?? '',
      client_secret: env.MS_CLIENT_SECRET ?? '',
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
  const data = await res.json<{ access_token: string; expires_in: number }>();
  cachedGraphToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

// 系統信件範本：管理者改過的存在 D1 的 email_templates，沒改過的用 src/email-templates.ts 的預設範本
// 讀不到（例如部署時還沒套用 migrations/0023）就用預設範本，登入驗證碼信不會因此寄不出去
async function loadEmailTemplate(env: Env, key: EmailTemplateKey, lang: SupportedLanguage): Promise<{ subject: string; html: string }> {
  try {
    const row = await env.DB.prepare(`SELECT subject, html FROM email_templates WHERE template_key = ? AND language = ?`)
      .bind(key, lang).first<{ subject: string; html: string }>();
    if (row) return row;
  } catch (err) {
    console.error('[mail] failed to load email template, using the default', err);
  }
  return defaultEmailTemplate(key, lang);
}

interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
}

async function renderEmail(env: Env, key: EmailTemplateKey, lang: SupportedLanguage, to: string, vars: Record<string, string>): Promise<OutgoingEmail> {
  const template = await loadEmailTemplate(env, key, lang);
  return {
    to,
    subject: fillEmailTemplate(template.subject, vars, 'text'),
    html: fillEmailTemplate(template.html, vars, 'html'),
  };
}

const PRODUCTION_URL = 'https://lionbooking.lions2100.workers.dev';

function isLocalOrigin(origin: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
}

// 本機（localhost）寄出的信標題前面加上「[測試]」，在共用信箱的寄件備份裡跟正式寄出的信分得出來
function mailSubjectPrefix(origin: string): string {
  return isLocalOrigin(origin) ? '[測試] ' : '';
}

// 信件內容裡的連結／圖片一律指到正式網址：本機測試寄出的信如果還連回 localhost，
// 收件人的信箱根本連不到，圖片會破圖、連結也點不進去
function emailSiteUrl(origin: string): string {
  return isLocalOrigin(origin) ? PRODUCTION_URL : origin;
}

// 寄出一封信；寄不出去就丟出錯誤（錯誤訊息不含信件內容，驗證碼不會進 log）。
// 寄出的信會留在寄件信箱（共用信箱）的寄件備份，當作寄信紀錄：要查某個人有沒有收到信，
// 直接去共用信箱找。備份裡看得到驗證碼（5 分鐘內有效），共用信箱的存取權限只開給信任的人。
async function sendEmail(env: Env, origin: string, mail: OutgoingEmail): Promise<void> {
  const token = await getGraphToken(env);
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MS_SENDER_EMAIL ?? '')}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `${mailSubjectPrefix(origin)}${mail.subject}`,
        body: { contentType: 'HTML', content: mail.html },
        toRecipients: [{ emailAddress: { address: mail.to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) throw new Error(`sendMail failed: ${res.status} ${await res.text()}`);
}

// 這個身分底下用這個 Email 的帳號（管理者沒有停用這回事，一律當作啟用中）；name、language 用在驗證碼信件
async function findAccount(env: Env, role: string, email: string): Promise<{ id: number; name: string; language: string; status: string } | null> {
  const row = role === 'admin'
    ? await env.DB.prepare(`SELECT id, name, language, 'active' AS status FROM admins WHERE email = ?`).bind(email).first<{ id: number; name: string; language: string; status: string }>()
    : await env.DB.prepare(`SELECT id, name, language, status FROM ${ROLE_TABLES[role]} WHERE email = ?`).bind(email).first<{ id: number; name: string; language: string; status: string }>();
  return row ?? null;
}

// 帳號存在而且沒有被停用才回傳
async function findActiveAccount(env: Env, role: string, email: string): Promise<{ id: number; name: string; language: string } | null> {
  const account = await findAccount(env, role, email);
  return account && account.status !== 'inactive' ? account : null;
}

// 防暴力猜碼：每組驗證碼最多試 OTP_MAX_TRIES_PER_CODE 次；同一個帳號 1 小時內錯誤累計達
// OTP_MAX_FAILURES_PER_HOUR 次就暫停驗證（這時即使輸入正確也不接受）。嘗試次數是先用一個
// UPDATE 原子性地「佔用」一次再比對，所以同時送出大量請求也沒辦法多猜。
const OTP_MAX_TRIES_PER_CODE = 5;
const OTP_MAX_FAILURES_PER_HOUR = 10;

async function checkOtpCode(env: Env, email: string, role: string, code: string): Promise<'ok' | 'wrong' | 'locked'> {
  const failures = await env.DB.prepare(
    `SELECT COALESCE(SUM(attempts), 0) AS n FROM otp_codes
     WHERE email = ? AND role = ? AND created_at > datetime('now', '+8 hours', '-1 hour')`
  ).bind(email, role).first<{ n: number }>();
  if ((failures?.n ?? 0) >= OTP_MAX_FAILURES_PER_HOUR) return 'locked';

  const claimed = await env.DB.prepare(
    `UPDATE otp_codes SET attempts = attempts + 1
     WHERE id = (SELECT id FROM otp_codes WHERE email = ? AND role = ? AND used = 0
                   AND expires_at > datetime('now', '+8 hours') ORDER BY id DESC LIMIT 1)
       AND attempts < ?
     RETURNING id, code, attempts`
  ).bind(email, role, OTP_MAX_TRIES_PER_CODE).first<{ id: number; code: string; attempts: number }>();
  if (!claimed) return 'wrong';

  if (claimed.code !== code) {
    if (claimed.attempts >= OTP_MAX_TRIES_PER_CODE) {
      await env.DB.prepare(`UPDATE otp_codes SET used = 1 WHERE id = ?`).bind(claimed.id).run();
    }
    return 'wrong';
  }

  // 猜對：標成已使用（used = 0 的條件確保同一組碼只能成功一次），這次也不算錯誤次數。
  const used = await env.DB.prepare(
    `UPDATE otp_codes SET used = 1, attempts = attempts - 1, verified_at = datetime('now', '+8 hours') WHERE id = ? AND used = 0`
  ).bind(claimed.id).run();
  return used.meta.changes === 1 ? 'ok' : 'wrong';
}

// 同一個 Email（同一個身分）申請驗證碼：OTP_REQUEST_COOLDOWN_SECONDS 秒內不能重複申請（跟登入頁
// 「重新取得驗證碼」的倒數一致），1 小時內沒有登入成功的申請最多 OTP_MAX_REQUESTS_PER_HOUR 組。
// 登入成功的那組不算，所以正常使用不會被擋。
const OTP_REQUEST_COOLDOWN_SECONDS = 30;
const OTP_MAX_REQUESTS_PER_HOUR = 5;

async function checkOtpRequestRate(env: Env, email: string, role: string): Promise<Response | null> {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS unverified,
       CAST((julianday(datetime('now', '+8 hours')) - julianday(MAX(created_at))) * 86400 AS INTEGER) AS since_last
     FROM otp_codes
     WHERE email = ? AND role = ? AND verified_at IS NULL AND created_at > datetime('now', '+8 hours', '-1 hour')`
  ).bind(email, role).first<{ unverified: number; since_last: number | null }>();
  if (!row || row.unverified === 0) return null;
  if (row.since_last !== null && row.since_last < OTP_REQUEST_COOLDOWN_SECONDS) {
    const retryAfter = OTP_REQUEST_COOLDOWN_SECONDS - row.since_last;
    return Response.json({ error: `請於 ${retryAfter} 秒後再重新取得驗證碼`, retryAfter }, { status: 429, headers: { 'Retry-After': String(retryAfter) } });
  }
  if (row.unverified >= OTP_MAX_REQUESTS_PER_HOUR) {
    return Response.json({ error: '驗證碼申請次數過多，請稍後再試' }, { status: 429, headers: { 'Retry-After': '3600' } });
  }
  return null;
}

async function handleOtpRequest(request: Request, env: Env): Promise<Response> {
  const { email, role } = await request.json<{ email?: string; role?: string }>();

  if (!email || !isValidEmail(email)) {
    return Response.json({ error: '請輸入有效的 Email 格式' }, { status: 400 });
  }
  if (!role || !ROLE_TABLES[role]) {
    return Response.json({ error: '無效的角色' }, { status: 400 });
  }

  // 沒有這個帳號（打錯 Email，或選錯身分，例如老師點成學生）直接告訴使用者；停用中的帳號（例如
  // 管理者還沒啟用的新老師）另外提示。知道帳號存在也登不進去：驗證碼只寄到本人信箱，每組碼最多猜
  // OTP_MAX_TRIES_PER_CODE 次、1 小時內錯 OTP_MAX_FAILURES_PER_HOUR 次就暫停驗證。
  const account = await findAccount(env, role, email);
  if (!account) {
    return apiError(404, 'accountNotFound', '沒有這個帳號，請確認 Email 是否正確');
  }
  if (account.status === 'inactive') {
    return apiError(403, 'accountInactive', '這個帳號尚未啟用，請聯絡管理者');
  }

  // 申請頻率限制（防止有人一直按「取得驗證碼」塞爆別人的信箱）
  const limited = await checkOtpRequestRate(env, email, role);
  if (limited) return limited;

  const code = generateCode();

  // 新的驗證碼發出後，舊的一律作廢：同一時間只會有一組有效的碼，申請再多次也不會增加猜中的機會。
  await env.DB.prepare(`UPDATE otp_codes SET used = 1 WHERE email = ? AND role = ? AND used = 0`).bind(email, role).run();
  await env.DB.prepare(
    `INSERT INTO otp_codes (email, role, code, expires_at)
     VALUES (?, ?, ?, datetime('now', '+8 hours', '+5 minutes'))`
  ).bind(email, role, code).run();
  // 順便清掉一天以前的紀錄（頻率限制跟錯誤次數最多只看 1 小時內）
  await env.DB.prepare(`DELETE FROM otp_codes WHERE created_at < datetime('now', '+8 hours', '-1 day')`).run();

  if (!env.MS_CLIENT_SECRET) {
    // 本機開發／測試環境沒有設定寄信用的 secret：不寄信（本機用 ALLOW_ANY_OTP 任意驗證碼登入）。
    // 正式環境一定要有 MS_CLIENT_SECRET，否則沒有人收得到驗證碼。
    if (env.ALLOW_ANY_OTP !== 'true' && !warnedMissingMailSecret) {
      warnedMissingMailSecret = true;
      console.error('[otp] MS_CLIENT_SECRET is not set — verification emails cannot be sent');
    }
    return Response.json({ ok: true });
  }
  try {
    const lang = isSupportedLanguage(account.language) ? account.language : 'zh-Hant';
    const origin = new URL(request.url).origin;
    const mail = await renderEmail(env, `login_${role}` as EmailTemplateKey, lang, email, { name: account.name, code, siteUrl: emailSiteUrl(origin) });
    await sendEmail(env, origin, mail);
  } catch (err) {
    // 寄不出去的碼直接作廢；log 只記錯誤原因，不記驗證碼
    console.error('[otp] failed to send verification email', err);
    await env.DB.prepare(`UPDATE otp_codes SET used = 1 WHERE email = ? AND role = ? AND code = ?`).bind(email, role, code).run();
    return Response.json({ error: '驗證碼寄送失敗，請稍後再試' }, { status: 502 });
  }

  return Response.json({ ok: true });
}

async function handleOtpVerify(request: Request, env: Env): Promise<Response> {
  const { email, role, code } = await request.json<{ email?: string; role?: string; code?: string }>();

  if (!email || !role || !ROLE_TABLES[role] || !code) {
    return Response.json({ error: '缺少必要欄位' }, { status: 400 });
  }

  const devBypass = env.ALLOW_ANY_OTP === 'true' && /^\d{6}$/.test(code);

  if (!devBypass) {
    const result = await checkOtpCode(env, email, role, code);
    if (result === 'locked') {
      return Response.json({ error: '驗證碼錯誤次數過多，請稍後再試' }, { status: 429 });
    }
    if (result !== 'ok') {
      return Response.json({ error: '驗證碼錯誤或已過期' }, { status: 400 });
    }
  }

  // 驗證碼發出後帳號才被停用的話，這裡也要擋（回一樣的錯誤訊息，不透露帳號狀態）。
  const account = await findActiveAccount(env, role, email);
  if (!account) {
    return Response.json({ error: '驗證碼錯誤或已過期' }, { status: 400 });
  }

  const token = randomToken();
  const maxAgeSeconds = SESSION_DAYS * 24 * 60 * 60;
  await env.DB.prepare(
    `INSERT INTO sessions (token, role, user_id, email, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+8 hours', ?))`
  ).bind(token, role, account.id, email, `+${SESSION_DAYS} days`).run();

  return Response.json({ ok: true }, { headers: { 'Set-Cookie': sessionCookieHeader(request, token, maxAgeSeconds) } });
}

// All three have a `photo_path` column (migrations 0004 / 0007 / 0010).
const AVATAR_ROLE_TABLES: Record<string, string> = {
  student: 'students',
  teacher: 'teachers',
  course: 'courses',
};
const UPLOAD_ROLES = new Set(['teacher', 'student', 'course']);

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2MB is generous headroom for a 400x400 JPEG at q0.8
const UPLOAD_IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function handleAvatarUpload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const role = url.searchParams.get('role') || '';
  const id = Number(url.searchParams.get('id'));

  if (!UPLOAD_ROLES.has(role) || !Number.isInteger(id) || id <= 0) {
    return Response.json({ error: '缺少或無效的 role/id' }, { status: 400 });
  }

  return storeUploadedImage(request, env, role, id);
}

// A student/teacher replacing their own photo from their settings page — the
// role/id come from the session, never the query string.
async function handleOwnAvatarUpload(request: Request, env: Env, session: Session): Promise<Response> {
  return storeUploadedImage(request, env, session.role, session.userId);
}

// Uploaded R2 objects are served with a year-long immutable cache (see
// handleAvatarGet), so every upload gets a fresh key — re-using one key would
// leave browsers showing the previous photo. The replaced object is deleted.
async function storeUploadedImage(request: Request, env: Env, role: string, id: number): Promise<Response> {
  // 只收 JPEG／PNG／WebP：SVG 也是 image/*，但裡面可以藏 JavaScript，從本站網址直接打開就會執行。
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!UPLOAD_IMAGE_TYPES[contentType]) {
    return Response.json({ error: '圖片格式只接受 JPG、PNG、WebP' }, { status: 400 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_AVATAR_BYTES) {
    return Response.json({ error: '圖片檔案大小不正確' }, { status: 400 });
  }

  const ext = UPLOAD_IMAGE_TYPES[contentType];
  const version = Date.now();
  const key = role === 'course' ? `courses/course-${id}-${version}.${ext}` : `avatars/${role}-${id}-${version}.${ext}`;

  const table = AVATAR_ROLE_TABLES[role];
  const previous = await env.DB.prepare(`SELECT photo_path FROM ${table} WHERE id = ?`).bind(id).first<{ photo_path: string | null }>();

  await env.AVATARS.put(key, body, { httpMetadata: { contentType } });

  await env.DB.prepare(`UPDATE ${table} SET photo_path = ? WHERE id = ?`).bind(key, id).run();
  await deleteUploadedImage(env, previous?.photo_path);

  return Response.json({ path: key });
}

// Only R2 keys are deleted — a bundled animal avatar ('001-bear.png') or a
// legacy data: URL isn't an object in the bucket.
async function deleteUploadedImage(env: Env, path: string | null | undefined): Promise<void> {
  if (path && (path.startsWith('avatars/') || path.startsWith('courses/'))) {
    await env.AVATARS.delete(path);
  }
}

async function handleAvatarGet(request: Request, env: Env, key: string): Promise<Response> {
  const object = await env.AVATARS.get(key);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag);
  // 就算桶子裡有早期上傳的 SVG 之類的檔案，直接打開也不會執行任何腳本
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  return new Response(object.body, { headers });
}

// ==========================================================================
// Courses — the first real (non-mock) piece of the course/booking data
// model. DB columns are snake_case (matching the rest of the schema); the
// API translates to/from the frontend's existing camelCase field names.
// ==========================================================================
interface CourseRow {
  id: number;
  name: string;
  description: string;
  photo_path: string | null;
  status: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  schedule_increment: string;
  min_lead_hours: number;
  max_lead_days: number;
  default_sessions: number;
  reminder_hours_before: number;
}

function courseRowToJson(row: CourseRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    image: row.photo_path,
    status: row.status,
    durationMinutes: row.duration_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    scheduleIncrement: row.schedule_increment,
    minLeadHours: row.min_lead_hours,
    maxLeadDays: row.max_lead_days,
    defaultSessions: row.default_sessions,
    reminderHoursBefore: row.reminder_hours_before,
  };
}

async function handleCoursesList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT * FROM courses ORDER BY id`).all<CourseRow>();
  return Response.json(results.map(courseRowToJson));
}

interface CourseBody {
  name?: string;
  description?: string;
  image?: string;
  status?: string;
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  scheduleIncrement?: string;
  minLeadHours?: number;
  maxLeadDays?: number;
  defaultSessions?: number;
  reminderHoursBefore?: number;
}

// 堂數（課程的預設堂數、學生每筆已購買課程的總堂數）共用的檢查
const MAX_SESSIONS = 999;
function isValidSessionCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_SESSIONS;
}

async function handleCourseCreate(request: Request, env: Env): Promise<Response> {
  const body = await request.json<CourseBody>();
  const name = body.name?.trim();
  if (!name) {
    return Response.json({ error: '請填寫課程名稱' }, { status: 400 });
  }

  const row = await env.DB.prepare(
    `INSERT INTO courses (name, description, photo_path, status) VALUES (?, ?, ?, ?) RETURNING *`
  ).bind(
    name,
    body.description?.trim() || '',
    body.image || null,
    body.status === 'inactive' ? 'inactive' : 'active'
  ).first<CourseRow>();

  return Response.json(courseRowToJson(row!), { status: 201 });
}

// Partial update: course-detail.html saves "basic info" and "booking rules"
// as two separate forms/buttons, so only the fields present in the body are
// touched — matching how the old localStorage version mutated one course
// object in place from either handler.
const COURSE_FIELD_COLUMNS: Record<keyof CourseBody, string> = {
  name: 'name',
  description: 'description',
  image: 'photo_path',
  status: 'status',
  durationMinutes: 'duration_minutes',
  bufferBeforeMinutes: 'buffer_before_minutes',
  bufferAfterMinutes: 'buffer_after_minutes',
  scheduleIncrement: 'schedule_increment',
  minLeadHours: 'min_lead_hours',
  maxLeadDays: 'max_lead_days',
  defaultSessions: 'default_sessions',
  reminderHoursBefore: 'reminder_hours_before',
};

async function handleCourseUpdate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: '缺少或無效的 id' }, { status: 400 });
  }

  const body = await request.json<CourseBody>();
  if (body.defaultSessions !== undefined && !isValidSessionCount(body.defaultSessions)) {
    return Response.json({ error: `預設堂數需為 1 到 ${MAX_SESSIONS} 的整數` }, { status: 400 });
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(COURSE_FIELD_COLUMNS) as (keyof CourseBody)[]) {
    if (body[key] === undefined) continue;
    sets.push(`${COURSE_FIELD_COLUMNS[key]} = ?`);
    values.push(key === 'name' ? String(body[key]).trim() : body[key]);
  }
  if (sets.length === 0) {
    return Response.json({ error: '沒有要更新的欄位' }, { status: 400 });
  }

  const row = await env.DB.prepare(
    `UPDATE courses SET ${sets.join(', ')} WHERE id = ? RETURNING *`
  ).bind(...values, id).first<CourseRow>();
  if (!row) {
    return Response.json({ error: '找不到課程' }, { status: 404 });
  }

  return Response.json(courseRowToJson(row));
}

// ==========================================================================
// Teachers — profile CRUD, course assignment, weekly hours, and leave days.
// ==========================================================================
interface TeacherRow {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  photo_path: string | null;
  specialty: string | null;
  motto: string | null;
  status: string;
  receipt_json: string | null;
  language: string;
}

async function teacherCourseNames(env: Env, teacherId: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.name FROM teacher_courses tc JOIN courses c ON c.id = tc.course_id WHERE tc.teacher_id = ? ORDER BY c.id`
  ).bind(teacherId).all<{ name: string }>();
  return results.map((r) => r.name);
}

async function teacherRowToJson(env: Env, row: TeacherRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    avatar: row.photo_path,
    specialty: row.specialty,
    motto: row.motto,
    status: row.status,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
    courses: await teacherCourseNames(env, row.id),
    language: row.language,
  };
}

// What a student (booking wizard) or teacher may see about *other* teachers:
// only what the teacher-picker card shows. Contact info and the receipt blob
// (wage, tax rate, bank account, home address) stay admin-only — a teacher
// reads their own full record through /api/teachers/me instead.
async function teacherRowToPublicJson(env: Env, row: TeacherRow) {
  return {
    id: row.id,
    name: row.name,
    avatar: row.photo_path,
    specialty: row.specialty,
    motto: row.motto,
    status: row.status,
    courses: await teacherCourseNames(env, row.id),
  };
}

async function handleTeachersList(env: Env, session: Session): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT * FROM teachers ORDER BY id`).all<TeacherRow>();
  const toJson = session.role === 'admin' ? teacherRowToJson : teacherRowToPublicJson;
  return Response.json(await Promise.all(results.map((row) => toJson(env, row))));
}

async function handleTeacherSelf(env: Env, session: Session): Promise<Response> {
  const row = await env.DB.prepare(`SELECT * FROM teachers WHERE id = ?`).bind(session.userId).first<TeacherRow>();
  if (!row) {
    return Response.json({ error: '找不到老師' }, { status: 404 });
  }
  return Response.json(await teacherRowToJson(env, row));
}

interface TeacherBody {
  name?: string;
  email?: string;
  phone?: string;
  avatar?: string;
  specialty?: string;
  motto?: string;
  status?: string;
  receipt?: unknown;
}

async function handleTeacherCreate(request: Request, env: Env): Promise<Response> {
  const body = await request.json<TeacherBody>();
  const name = body.name?.trim();
  const email = body.email?.trim();
  if (!name || !email || !isValidEmail(email)) {
    return Response.json({ error: '請填寫姓名與有效的 Email' }, { status: 400 });
  }
  if (await env.DB.prepare(`SELECT id FROM teachers WHERE email = ?`).bind(email).first()) {
    return apiError(400, 'emailTaken', 'Email 已被使用');
  }

  const row = await env.DB.prepare(
    `INSERT INTO teachers (name, email, phone, photo_path, specialty, motto, status, receipt_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    name, email,
    body.phone?.trim() || null,
    body.avatar || null,
    body.specialty?.trim() || '',
    body.motto?.trim() || '',
    body.status === 'active' ? 'active' : 'inactive',
    body.receipt ? JSON.stringify(body.receipt) : null
  ).first<TeacherRow>();

  return Response.json(await teacherRowToJson(env, row!), { status: 201 });
}

const TEACHER_FIELD_COLUMNS: Record<keyof Omit<TeacherBody, 'receipt'>, string> = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  avatar: 'photo_path',
  specialty: 'specialty',
  motto: 'motto',
  status: 'status',
};

async function handleTeacherUpdate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: '缺少或無效的 id' }, { status: 400 });
  }

  const body = await request.json<TeacherBody>();
  if (body.email !== undefined && await env.DB.prepare(`SELECT id FROM teachers WHERE email = ? AND id != ?`).bind(String(body.email).trim(), id).first()) {
    return apiError(400, 'emailTaken', 'Email 已被使用');
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(TEACHER_FIELD_COLUMNS) as (keyof typeof TEACHER_FIELD_COLUMNS)[]) {
    if (body[key] === undefined) continue;
    sets.push(`${TEACHER_FIELD_COLUMNS[key]} = ?`);
    values.push(key === 'name' || key === 'email' ? String(body[key]).trim() : body[key]);
  }
  if (body.receipt !== undefined) {
    sets.push('receipt_json = ?');
    values.push(JSON.stringify(body.receipt));
  }
  if (sets.length === 0) {
    return Response.json({ error: '沒有要更新的欄位' }, { status: 400 });
  }

  const row = await env.DB.prepare(
    `UPDATE teachers SET ${sets.join(', ')} WHERE id = ? RETURNING *`
  ).bind(...values, id).first<TeacherRow>();
  if (!row) {
    return Response.json({ error: '找不到老師' }, { status: 404 });
  }
  if (row.status === 'inactive') await revokeSessions(env, 'teacher', row.id);
  return Response.json(await teacherRowToJson(env, row));
}

async function handleTeacherCoursesUpdate(request: Request, env: Env, teacherId: number): Promise<Response> {
  const { courseName, action } = await request.json<{ courseName?: string; action?: string }>();
  if (!courseName || (action !== 'add' && action !== 'remove')) {
    return Response.json({ error: '缺少或無效的欄位' }, { status: 400 });
  }

  const course = await env.DB.prepare(`SELECT id FROM courses WHERE name = ?`).bind(courseName).first<{ id: number }>();
  if (!course) {
    return Response.json({ error: '找不到課程' }, { status: 404 });
  }

  if (action === 'add') {
    await env.DB.prepare(`INSERT OR IGNORE INTO teacher_courses (teacher_id, course_id) VALUES (?, ?)`).bind(teacherId, course.id).run();
  } else {
    await env.DB.prepare(`DELETE FROM teacher_courses WHERE teacher_id = ? AND course_id = ?`).bind(teacherId, course.id).run();
  }
  return Response.json({ courses: await teacherCourseNames(env, teacherId) });
}

// /admin/teacher-hours?id=1 etc. — see the alias handling at the end of fetch().
const ADMIN_TEACHER_PAGE_ALIASES: Record<string, string> = {
  '/admin/teacher-hours': '/teacher/hours',
  '/admin/teacher-lessons': '/teacher/lessons',
  '/admin/teacher-leave': '/teacher/leave',
};

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

async function handleTeacherHoursList(env: Env, teacherId: number): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, day_of_week, start_time, end_time FROM teacher_hours WHERE teacher_id = ? ORDER BY day_of_week, start_time`
  ).bind(teacherId).all<{ id: number; day_of_week: number; start_time: string; end_time: string }>();
  return Response.json(results.map((r) => ({ id: r.id, day: WEEKDAY_NAMES[r.day_of_week], start: r.start_time, end: r.end_time })));
}

async function handleTeacherHoursCreate(request: Request, env: Env, teacherId: number): Promise<Response> {
  const { day, start, end } = await request.json<{ day?: string; start?: string; end?: string }>();
  const dayOfWeek = WEEKDAY_NAMES.indexOf(day || '');
  if (dayOfWeek === -1 || !start || !end || start >= end) {
    return Response.json({ error: '缺少或無效的欄位' }, { status: 400 });
  }

  const row = await env.DB.prepare(
    `INSERT INTO teacher_hours (teacher_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?) RETURNING id`
  ).bind(teacherId, dayOfWeek, start, end).first<{ id: number }>();

  return Response.json({ id: row!.id, day, start, end }, { status: 201 });
}

async function handleTeacherHoursDelete(env: Env, teacherId: number, hourId: number): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM teacher_hours WHERE id = ? AND teacher_id = ?`).bind(hourId, teacherId).run();
  if (!res.meta.changes) {
    return Response.json({ error: '找不到時段' }, { status: 404 });
  }
  return Response.json({ ok: true });
}

async function handleTeacherLeaveList(env: Env, teacherId: number): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, date FROM teacher_leave WHERE teacher_id = ? ORDER BY date`
  ).bind(teacherId).all<{ id: number; date: string }>();
  return Response.json(results);
}

// 老師／學生的時區欄位（例：'UTC+06:30 仰光'；舊資料可能是 '(UTC+6:30) 仰光'）解析成相對 UTC 的分鐘數——跟前端 script.js
// 的 parseUtcOffset() 同一套規則；沒設定時區就是 UTC+8（資料庫時間基準）。
function parseUtcOffsetMinutes(label: string | null | undefined): number {
  const m = /UTC([+-])(\d+)(?::(\d+))?/.exec(label || '');
  if (!m) return 8 * 60;
  const minutes = Number(m[2]) * 60 + (m[3] ? Number(m[3]) : 0);
  return m[1] === '-' ? -minutes : minutes;
}

// 某個時區「今天」的日期（YYYY-MM-DD）
function todayIsoAtOffset(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

async function handleTeacherLeaveCreate(request: Request, env: Env, teacherId: number): Promise<Response> {
  const { date } = await request.json<{ date?: string }>();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: '缺少或無效的日期' }, { status: 400 });
  }

  // 休假只能請今天（含）以後——「今天」用老師自己時區的日期判斷，跟老師在休假申請頁日曆上
  // 看到的一致（管理者代管時也一樣以老師的時區為準，因為是這位老師的休假日）。
  const teacher = await env.DB.prepare(`SELECT receipt_json FROM teachers WHERE id = ?`).bind(teacherId).first<{ receipt_json: string | null }>();
  if (!teacher) {
    return Response.json({ error: '找不到老師' }, { status: 404 });
  }
  const receipt = teacher.receipt_json ? (JSON.parse(teacher.receipt_json) as { timezone?: string }) : null;
  if (date < todayIsoAtOffset(parseUtcOffsetMinutes(receipt && receipt.timezone))) {
    return apiError(400, 'leaveInPast', '只能申請今天以後的休假');
  }

  // 這天已經有學生預約（還沒上、也沒取消的課）就不能請假：不然預約還在，學生照常來上課老師卻不在。
  // 老師要自己聯絡管理者處理那幾堂課（管理者取消時學生會收到取消通知、堂數退還），這天沒有預約了才能請假。
  const booked = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bookings WHERE teacher_id = ? AND date = ? AND status IN ('upcoming', 'pending')`
  ).bind(teacherId, date).first<{ n: number }>();
  if (booked && booked.n > 0) {
    return apiError(409, 'leaveHasBookings', `這天已經有 ${booked.n} 堂預約，請先聯絡管理者處理這些預約`, { count: booked.n });
  }

  const row = await env.DB.prepare(
    `INSERT INTO teacher_leave (teacher_id, date) VALUES (?, ?) ON CONFLICT (teacher_id, date) DO UPDATE SET date = excluded.date RETURNING id`
  ).bind(teacherId, date).first<{ id: number }>();

  return Response.json({ id: row!.id, date }, { status: 201 });
}

async function handleTeacherLeaveDelete(env: Env, teacherId: number, leaveId: number): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM teacher_leave WHERE id = ? AND teacher_id = ?`).bind(leaveId, teacherId).run();
  if (!res.meta.changes) {
    return Response.json({ error: '找不到請假紀錄' }, { status: 404 });
  }
  return Response.json({ ok: true });
}

// ==========================================================================
// Students — profile CRUD and course-enrollment ("my courses") CRUD.
// ==========================================================================
interface StudentRow {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  photo_path: string | null;
  status: string;
  timezone: string | null;
  teams_link: string | null;
  language: string;
}

function studentRowToJson(row: StudentRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    avatar: row.photo_path,
    status: row.status,
    timezone: row.timezone,
    teamsLink: row.teams_link,
    language: row.language,
  };
}

// A student's own profile (name/timezone/etc) — unlike /api/teachers,
// /api/students is admin-only since a student roster is private, so
// student-facing pages (e.g. booking-history.html's timezone display) need
// their own narrow self-lookup instead.
async function handleStudentSelf(env: Env, session: Session): Promise<Response> {
  const row = await env.DB.prepare(`SELECT * FROM students WHERE id = ?`).bind(session.userId).first<StudentRow>();
  if (!row) {
    return Response.json({ error: '找不到學生' }, { status: 404 });
  }
  return Response.json(studentRowToJson(row));
}

async function handleStudentsList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT * FROM students ORDER BY id`).all<StudentRow>();
  return Response.json(results.map(studentRowToJson));
}

interface StudentBody {
  name?: string;
  email?: string;
  phone?: string;
  avatar?: string;
  status?: string;
  timezone?: string;
  teamsLink?: string;
}

async function handleStudentCreate(request: Request, env: Env): Promise<Response> {
  const body = await request.json<StudentBody>();
  const name = body.name?.trim();
  const email = body.email?.trim();
  if (!name || !email || !isValidEmail(email)) {
    return Response.json({ error: '請填寫姓名與有效的 Email' }, { status: 400 });
  }
  if (await env.DB.prepare(`SELECT id FROM students WHERE email = ?`).bind(email).first()) {
    return apiError(400, 'emailTaken', 'Email 已被使用');
  }

  const row = await env.DB.prepare(
    `INSERT INTO students (name, email, phone, photo_path, status, timezone, teams_link)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    name, email,
    body.phone?.trim() || null,
    body.avatar || null,
    body.status === 'inactive' ? 'inactive' : 'active',
    body.timezone || null,
    body.teamsLink?.trim() || null
  ).first<StudentRow>();

  return Response.json(studentRowToJson(row!), { status: 201 });
}

const STUDENT_FIELD_COLUMNS: Record<keyof StudentBody, string> = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  avatar: 'photo_path',
  status: 'status',
  timezone: 'timezone',
  teamsLink: 'teams_link',
};

async function handleStudentUpdate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: '缺少或無效的 id' }, { status: 400 });
  }

  const body = await request.json<StudentBody>();
  if (body.email !== undefined && await env.DB.prepare(`SELECT id FROM students WHERE email = ? AND id != ?`).bind(String(body.email).trim(), id).first()) {
    return apiError(400, 'emailTaken', 'Email 已被使用');
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(STUDENT_FIELD_COLUMNS) as (keyof StudentBody)[]) {
    if (body[key] === undefined) continue;
    sets.push(`${STUDENT_FIELD_COLUMNS[key]} = ?`);
    values.push(key === 'name' || key === 'email' || key === 'teamsLink' ? String(body[key]).trim() : body[key]);
  }
  if (sets.length === 0) {
    return Response.json({ error: '沒有要更新的欄位' }, { status: 400 });
  }

  const row = await env.DB.prepare(
    `UPDATE students SET ${sets.join(', ')} WHERE id = ? RETURNING *`
  ).bind(...values, id).first<StudentRow>();
  if (!row) {
    return Response.json({ error: '找不到學生' }, { status: 404 });
  }
  if (row.status === 'inactive') await revokeSessions(env, 'student', row.id);
  return Response.json(studentRowToJson(row));
}

interface StudentCourseRow {
  id: number;
  student_id: number;
  course_id: number;
  status: string;
  attended_count: number;
  booked_count: number;
  total_sessions: number;
  course_name: string;
}

function studentCourseRowToJson(row: StudentCourseRow) {
  return {
    id: row.id,
    courseId: row.course_id,
    name: row.course_name,
    status: row.status,
    attended: `${row.attended_count}/${row.total_sessions}`,
    booked: `${row.booked_count}/${row.total_sessions}`,
  };
}

async function handleStudentCoursesList(env: Env, studentId: number): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT sc.*, c.name AS course_name FROM student_courses sc JOIN courses c ON c.id = sc.course_id
     WHERE sc.student_id = ? ORDER BY sc.id`
  ).bind(studentId).all<StudentCourseRow>();
  return Response.json(results.map(studentCourseRowToJson));
}

async function handleStudentCourseCreate(request: Request, env: Env, studentId: number): Promise<Response> {
  const { courseName, totalSessions, attendedCount } = await request.json<{ courseName?: string; totalSessions?: number | null; attendedCount?: number | null }>();
  if (!courseName) {
    return Response.json({ error: '缺少課程名稱' }, { status: 400 });
  }
  if (totalSessions != null && !isValidSessionCount(totalSessions)) {
    return Response.json({ error: `堂數需為 1 到 ${MAX_SESSIONS} 的整數` }, { status: 400 });
  }
  const course = await env.DB.prepare(`SELECT id, name, default_sessions FROM courses WHERE name = ?`).bind(courseName).first<{ id: number; name: string; default_sessions: number }>();
  if (!course) {
    return Response.json({ error: '找不到課程' }, { status: 404 });
  }
  const resolvedTotal = totalSessions ?? course.default_sessions;

  // 已上課堂數：從別的系統（例如 M365 Bookings）轉過來的學生，新增課程時可以直接帶入已經上過
  // 的堂數，不用從 0 堂開始算；等於總堂數就直接是已完成的課程（例如補登記一門轉過來前就已經
  // 上完的舊課程）。沒有填就是全新的學生，從 0 堂開始，跟原本的行為一樣。
  if (attendedCount != null && (!Number.isInteger(attendedCount) || attendedCount < 0 || attendedCount > resolvedTotal)) {
    return Response.json({ error: `已上課堂數需為 0 到 ${resolvedTotal} 的整數` }, { status: 400 });
  }
  const startCount = attendedCount ?? 0;

  // 同一個學生的同一門課只會有一筆：加購、補課、堂數打錯都用 PATCH 改總堂數。有兩筆的話，
  // 預約時不知道該扣哪一筆，畫面上也只看得到其中一筆的堂數。已上課堂數沒有對應到真的預約紀錄
  // （這套系統裡沒有這幾堂課的 bookings），所以已預約堂數也一併算進去，不然堂數配額會對不起來。
  const row = await env.DB.prepare(
    `INSERT INTO student_courses (student_id, course_id, total_sessions, attended_count, booked_count, status)
     SELECT ?, ?, ?, ?, ?, CASE WHEN ? >= ? THEN 'completed' ELSE 'ongoing' END
     WHERE NOT EXISTS (SELECT 1 FROM student_courses WHERE student_id = ? AND course_id = ?)
     RETURNING *`
  ).bind(studentId, course.id, resolvedTotal, startCount, startCount, startCount, resolvedTotal, studentId, course.id).first<Omit<StudentCourseRow, 'course_name'>>();
  if (!row) {
    return apiError(409, 'courseAlreadyOwned', '這位學生已經有這門課程，請直接修改總堂數');
  }

  return Response.json(studentCourseRowToJson({ ...row, course_name: course.name }), { status: 201 });
}

// 管理者修改已購買課程的總堂數（加購、補課、當初打錯）。不能少於已預約的堂數（booked_count
// 包含已上課、缺席與還沒上的預約），改完重算 status：已上課達到總堂數是 completed，否則變回
// ongoing，所以已完成的課程加購後學生就能繼續預約。
async function handleStudentCourseUpdate(request: Request, env: Env, studentId: number, studentCourseId: number): Promise<Response> {
  const { totalSessions } = await request.json<{ totalSessions?: unknown }>();
  if (!isValidSessionCount(totalSessions)) {
    return Response.json({ error: `堂數需為 1 到 ${MAX_SESSIONS} 的整數` }, { status: 400 });
  }
  // booked_count <= ? 放在同一個 UPDATE：修改的同時學生剛好又預約一堂，也不會改到比已預約還少
  const row = await env.DB.prepare(
    `UPDATE student_courses
     SET total_sessions = ?1,
         status = CASE WHEN attended_count >= ?1 THEN 'completed' ELSE 'ongoing' END
     WHERE id = ?2 AND student_id = ?3 AND booked_count <= ?1
     RETURNING *`
  ).bind(totalSessions, studentCourseId, studentId).first<Omit<StudentCourseRow, 'course_name'>>();
  if (!row) {
    const existing = await env.DB.prepare(
      `SELECT booked_count FROM student_courses WHERE id = ? AND student_id = ?`
    ).bind(studentCourseId, studentId).first<{ booked_count: number }>();
    if (!existing) return Response.json({ error: '找不到課程' }, { status: 404 });
    return apiError(400, 'sessionsBelowBooked', `總堂數不能少於已預約的 ${existing.booked_count} 堂`, { booked: existing.booked_count });
  }
  const course = await env.DB.prepare(`SELECT name FROM courses WHERE id = ?`).bind(row.course_id).first<{ name: string }>();
  return Response.json(studentCourseRowToJson({ ...row, course_name: course?.name ?? '' }));
}

// 補償一堂：課堂不是學生的問題而中斷（老師方停電、臨時身體不適等）時，管理者幫這門課的
// 總堂數 +1，並且一定要填原因存進 student_course_adjustments，之後才查得到當初為什麼多一堂。
async function handleStudentCourseCompensate(request: Request, env: Env, session: Session, studentId: number, studentCourseId: number): Promise<Response> {
  const { reason } = await request.json<{ reason?: string }>();
  const trimmedReason = (reason ?? '').trim();
  if (!trimmedReason) {
    return apiError(400, 'reasonRequired', '請填寫補償原因');
  }
  const row = await env.DB.prepare(
    `UPDATE student_courses
     SET total_sessions = total_sessions + 1,
         status = CASE WHEN attended_count >= total_sessions + 1 THEN 'completed' ELSE 'ongoing' END
     WHERE id = ?1 AND student_id = ?2
     RETURNING *`
  ).bind(studentCourseId, studentId).first<Omit<StudentCourseRow, 'course_name'>>();
  if (!row) {
    return Response.json({ error: '找不到課程' }, { status: 404 });
  }
  await env.DB.prepare(
    `INSERT INTO student_course_adjustments (student_course_id, sessions_delta, reason, created_by) VALUES (?, 1, ?, ?)`
  ).bind(studentCourseId, trimmedReason, session.email).run();
  const course = await env.DB.prepare(`SELECT name FROM courses WHERE id = ?`).bind(row.course_id).first<{ name: string }>();
  return Response.json(studentCourseRowToJson({ ...row, course_name: course?.name ?? '' }));
}

interface StudentCourseAdjustmentRow {
  id: number;
  student_course_id: number;
  sessions_delta: number;
  reason: string;
  created_by: string;
  created_at: string;
}

async function handleStudentCourseAdjustmentsList(env: Env, studentId: number, studentCourseId: number): Promise<Response> {
  const owner = await env.DB.prepare(`SELECT id FROM student_courses WHERE id = ? AND student_id = ?`).bind(studentCourseId, studentId).first();
  if (!owner) return Response.json({ error: '找不到課程' }, { status: 404 });
  const { results } = await env.DB.prepare(
    `SELECT * FROM student_course_adjustments WHERE student_course_id = ? ORDER BY id DESC`
  ).bind(studentCourseId).all<StudentCourseAdjustmentRow>();
  return Response.json(results);
}

async function handleStudentCourseDelete(env: Env, studentId: number, studentCourseId: number): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT booked_count, attended_count FROM student_courses WHERE id = ? AND student_id = ?`
  ).bind(studentCourseId, studentId).first<{ booked_count: number; attended_count: number }>();
  if (!row) {
    return Response.json({ error: '找不到課程' }, { status: 404 });
  }
  if (row.booked_count > 0 || row.attended_count > 0) {
    return apiError(400, 'courseHasRecords', '已有預約或上課紀錄，無法刪除');
  }
  await env.DB.prepare(`DELETE FROM student_courses WHERE id = ?`).bind(studentCourseId).run();
  return Response.json({ ok: true });
}

// ==========================================================================
// Bookings — creation (student wizard), listing (student history / teacher
// slot computation), and status changes (student self-cancel, teacher marks
// attended, admin manages any booking on anyone's behalf).
// ==========================================================================
interface BookingRow {
  id: number;
  booking_code: string;
  student_id: number;
  student_course_id: number;
  course_id: number;
  teacher_id: number;
  date: string;
  time: string;
  status: string;
  rating: number | null;
  student_comment: string | null;
  teacher_rating: number | null;
  teacher_note: string | null;
  student_name: string;
  student_teams_link: string | null;
  teacher_name: string;
  course_name: string;
}

// viewerRole is required (not optional) so every call site has to decide it
// explicitly — feedback redaction lives in this one place instead of being
// repeated (and potentially forgotten) at each call site:
//   - rating / studentComment (student's feedback): hidden from teachers
//   - teacherRating / teacherNote (teacher's feedback): hidden from students
// Admins see both.
function bookingRowToJson(row: BookingRow, viewerRole: string) {
  return {
    id: row.id,
    bookingCode: row.booking_code,
    studentId: row.student_id,
    studentName: row.student_name,
    studentTeamsLink: row.student_teams_link,
    courseId: row.course_id,
    course: row.course_name,
    teacherId: row.teacher_id,
    teacher: row.teacher_name,
    date: row.date,
    time: row.time,
    status: row.status,
    rating: viewerRole === 'teacher' ? undefined : row.rating,
    studentComment: viewerRole === 'teacher' ? undefined : row.student_comment,
    teacherRating: viewerRole === 'student' ? undefined : row.teacher_rating,
    teacherNote: viewerRole === 'student' ? undefined : row.teacher_note,
  };
}

const BOOKING_SELECT = `SELECT b.*, s.name AS student_name, s.teams_link AS student_teams_link, t.name AS teacher_name, c.name AS course_name
  FROM bookings b
  JOIN students s ON s.id = b.student_id
  JOIN teachers t ON t.id = b.teacher_id
  JOIN courses c ON c.id = b.course_id`;

async function handleBookingsList(request: Request, env: Env, session: Session): Promise<Response> {
  const url = new URL(request.url);
  const qsStudentId = url.searchParams.get('studentId');
  const qsTeacherId = url.searchParams.get('teacherId');
  const qsDate = url.searchParams.get('date');

  let studentId: number | null = null;
  let teacherId: number | null = null;
  // The booking wizard needs to see a target teacher's occupied slots to
  // compute availability — that's not "their own" bookings, so it's scoped
  // down to schedule info only (see redactStudentIdentity below), not full
  // booking rows with another student's name on them.
  let redactStudentIdentity = false;

  if (session.role === 'student') {
    if (qsTeacherId) {
      teacherId = Number(qsTeacherId);
      redactStudentIdentity = true;
    } else {
      studentId = session.userId;
    }
  } else if (session.role === 'teacher') {
    teacherId = session.userId;
  } else {
    // Admin can filter by either (or neither, for a full list).
    if (qsStudentId) studentId = Number(qsStudentId);
    if (qsTeacherId) teacherId = Number(qsTeacherId);
  }

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (studentId !== null) { conditions.push('b.student_id = ?'); values.push(studentId); }
  if (teacherId !== null) { conditions.push('b.teacher_id = ?'); values.push(teacherId); }
  if (qsDate) { conditions.push('b.date = ?'); values.push(qsDate); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { results } = await env.DB.prepare(
    `${BOOKING_SELECT} ${where} ORDER BY b.date, b.time`
  ).bind(...values).all<BookingRow>();

  const json = results.map((row) => bookingRowToJson(row, session.role));
  if (redactStudentIdentity) {
    for (const b of json) {
      (b as { studentId?: number }).studentId = undefined;
      (b as { studentName?: string }).studentName = undefined;
      (b as { studentTeamsLink?: string }).studentTeamsLink = undefined;
      // Another student's feedback on their own lesson isn't schedule info either.
      (b as { rating?: number | null }).rating = undefined;
      (b as { studentComment?: string | null }).studentComment = undefined;
    }
  }
  return Response.json(json);
}

function formatUtcOffset(offsetMinutes: number): string {
  const abs = Math.abs(offsetMinutes);
  return `UTC${offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// 資料庫的上課時間（UTC+8）換算成收件人時區的 'YYYY/MM/DD'、'HH:MM'
function shiftUtc8DateTime(date: string, time: string, offsetMinutes: number): { date: string; time: string } {
  const shifted = new Date(Date.parse(`${date}T${time}:00+08:00`) + offsetMinutes * 60_000).toISOString();
  return { date: shifted.slice(0, 10).replace(/-/g, '/'), time: shifted.slice(11, 16) };
}

// 預約成功／取消／上課提醒時寄給學生和老師的通知信。上課時間換算成收件人自己設定的時區（學生是
// students.timezone，老師是領收書資料裡的時區），信件語言也依收件人的設定。
async function bookingNotificationEmails(env: Env, origin: string, bookingId: number, event: 'created' | 'cancelled' | 'reminder'): Promise<OutgoingEmail[]> {
  const row = await env.DB.prepare(
    `SELECT b.booking_code, b.date, b.time, c.name AS course_name, c.duration_minutes,
            s.name AS student_name, s.email AS student_email, s.language AS student_language, s.timezone AS student_timezone,
            t.name AS teacher_name, t.email AS teacher_email, t.language AS teacher_language,
            CASE WHEN json_valid(t.receipt_json) THEN json_extract(t.receipt_json, '$.timezone') END AS teacher_timezone,
            sc.booked_count, sc.attended_count, sc.total_sessions
     FROM bookings b
     JOIN students s ON s.id = b.student_id
     JOIN teachers t ON t.id = b.teacher_id
     JOIN courses c ON c.id = b.course_id
     JOIN student_courses sc ON sc.id = b.student_course_id
     WHERE b.id = ?`
  ).bind(bookingId).first<{
    booking_code: string; date: string; time: string; course_name: string; duration_minutes: number;
    student_name: string; student_email: string; student_language: string; student_timezone: string | null;
    teacher_name: string; teacher_email: string; teacher_language: string; teacher_timezone: string | null;
    booked_count: number; attended_count: number; total_sessions: number;
  }>();
  if (!row) return [];
  const recipients = [
    { role: 'student', email: row.student_email, language: row.student_language, timezone: row.student_timezone },
    { role: 'teacher', email: row.teacher_email, language: row.teacher_language, timezone: row.teacher_timezone },
  ] as const;
  return Promise.all(recipients.map((recipient) => {
    const offset = parseUtcOffsetMinutes(recipient.timezone);
    const local = shiftUtc8DateTime(row.date, row.time, offset);
    // 結束時間＝開始時間再往後移「時差＋課程長度」，等於先換到收件人時區、再加上這堂課的長度
    const localEnd = shiftUtc8DateTime(row.date, row.time, offset + row.duration_minutes);
    const lang = isSupportedLanguage(recipient.language) ? recipient.language : 'zh-Hant';
    return renderEmail(env, `booking_${event}_${recipient.role}`, lang, recipient.email, {
      studentName: row.student_name,
      teacherName: row.teacher_name,
      courseName: row.course_name,
      date: formatEmailDateLong(local.date, lang),
      time: local.time,
      endTime: localEnd.time,
      duration: formatEmailDuration(row.duration_minutes, lang),
      timezone: formatUtcOffset(offset),
      bookingCode: row.booking_code,
      // 課程進度只有「預約成功」的範本會用到（見 email-templates.ts 的 bookingEmail），
      // 這裡不分事件一律算好，取消信的範本沒有引用這幾個變數，傳了也不會顯示
      bookingNumber: String(row.booked_count),
      attendedCount: String(row.attended_count),
      totalSessions: String(row.total_sessions),
      siteUrl: emailSiteUrl(origin),
    });
  }));
}

// 信件內容在回應之前就從資料庫組好，真正寄出交給 waitUntil 在背景做，預約／取消不用等寄信。
// 寄信失敗只記 log，不影響預約本身。沒設定寄信用的 secret（本機、測試）就不寄。
async function notifyBooking(env: Env, ctx: ExecutionContext, request: Request, bookingId: number, event: 'created' | 'cancelled'): Promise<void> {
  if (!env.MS_CLIENT_SECRET) return;
  const origin = new URL(request.url).origin;
  try {
    const emails = await bookingNotificationEmails(env, origin, bookingId, event);
    ctx.waitUntil(Promise.all(emails.map((mail) => sendEmail(env, origin, mail).catch((err) => {
      console.error(`[mail] failed to send booking ${event} notification`, err);
    }))));
  } catch (err) {
    console.error(`[mail] failed to prepare booking ${event} notification`, err);
  }
}

// 上課前提醒信：由 wrangler.jsonc 設定的 Cron Trigger 定期呼叫（見檔案最後的 scheduled），找出
// 還沒寄過提醒、現在距離上課時間已經進入該課程設定範圍內（courses.reminder_hours_before）的預約。
// 已經上課、被取消的預約不會被選到（status 不是 'upcoming'）；錯過提醒時間點（例如排程曾經中斷）
// 也不會補寄，避免收到「已經上完課」的提醒信。排程沒有 HTTP request，內容一律當作正式環境寄出
// （連結指到 PRODUCTION_URL、標題不會加「[測試]」），跟本機開發環境無關。
export async function sendDueBookingReminders(env: Env): Promise<void> {
  if (!env.MS_CLIENT_SECRET) return;
  const { results } = await env.DB.prepare(
    `SELECT b.id AS booking_id, b.date, b.time, c.reminder_hours_before
     FROM bookings b JOIN courses c ON c.id = b.course_id
     WHERE b.status = 'upcoming' AND b.reminder_sent_at IS NULL`
  ).all<{ booking_id: number; date: string; time: string; reminder_hours_before: number }>();

  const due = results.filter((row) => {
    const hoursUntil = hoursUntilUtc8(row.date, row.time);
    return hoursUntil > 0 && hoursUntil <= row.reminder_hours_before;
  });

  for (const row of due) {
    try {
      const emails = await bookingNotificationEmails(env, PRODUCTION_URL, row.booking_id, 'reminder');
      await Promise.all(emails.map((mail) => sendEmail(env, PRODUCTION_URL, mail).catch((err) => {
        console.error('[mail] failed to send booking reminder', err);
      })));
    } catch (err) {
      console.error('[mail] failed to prepare booking reminder', err);
      continue;
    }
    await env.DB.prepare(`UPDATE bookings SET reminder_sent_at = datetime('now', '+8 hours') WHERE id = ?`).bind(row.booking_id).run();
  }
}

async function generateBookingCode(env: Env, date: string, time: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE date = ? AND time = ?`).bind(date, time).first<{ n: number }>();
  const seq = String((row?.n ?? 0) + 1).padStart(2, '0');
  return `${date.replace(/-/g, '')}-${time.replace(':', '')}-${seq}`;
}

// 'HH:MM' 欄位換算成當天的第幾分鐘（SQL 運算式）
function sqlTimeMinutes(column: string): string {
  return `(CAST(substr(${column}, 1, 2) AS INTEGER) * 60 + CAST(substr(${column}, 4, 2) AS INTEGER))`;
}

// 上課日期時間一律以 UTC+8（台北時間）儲存，預約／取消的時限也都以 UTC+8 判斷，不受瀏覽器所在時區影響。
function hoursUntilUtc8(date: string, time: string): number {
  return (Date.parse(`${date}T${time}:00+08:00`) - Date.now()) / 3_600_000;
}
function utc8DateISO(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function handleBookingCreate(request: Request, env: Env, session: Session, ctx: ExecutionContext): Promise<Response> {
  if (session.role !== 'student') {
    return Response.json({ error: '未授權' }, { status: 401 });
  }
  const { courseId, teacherId, date, time } = await request.json<{ courseId?: number; teacherId?: number; date?: string; time?: string }>();
  if (!Number.isInteger(courseId) || !Number.isInteger(teacherId) || !date || !time) {
    return Response.json({ error: '缺少必要欄位' }, { status: 400 });
  }

  const studentCourse = await env.DB.prepare(
    `SELECT id, booked_count, total_sessions FROM student_courses WHERE student_id = ? AND course_id = ? AND status = 'ongoing'`
  ).bind(session.userId, courseId).first<{ id: number; booked_count: number; total_sessions: number }>();
  if (!studentCourse) {
    return apiError(400, 'notEnrolled', '尚未報名此課程');
  }
  if (studentCourse.booked_count >= studentCourse.total_sessions) {
    return apiError(400, 'noSessionsLeft', '課程堂數已用完');
  }

  // 課程的「不可預約／不可取消」時數與「最久可預約的日期」——預約精靈只在畫面上把不能選的
  // 時段反灰，學生停在確認畫面太久、或直接打 API，都要在這裡擋下來。
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || Number.isNaN(hoursUntilUtc8(date, time))) {
    return Response.json({ error: '無效的日期或時間' }, { status: 400 });
  }
  const course = await env.DB.prepare(
    `SELECT min_lead_hours, max_lead_days, duration_minutes, buffer_before_minutes, buffer_after_minutes FROM courses WHERE id = ?`
  ).bind(courseId).first<{ min_lead_hours: number; max_lead_days: number; duration_minutes: number; buffer_before_minutes: number; buffer_after_minutes: number }>();
  if (!course) {
    return Response.json({ error: '找不到課程' }, { status: 404 });
  }
  if (hoursUntilUtc8(date, time) < course.min_lead_hours) {
    return apiError(400, 'bookingTooLate', `距離上課時間不足 ${course.min_lead_hours} 小時，已無法預約這個時段，請重新選擇`, { hours: course.min_lead_hours });
  }
  if (date > utc8DateISO(course.max_lead_days)) {
    return apiError(400, 'bookingTooFar', `只能預約 ${course.max_lead_days} 天內的課程`, { days: course.max_lead_days });
  }

  // 老師要是啟用中、而且有開這門課——預約精靈第 3 步只讓學生選這樣的老師。
  const teacher = await env.DB.prepare(
    `SELECT t.id FROM teachers t JOIN teacher_courses tc ON tc.teacher_id = t.id AND tc.course_id = ?
     WHERE t.id = ? AND t.status = 'active'`
  ).bind(courseId, teacherId).first();
  if (!teacher) {
    return apiError(400, 'teacherUnavailable', '這位老師目前無法預約這門課程');
  }

  // 整堂課都要落在老師這一天（星期幾）開放的時段內，而且不是老師的休假日。老師的時段跟預約一樣以 UTC+8 儲存。
  const startMinutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const endMinutes = startMinutes + course.duration_minutes;
  const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  const withinHours = await env.DB.prepare(
    `SELECT 1 FROM teacher_hours WHERE teacher_id = ? AND day_of_week = ? AND start_time <= ? AND end_time >= ?`
  ).bind(teacherId, dayOfWeek, time, endTime).first();
  const onLeave = await env.DB.prepare(`SELECT 1 FROM teacher_leave WHERE teacher_id = ? AND date = ?`).bind(teacherId, date).first();
  if (!withinHours || onLeave) {
    return apiError(400, 'slotUnavailable', '老師這個時段沒有開放預約，請重新選擇');
  }

  // 寫入預約時在同一句 SQL 裡確認這段時間（含課程前後的緩衝）沒有跟這位老師其他還有效的預約重疊，
  // 同時送出的兩筆預約不會都成功。每筆既有預約用它自己那門課的時長／緩衝計算，跟預約精靈一樣。
  const bookingCode = await generateBookingCode(env, date, time);
  const row = await env.DB.prepare(
    `INSERT INTO bookings (booking_code, student_id, student_course_id, course_id, teacher_id, date, time)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM bookings b JOIN courses c ON c.id = b.course_id
       WHERE b.teacher_id = ? AND b.date = ? AND b.status != 'cancelled'
         AND ${sqlTimeMinutes('b.time')} - c.buffer_before_minutes < ?
         AND ${sqlTimeMinutes('b.time')} + c.duration_minutes + c.buffer_after_minutes > ?
     )
     RETURNING id`
  ).bind(
    bookingCode, session.userId, studentCourse.id, courseId, teacherId, date, time,
    teacherId, date, endMinutes + course.buffer_after_minutes, startMinutes - course.buffer_before_minutes
  ).first<{ id: number }>();
  if (!row) {
    return apiError(409, 'slotTaken', '此時段已被預約，請重新選擇');
  }

  // 還有剩下的堂數才 +1：上面檢查過之後，同一位學生同時送出的另一筆預約可能已經用掉最後一堂，
  // 這時把剛剛寫入的預約刪掉。
  const counted = await env.DB.prepare(
    `UPDATE student_courses SET booked_count = booked_count + 1 WHERE id = ? AND booked_count < total_sessions RETURNING id`
  ).bind(studentCourse.id).first();
  if (!counted) {
    await env.DB.prepare(`DELETE FROM bookings WHERE id = ?`).bind(row.id).run();
    return apiError(400, 'noSessionsLeft', '課程堂數已用完');
  }

  await notifyBooking(env, ctx, request, row.id, 'created');

  const created = await env.DB.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).bind(row!.id).first<BookingRow>();
  return Response.json(bookingRowToJson(created!, session.role), { status: 201 });
}

const FEEDBACK_MAX_LENGTH = 500;

async function handleBookingUpdate(request: Request, env: Env, session: Session, id: number, ctx: ExecutionContext): Promise<Response> {
  const existing = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first<BookingRow>();
  if (!existing) {
    return Response.json({ error: '找不到預約' }, { status: 404 });
  }

  const { status, rating, studentComment, teacherRating, teacherNote } = await request.json<{
    status?: string;
    rating?: number | null;
    studentComment?: string | null;
    teacherRating?: number | null;
    teacherNote?: string | null;
  }>();

  const hasStatus = status !== undefined;
  const hasRating = rating !== undefined || studentComment !== undefined;
  const hasTeacherFeedback = teacherRating !== undefined || teacherNote !== undefined;
  if (!hasStatus && !hasRating && !hasTeacherFeedback) {
    return Response.json({ error: '沒有可更新的欄位' }, { status: 400 });
  }

  const VALID_STATUSES = new Set(['upcoming', 'attended', 'cancelled', 'absent', 'pending']);
  if (hasStatus && !VALID_STATUSES.has(status!)) {
    return Response.json({ error: '缺少或無效的狀態' }, { status: 400 });
  }
  if (rating !== undefined && rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return Response.json({ error: '評分需為 1 到 5 的整數' }, { status: 400 });
  }
  if (teacherRating !== undefined && teacherRating !== null && (!Number.isInteger(teacherRating) || teacherRating < 1 || teacherRating > 5)) {
    return Response.json({ error: '評分需為 1 到 5 的整數' }, { status: 400 });
  }
  if (studentComment !== undefined && studentComment !== null && typeof studentComment !== 'string') {
    return Response.json({ error: '留言格式錯誤' }, { status: 400 });
  }
  if (teacherNote !== undefined && teacherNote !== null && typeof teacherNote !== 'string') {
    return Response.json({ error: '課堂記錄格式錯誤' }, { status: 400 });
  }
  // 跟畫面上輸入框的 maxlength 一致
  if ((studentComment?.length ?? 0) > FEEDBACK_MAX_LENGTH || (teacherNote?.length ?? 0) > FEEDBACK_MAX_LENGTH) {
    return apiError(400, 'textTooLong', `留言最多 ${FEEDBACK_MAX_LENGTH} 個字`, { max: FEEDBACK_MAX_LENGTH });
  }

  if (session.role === 'student') {
    if (hasStatus && (existing.student_id !== session.userId || status !== 'cancelled')) {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
    // 學生只能取消還沒上的課（已完成、缺席、待處理的都不行，否則會把已上課／已預約次數拿回來），
    // 而且要在該課程「不可預約／不可取消」的時數之前；時限內要取消請管理者處理（管理者不受限）。
    if (hasStatus) {
      if (existing.status !== 'upcoming') {
        return apiError(400, 'cannotCancel', '這堂課已經無法取消');
      }
      const course = await env.DB.prepare(`SELECT min_lead_hours FROM courses WHERE id = ?`).bind(existing.course_id).first<{ min_lead_hours: number }>();
      const minLeadHours = course?.min_lead_hours ?? 48;
      if (!(hoursUntilUtc8(existing.date, existing.time) >= minLeadHours)) {
        return apiError(400, 'cancelTooLate', `距離上課時間不足 ${minLeadHours} 小時，已無法取消預約，如有需要請聯絡管理者協助處理。`, { hours: minLeadHours });
      }
    }
    // 學生只能對自己已經上過（attended）的課評分留言，避免直接打 API 對還沒上的課評分。
    if (hasRating && (existing.student_id !== session.userId || existing.status !== 'attended')) {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
    if (hasTeacherFeedback) {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
  } else if (session.role === 'teacher') {
    if (hasStatus && (existing.teacher_id !== session.userId || status !== 'attended')) {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
    // 老師只能把還沒上的課標成完成（已取消的課被標成完成會把預約次數再扣一次），而且要等上課時間
    // 結束——開始時間加上課程時長，例如 12:00 開始、1 小時 40 分的課要 13:40 之後。管理者不受限。
    if (hasStatus) {
      if (existing.status !== 'upcoming') {
        return apiError(400, 'cannotComplete', '這堂課無法標記為完成');
      }
      const course = await env.DB.prepare(`SELECT duration_minutes FROM courses WHERE id = ?`).bind(existing.course_id).first<{ duration_minutes: number }>();
      const durationHours = (course?.duration_minutes ?? 100) / 60;
      if (!(hoursUntilUtc8(existing.date, existing.time) + durationHours <= 0)) {
        return apiError(400, 'lessonNotEnded', '這堂課程還沒有結束，請等課程時間結束後再標記為完成');
      }
    }
    if (hasTeacherFeedback && existing.teacher_id !== session.userId) {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
    if (hasRating) {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
  } else {
    // admin：status 不受限（沿用原本行為）。teacherRating／teacherNote 也不受限——admin 可以用
    // /admin/teacher-lessons?id= 代管老師視角完成課程，同一支 API 會帶上
    // 老師評分／課堂記錄，這裡如果限制只有老師本人能寫，會讓代管完成功能被擋下來。
    // rating 維持不開放：目前沒有任何 admin 畫面會送出學生評分（admin/bookings.html
    // 只唯讀顯示），所以 API 也不需要接受 admin 寫入。
    if (hasRating) {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
  }

  const newStatus = hasStatus ? status! : existing.status;
  const newRating = rating !== undefined ? rating : existing.rating;
  const newComment = studentComment !== undefined ? studentComment : existing.student_comment;
  const newTeacherRating = teacherRating !== undefined ? teacherRating : existing.teacher_rating;
  const newNote = teacherNote !== undefined ? teacherNote : existing.teacher_note;

  await env.DB.prepare(
    `UPDATE bookings SET status = ?, rating = ?, student_comment = ?, teacher_rating = ?, teacher_note = ? WHERE id = ?`
  ).bind(newStatus, newRating, newComment, newTeacherRating, newNote, id).run();

  const oldStatus = existing.status;
  let bookedDelta = 0;
  let attendedDelta = 0;
  if (oldStatus !== 'cancelled' && newStatus === 'cancelled') bookedDelta = -1;
  if (oldStatus === 'cancelled' && newStatus !== 'cancelled') bookedDelta = 1;
  if (oldStatus !== 'attended' && newStatus === 'attended') attendedDelta = 1;
  if (oldStatus === 'attended' && newStatus !== 'attended') attendedDelta = -1;
  if (bookedDelta || attendedDelta) {
    // 堂數全部上完就把這筆已購買課程標成 completed；管理者把某堂課從完成改回其他狀態
    // （已上課 -1）時也跟著變回 ongoing。SET 裡的欄位讀到的是更新前的值，所以要自己加上 delta。
    await env.DB.prepare(
      `UPDATE student_courses
       SET booked_count = booked_count + ?,
           attended_count = attended_count + ?,
           status = CASE WHEN attended_count + ? >= total_sessions THEN 'completed' ELSE 'ongoing' END
       WHERE id = ?`
    ).bind(bookedDelta, attendedDelta, attendedDelta, existing.student_course_id).run();
  }

  // 學生自己取消或管理者代為取消，都通知學生和老師
  if (oldStatus !== 'cancelled' && newStatus === 'cancelled') {
    await notifyBooking(env, ctx, request, id, 'cancelled');
  }

  const updated = await env.DB.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).bind(id).first<BookingRow>();
  return Response.json(bookingRowToJson(updated!, session.role));
}

// Shared "recently viewed" tracking for the admin teacher/student/course list
// pages — one admin opening a detail page bumps it for every admin, so this
// lives in D1. (The list pages' search box text is deliberately kept local;
// see the SEARCH_KEY handling in teachers.html/students.html/courses.html.)
const RECENTLY_VIEWED_TYPES = new Set(['teacher', 'student', 'course']);

async function handleRecentlyViewedMark(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || '';
  const id = Number(url.searchParams.get('id'));

  if (!RECENTLY_VIEWED_TYPES.has(type) || !Number.isInteger(id) || id <= 0) {
    return Response.json({ error: '缺少或無效的 type/id' }, { status: 400 });
  }

  await env.DB.prepare(
    `INSERT INTO recently_viewed (entity_type, entity_id, viewed_at) VALUES (?, ?, ?)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET viewed_at = excluded.viewed_at`
  ).bind(type, id, Date.now()).run();

  return Response.json({ ok: true });
}

async function handleRecentlyViewedList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || '';

  if (!RECENTLY_VIEWED_TYPES.has(type)) {
    return Response.json({ error: '缺少或無效的 type' }, { status: 400 });
  }

  const { results } = await env.DB.prepare(
    `SELECT entity_id, viewed_at FROM recently_viewed WHERE entity_type = ?`
  ).bind(type).all<{ entity_id: number; viewed_at: number }>();

  const map: Record<number, number> = {};
  for (const row of results) map[row.entity_id] = row.viewed_at;
  return Response.json(map);
}

// ==========================================================================
// 管理端「請求書」：每位老師每個月的請求書／業務委託実績通知書。以「課堂數」計算：當月（上課
// 日期，UTC+8）標記完成的課，每堂單價是老師領收書資料的 wage，消費稅率是 taxRate（'0%'／'5%'／'10%'）。
// 單價、稅率用老師目前的設定，改了之後過去月份的金額也會跟著變。
// ==========================================================================
interface InvoiceReceipt {
  wage?: unknown;
  taxRate?: unknown;
  address?: unknown;
  companyName?: unknown;
  companyAddress?: unknown;
}

function receiptText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// 金額都在這裡算，列表、列印頁、明細頁都用同一套結果：
// 小計 = 單價 × 堂數；消費稅 = 小計 × 稅率（捨去到日圓）；合計 = 小計 + 消費稅。
// 1コマ単価＜消費税込＞ = 單價 × (1 + 稅率)，可能有小數（例：1,627.5）。
function computeInvoice(lessonCount: number, receipt: InvoiceReceipt | null) {
  const wageText = receiptText(receipt?.wage);
  const unitPrice = /^\d+$/.test(wageText) && Number(wageText) > 0 ? Number(wageText) : null;
  const taxMatch = /^(\d+)%$/.exec(receiptText(receipt?.taxRate));
  const taxRate = taxMatch ? Number(taxMatch[1]) : 0;
  const receiptInfo = {
    address: receiptText(receipt?.address),
    companyName: receiptText(receipt?.companyName),
    companyAddress: receiptText(receipt?.companyAddress),
  };
  const missing: string[] = [];
  if (unitPrice === null) missing.push('unitPrice');
  if (!receiptInfo.address) missing.push('address');
  if (!receiptInfo.companyName) missing.push('companyName');
  if (!receiptInfo.companyAddress) missing.push('companyAddress');
  if (unitPrice === null) {
    return { lessonCount, unitPrice, taxRate, unitPriceWithTax: null, subtotal: null, tax: null, total: null, missing, receipt: receiptInfo };
  }
  const subtotal = unitPrice * lessonCount;
  const tax = Math.floor((subtotal * taxRate) / 100);
  return {
    lessonCount,
    unitPrice,
    taxRate,
    unitPriceWithTax: (unitPrice * (100 + taxRate)) / 100,
    subtotal,
    tax,
    total: subtotal + tax,
    missing,
    receipt: receiptInfo,
  };
}

// 'YYYY-MM' → 當月第一天跟下個月第一天（查詢用 date >= 起 AND date < 迄）
function parseInvoiceMonth(month: string | null): { start: string; end: string } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month ?? '');
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
  return { start: `${month}-01`, end: `${next}-01` };
}

async function handleInvoicesList(env: Env, url: URL): Promise<Response> {
  const range = parseInvoiceMonth(url.searchParams.get('month'));
  if (!range) return Response.json({ error: '缺少或無效的月份（YYYY-MM）' }, { status: 400 });
  const teacherIdParam = url.searchParams.get('teacherId');
  const teacherId = teacherIdParam === null ? null : Number(teacherIdParam);
  if (teacherId !== null && (!Number.isInteger(teacherId) || teacherId <= 0)) {
    return Response.json({ error: '缺少或無效的 teacherId' }, { status: 400 });
  }
  // 啟用中的老師每個月都列出來（沒有完成的課就是 0 堂）；停用的老師只有當月有課才列出。
  // 有上課的老師排前面，其次依姓名。
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.name, t.photo_path, t.status,
            CASE WHEN json_valid(t.receipt_json) THEN t.receipt_json END AS receipt_json,
            COALESCE(c.n, 0) AS lesson_count
     FROM teachers t
     LEFT JOIN (
       SELECT teacher_id, COUNT(*) AS n FROM bookings
       WHERE status = 'attended' AND date >= ? AND date < ?
       GROUP BY teacher_id
     ) c ON c.teacher_id = t.id
     WHERE (t.status = 'active' OR c.n > 0)${teacherId !== null ? ' AND t.id = ?' : ''}
     ORDER BY (COALESCE(c.n, 0) = 0), t.name`
  ).bind(...(teacherId !== null ? [range.start, range.end, teacherId] : [range.start, range.end]))
    .all<{ id: number; name: string; photo_path: string | null; status: string; receipt_json: string | null; lesson_count: number }>();
  return Response.json(results.map((row) => ({
    teacherId: row.id,
    name: row.name,
    avatar: row.photo_path,
    status: row.status,
    ...computeInvoice(row.lesson_count, row.receipt_json ? (JSON.parse(row.receipt_json) as InvoiceReceipt) : null),
  })));
}

async function handleInvoiceLessons(env: Env, url: URL): Promise<Response> {
  const range = parseInvoiceMonth(url.searchParams.get('month'));
  const teacherId = Number(url.searchParams.get('teacherId'));
  if (!range) return Response.json({ error: '缺少或無效的月份（YYYY-MM）' }, { status: 400 });
  if (!Number.isInteger(teacherId) || teacherId <= 0) return Response.json({ error: '缺少或無效的 teacherId' }, { status: 400 });
  const { results } = await env.DB.prepare(
    `${BOOKING_SELECT} WHERE b.teacher_id = ? AND b.status = 'attended' AND b.date >= ? AND b.date < ? ORDER BY b.date, b.time`
  ).bind(teacherId, range.start, range.end).all<BookingRow>();
  return Response.json(results.map((row) => bookingRowToJson(row, 'admin')));
}

// ==========================================================================
// 管理端「系統信件」：列出所有系統信、讀取／修改某一封信五種語言的主旨與 HTML。只存改過的版本，
// 存的內容跟預設範本一模一樣時就刪掉那一筆（回到「沿用預設」，之後預設範本更新也會跟著套用）。
// ==========================================================================
const EMAIL_SUBJECT_MAX_LENGTH = 200;
const EMAIL_HTML_MAX_LENGTH = 100_000;

async function handleEmailTemplatesList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT template_key, language, updated_at FROM email_templates`)
    .all<{ template_key: string; language: string; updated_at: string }>();
  return Response.json(EMAIL_TEMPLATES.map((tpl) => {
    const rows = results.filter((r) => r.template_key === tpl.key);
    return {
      key: tpl.key,
      variables: tpl.variables,
      customizedLanguages: rows.map((r) => r.language),
      updatedAt: rows.reduce<string | null>((latest, r) => (!latest || r.updated_at > latest ? r.updated_at : latest), null),
    };
  }));
}

async function handleEmailTemplateGet(env: Env, key: EmailTemplateKey): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT language, subject, html, updated_at FROM email_templates WHERE template_key = ?`)
    .bind(key).all<{ language: string; subject: string; html: string; updated_at: string }>();
  const languages = Object.fromEntries(SUPPORTED_LANGUAGES.map((lang) => {
    const def = defaultEmailTemplate(key, lang);
    const row = results.find((r) => r.language === lang);
    return [lang, {
      subject: row?.subject ?? def.subject,
      html: row?.html ?? def.html,
      defaultSubject: def.subject,
      defaultHtml: def.html,
      customized: !!row,
      updatedAt: row?.updated_at ?? null,
    }];
  }));
  const tpl = EMAIL_TEMPLATES.find((t) => t.key === key)!;
  return Response.json({ key, variables: tpl.variables, languages });
}

// body: { languages: { 'zh-Hant': { subject, html }, ... } }，只需要帶有改的語言
async function handleEmailTemplateUpdate(request: Request, env: Env, key: EmailTemplateKey): Promise<Response> {
  const body = await request.json<{ languages?: unknown }>().catch(() => null);
  const languages = body?.languages;
  if (!languages || typeof languages !== 'object' || Array.isArray(languages) || !Object.keys(languages).length) {
    return Response.json({ error: '缺少要儲存的內容' }, { status: 400 });
  }
  const statements: D1PreparedStatement[] = [];
  for (const [lang, value] of Object.entries(languages as Record<string, unknown>)) {
    if (!isSupportedLanguage(lang)) return Response.json({ error: '不支援的語言' }, { status: 400 });
    const { subject, html } = (value ?? {}) as { subject?: unknown; html?: unknown };
    if (typeof subject !== 'string' || typeof html !== 'string' || !subject.trim() || !html.trim()) {
      return Response.json({ error: '主旨和內容都不能空白' }, { status: 400 });
    }
    if (subject.length > EMAIL_SUBJECT_MAX_LENGTH) {
      return apiError(400, 'textTooLong', `主旨最多 ${EMAIL_SUBJECT_MAX_LENGTH} 個字`, { max: EMAIL_SUBJECT_MAX_LENGTH });
    }
    if (html.length > EMAIL_HTML_MAX_LENGTH) {
      return apiError(400, 'textTooLong', `內容最多 ${EMAIL_HTML_MAX_LENGTH} 個字`, { max: EMAIL_HTML_MAX_LENGTH });
    }
    const def = defaultEmailTemplate(key, lang);
    statements.push(subject === def.subject && html === def.html
      ? env.DB.prepare(`DELETE FROM email_templates WHERE template_key = ? AND language = ?`).bind(key, lang)
      : env.DB.prepare(
          `INSERT INTO email_templates (template_key, language, subject, html, updated_at)
           VALUES (?, ?, ?, ?, datetime('now', '+8 hours'))
           ON CONFLICT (template_key, language) DO UPDATE SET subject = excluded.subject, html = excluded.html, updated_at = excluded.updated_at`
        ).bind(key, lang, subject, html));
  }
  await env.DB.batch(statements);
  return handleEmailTemplateGet(env, key);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withSecurityHeaders(await route(request, env, ctx));
  },
  // wrangler.jsonc 的 triggers.crons 設定多久跑一次；本機 `wrangler dev` 不會自動觸發，
  // 要測試用 `wrangler dev --test-scheduled` 再打 /__scheduled。
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendDueBookingReminders(env));
  },
};

// 所有經過 Worker 的回應都加上基本的安全標頭（直接由靜態資源回應的檔案，例如登入頁，
// 改由 public/_headers 設定——Cloudflare 的 _headers 不會套用在 Worker 產生的回應上）：
// 禁止被其他網站用 iframe 嵌入（防點擊劫持）、禁止瀏覽器猜測檔案類型、限制 Referer 外洩。
// 已經自己設定的標頭（例如頭像圖片更嚴格的 CSP）不覆蓋。
const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!secured.headers.has(name)) secured.headers.set(name, value);
  }
  return secured;
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/api/config' && request.method === 'GET') {
    // Lets the frontend tell test/dev sites apart from production (e.g. to
    // show the test-account quick-fill avatars only where ALLOW_ANY_OTP is
    // set) without duplicating that flag anywhere else.
    return Response.json({ testMode: env.ALLOW_ANY_OTP === 'true' });
  }
  if (url.pathname === '/api/otp/request' && request.method === 'POST') {
    return handleOtpRequest(request, env);
  }
  if (url.pathname === '/api/otp/verify' && request.method === 'POST') {
    return handleOtpVerify(request, env);
  }
  if (url.pathname === '/api/session' && request.method === 'GET') {
    return handleSessionInfo(request, env);
  }
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    return handleLogout(request, env);
  }
  if ((url.pathname.startsWith('/avatars/') || url.pathname.startsWith('/courses/')) && request.method === 'GET') {
    return handleAvatarGet(request, env, url.pathname.slice(1));
  }

  // email.html / ui.html are internal design/preview pages, not part of the
  // product — never served on the real deployment (ALLOW_ANY_OTP unset
  // there), only on local/test. html_handling drops the .html extension,
  // so both forms need covering.
  const DEV_ONLY_PAGES = new Set(['/email', '/email.html', '/ui', '/ui.html']);
  if (DEV_ONLY_PAGES.has(url.pathname) && env.ALLOW_ANY_OTP !== 'true') {
    return new Response('Not found', { status: 404 });
  }

  // Everything below here needs a real, server-verified session — avatar
  // uploads and the recently-viewed list are both admin-only tools (see the
  // call sites in public/admin/*.html), and the admin/teacher/student
  // static pages must never render for a visitor who never logged in.
  if (url.pathname === '/api/avatar/upload' && request.method === 'PUT') {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
    return handleAvatarUpload(request, env);
  }
  if (url.pathname === '/api/recently-viewed' && (request.method === 'PUT' || request.method === 'GET')) {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
    return request.method === 'PUT' ? handleRecentlyViewedMark(request, env) : handleRecentlyViewedList(request, env);
  }
  if ((url.pathname === '/api/invoices' || url.pathname === '/api/invoices/lessons') && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') return Response.json({ error: '未授權' }, { status: 401 });
    return url.pathname === '/api/invoices' ? handleInvoicesList(env, url) : handleInvoiceLessons(env, url);
  }

  if (url.pathname === '/api/email-templates') {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') return Response.json({ error: '未授權' }, { status: 401 });
    const key = url.searchParams.get('key');
    if (request.method === 'GET' && key === null) return handleEmailTemplatesList(env);
    if (!isEmailTemplateKey(key)) return Response.json({ error: '找不到這封系統信' }, { status: 404 });
    if (request.method === 'GET') return handleEmailTemplateGet(env, key);
    if (request.method === 'PUT') return handleEmailTemplateUpdate(request, env, key);
  }

  if (url.pathname === '/api/courses' && request.method === 'GET') {
    // All three roles browse the catalog (admin manages it, students pick
    // from it when booking, teachers look up a course's duration) — any
    // logged-in session is enough, it doesn't need to be an admin.
    const session = await getSession(request, env);
    if (!session) {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
    return handleCoursesList(env);
  }
  if (url.pathname === '/api/courses' && (request.method === 'POST' || request.method === 'PATCH')) {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
    return request.method === 'POST' ? handleCourseCreate(request, env) : handleCourseUpdate(request, env);
  }

  if (url.pathname === '/api/teachers' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!session) return Response.json({ error: '未授權' }, { status: 401 });
    return handleTeachersList(env, session);
  }
  if (url.pathname === '/api/teachers/me' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!session || session.role !== 'teacher') return Response.json({ error: '未授權' }, { status: 401 });
    return handleTeacherSelf(env, session);
  }
  if (url.pathname === '/api/teachers' && (request.method === 'POST' || request.method === 'PATCH')) {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') return Response.json({ error: '未授權' }, { status: 401 });
    return request.method === 'POST' ? handleTeacherCreate(request, env) : handleTeacherUpdate(request, env);
  }
  if (url.pathname === '/api/teachers/courses' && request.method === 'PATCH') {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') return Response.json({ error: '未授權' }, { status: 401 });
    const teacherId = Number(url.searchParams.get('teacherId'));
    if (!Number.isInteger(teacherId) || teacherId <= 0) return Response.json({ error: '缺少或無效的 teacherId' }, { status: 400 });
    return handleTeacherCoursesUpdate(request, env, teacherId);
  }

  // Weekly hours / leave: readable by any logged-in session (the student
  // booking wizard reads them to compute bookable slots); writable by the
  // teacher themselves or an admin managing on their behalf, matching the
  // ?teacherId= honored-only-for-admin pattern (the /admin/teacher-* pages).
  if (url.pathname === '/api/teachers/hours' || url.pathname === '/api/teachers/leave') {
    const session = await getSession(request, env);
    if (!session) return Response.json({ error: '未授權' }, { status: 401 });

    const qsTeacherId = Number(url.searchParams.get('teacherId'));
    let teacherId: number;
    if (request.method === 'GET') {
      if (!Number.isInteger(qsTeacherId) || qsTeacherId <= 0) return Response.json({ error: '缺少或無效的 teacherId' }, { status: 400 });
      teacherId = qsTeacherId;
    } else {
      if (session.role === 'admin') {
        if (!Number.isInteger(qsTeacherId) || qsTeacherId <= 0) return Response.json({ error: '缺少或無效的 teacherId' }, { status: 400 });
        teacherId = qsTeacherId;
      } else if (session.role === 'teacher') {
        teacherId = session.userId;
      } else {
        return Response.json({ error: '未授權' }, { status: 401 });
      }
    }

    const isHours = url.pathname === '/api/teachers/hours';
    if (request.method === 'GET') {
      return isHours ? handleTeacherHoursList(env, teacherId) : handleTeacherLeaveList(env, teacherId);
    }
    if (request.method === 'POST') {
      return isHours ? handleTeacherHoursCreate(request, env, teacherId) : handleTeacherLeaveCreate(request, env, teacherId);
    }
    if (request.method === 'DELETE') {
      const entryId = Number(url.searchParams.get('id'));
      if (!Number.isInteger(entryId) || entryId <= 0) return Response.json({ error: '缺少或無效的 id' }, { status: 400 });
      return isHours ? handleTeacherHoursDelete(env, teacherId, entryId) : handleTeacherLeaveDelete(env, teacherId, entryId);
    }
  }

  if (url.pathname === '/api/students/me' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!session || session.role !== 'student') return Response.json({ error: '未授權' }, { status: 401 });
    return handleStudentSelf(env, session);
  }
  if (url.pathname === '/api/admins/me' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') return Response.json({ error: '未授權' }, { status: 401 });
    return handleAdminSelf(env, session);
  }
  // Language switch — any logged-in role, always on their own record.
  if (url.pathname === '/api/me/language' && request.method === 'PATCH') {
    const session = await getSession(request, env);
    if (!session) return Response.json({ error: '未授權' }, { status: 401 });
    return handleOwnLanguageUpdate(request, env, session);
  }
  // Settings pages — a student/teacher edits a few fields of their own record.
  if (url.pathname === '/api/me/profile' && request.method === 'PATCH') {
    const session = await getSession(request, env);
    if (!session || (session.role !== 'student' && session.role !== 'teacher')) return Response.json({ error: '未授權' }, { status: 401 });
    return handleOwnProfileUpdate(request, env, session);
  }
  if (url.pathname === '/api/me/avatar' && request.method === 'PUT') {
    const session = await getSession(request, env);
    if (!session || (session.role !== 'student' && session.role !== 'teacher')) return Response.json({ error: '未授權' }, { status: 401 });
    return handleOwnAvatarUpload(request, env, session);
  }
  if (url.pathname === '/api/students' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') return Response.json({ error: '未授權' }, { status: 401 });
    return handleStudentsList(env);
  }
  if (url.pathname === '/api/students' && (request.method === 'POST' || request.method === 'PATCH')) {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') return Response.json({ error: '未授權' }, { status: 401 });
    return request.method === 'POST' ? handleStudentCreate(request, env) : handleStudentUpdate(request, env);
  }

  // A student's own enrolled courses: readable by the student themselves
  // (the booking wizard needs to know which course(s) they can book) or an
  // admin; writable by an admin only.
  if (url.pathname === '/api/students/courses') {
    const session = await getSession(request, env);
    if (!session) return Response.json({ error: '未授權' }, { status: 401 });

    const qsStudentId = Number(url.searchParams.get('studentId'));
    let studentId: number;
    if (session.role === 'admin') {
      if (!Number.isInteger(qsStudentId) || qsStudentId <= 0) return Response.json({ error: '缺少或無效的 studentId' }, { status: 400 });
      studentId = qsStudentId;
    } else if (session.role === 'student' && request.method === 'GET') {
      studentId = session.userId;
    } else {
      return Response.json({ error: '未授權' }, { status: 401 });
    }

    if (request.method === 'GET') return handleStudentCoursesList(env, studentId);
    if (request.method === 'POST') return handleStudentCourseCreate(request, env, studentId);
    if (request.method === 'PATCH' || request.method === 'DELETE') {
      const scId = Number(url.searchParams.get('id'));
      if (!Number.isInteger(scId) || scId <= 0) return Response.json({ error: '缺少或無效的 id' }, { status: 400 });
      return request.method === 'PATCH'
        ? handleStudentCourseUpdate(request, env, studentId, scId)
        : handleStudentCourseDelete(env, studentId, scId);
    }
  }

  // 補償一堂（原因存進 student_course_adjustments）跟查詢補償紀錄，只有管理者能用
  if (url.pathname === '/api/students/courses/compensate' && request.method === 'POST') {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') return Response.json({ error: '未授權' }, { status: 401 });
    const qsStudentId = Number(url.searchParams.get('studentId'));
    const scId = Number(url.searchParams.get('id'));
    if (!Number.isInteger(qsStudentId) || qsStudentId <= 0) return Response.json({ error: '缺少或無效的 studentId' }, { status: 400 });
    if (!Number.isInteger(scId) || scId <= 0) return Response.json({ error: '缺少或無效的 id' }, { status: 400 });
    return handleStudentCourseCompensate(request, env, session, qsStudentId, scId);
  }
  if (url.pathname === '/api/students/courses/adjustments' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!session || session.role !== 'admin') return Response.json({ error: '未授權' }, { status: 401 });
    const qsStudentId = Number(url.searchParams.get('studentId'));
    const scId = Number(url.searchParams.get('id'));
    if (!Number.isInteger(qsStudentId) || qsStudentId <= 0) return Response.json({ error: '缺少或無效的 studentId' }, { status: 400 });
    if (!Number.isInteger(scId) || scId <= 0) return Response.json({ error: '缺少或無效的 id' }, { status: 400 });
    return handleStudentCourseAdjustmentsList(env, qsStudentId, scId);
  }

  if (url.pathname === '/api/bookings' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!session) return Response.json({ error: '未授權' }, { status: 401 });
    return handleBookingsList(request, env, session);
  }
  if (url.pathname === '/api/bookings' && request.method === 'POST') {
    const session = await getSession(request, env);
    if (!session) return Response.json({ error: '未授權' }, { status: 401 });
    return handleBookingCreate(request, env, session, ctx);
  }
  if (url.pathname === '/api/bookings' && request.method === 'PATCH') {
    const session = await getSession(request, env);
    if (!session) return Response.json({ error: '未授權' }, { status: 401 });
    const id = Number(url.searchParams.get('id'));
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '缺少或無效的 id' }, { status: 400 });
    return handleBookingUpdate(request, env, session, id, ctx);
  }

  // Each role's pages are gated to that role only. Admins manage a teacher's
  // hours/leave/lessons through the /admin/teacher-* aliases below instead of
  // entering /teacher/* themselves.
  const ALLOWED_SESSION_ROLES: Record<string, readonly string[]> = {
    admin: ['admin'],
    teacher: ['teacher'],
    student: ['student'],
  };
  const protectedRole = (['admin', 'teacher', 'student'] as const).find(
    (role) => url.pathname === `/${role}` || url.pathname.startsWith(`/${role}/`)
  );
  if (protectedRole) {
    const session = await getSession(request, env);
    if (!session || !ALLOWED_SESSION_ROLES[protectedRole].includes(session.role)) {
      return Response.redirect(new URL('/', request.url).toString(), 302);
    }
  }

  // Admin-only alias (already gated by the /admin prefix above) that serves
  // the same HTML as the teacher's own page — the page tells the two apart
  // by location.pathname, so the URL alone says whose view it is.
  const adminTeacherPage = ADMIN_TEACHER_PAGE_ALIASES[url.pathname.replace(/\.html$/, '')];
  if (adminTeacherPage) {
    return env.ASSETS.fetch(new Request(new URL(adminTeacherPage, request.url), request));
  }

  return env.ASSETS.fetch(request);
}
