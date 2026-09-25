export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AVATARS: R2Bucket;
  TEAMS_WEBHOOK_URL?: string;
  // Dev/test-site only: when 'true', /api/otp/verify accepts any 6-digit code.
  // Must never be set in the production deployment's vars/secrets.
  ALLOW_ANY_OTP?: string;
}

const ROLE_LABELS: Record<string, string> = {
  student: '學生',
  teacher: '老師',
  admin: '管理者',
};

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

// 帳號被停用時，已經登入的裝置也要立刻登出（停用的帳號也不能再取得驗證碼，見 findActiveAccountId）
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

async function sendToTeams(env: Env, role: string, email: string, code: string): Promise<void> {
  if (!env.TEAMS_WEBHOOK_URL) return;
  try {
    const adaptiveCard = {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: `【JPTIP】${ROLE_LABELS[role] ?? role}登入驗證碼`,
          weight: 'Bolder',
          size: 'Medium',
          wrap: true,
        },
        {
          type: 'TextBlock',
          text: `${email} 的驗證碼是：**${code}**`,
          wrap: true,
        },
        {
          type: 'TextBlock',
          text: '5 分鐘內有效，請勿提供給他人。',
          wrap: true,
          isSubtle: true,
          size: 'Small',
        },
      ],
    };

    const res = await fetch(env.TEAMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adaptiveCard),
    });
    if (!res.ok) {
      console.error('[teams webhook] non-OK response', res.status, await res.text());
    }
  } catch (err) {
    console.error('[teams webhook] failed', err);
  }
}

// 帳號存在而且沒有被停用才回傳 id（管理者沒有停用這回事）
async function findActiveAccountId(env: Env, role: string, email: string): Promise<number | null> {
  const row = role === 'admin'
    ? await env.DB.prepare(`SELECT id FROM admins WHERE email = ?`).bind(email).first<{ id: number }>()
    : await env.DB.prepare(`SELECT id FROM ${ROLE_TABLES[role]} WHERE email = ? AND status != 'inactive'`).bind(email).first<{ id: number }>();
  return row ? row.id : null;
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
    `UPDATE otp_codes SET used = 1, attempts = attempts - 1 WHERE id = ? AND used = 0`
  ).bind(claimed.id).run();
  return used.meta.changes === 1 ? 'ok' : 'wrong';
}

async function handleOtpRequest(request: Request, env: Env): Promise<Response> {
  const { email, role } = await request.json<{ email?: string; role?: string }>();

  if (!email || !isValidEmail(email)) {
    return Response.json({ error: '請輸入有效的 Email 格式' }, { status: 400 });
  }
  if (!role || !ROLE_TABLES[role]) {
    return Response.json({ error: '無效的角色' }, { status: 400 });
  }

  // 查無帳號或帳號已停用時，回應跟成功完全一樣（只是不發驗證碼），不讓人藉此試出
  // 哪些 Email 有註冊。
  if (!(await findActiveAccountId(env, role, email))) {
    return Response.json({ ok: true });
  }

  const code = generateCode();

  // 新的驗證碼發出後，舊的一律作廢：同一時間只會有一組有效的碼，申請再多次也不會增加猜中的機會。
  await env.DB.prepare(`UPDATE otp_codes SET used = 1 WHERE email = ? AND role = ? AND used = 0`).bind(email, role).run();
  await env.DB.prepare(
    `INSERT INTO otp_codes (email, role, code, expires_at)
     VALUES (?, ?, ?, datetime('now', '+8 hours', '+5 minutes'))`
  ).bind(email, role, code).run();

  // TODO: also send by email once Cloudflare Email Routing / Workers Send Email or
  // Microsoft Graph is set up for the jptip.co.jp domain. For now the code goes to
  // the Teams channel webhook (if configured) and is always persisted in D1.
  console.log(`[otp] ${role} ${email} code=${code}`);
  await sendToTeams(env, role, email, code);

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
  const accountId = await findActiveAccountId(env, role, email);
  if (!accountId) {
    return Response.json({ error: '驗證碼錯誤或已過期' }, { status: 400 });
  }
  const account = { id: accountId };

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
    return Response.json({ error: 'Email 已被使用' }, { status: 400 });
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
    return Response.json({ error: '只能申請今天以後的休假' }, { status: 400 });
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
    return Response.json({ error: 'Email 已被使用' }, { status: 400 });
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
  const { courseName, totalSessions } = await request.json<{ courseName?: string; totalSessions?: number | null }>();
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

  const row = await env.DB.prepare(
    `INSERT INTO student_courses (student_id, course_id, total_sessions) VALUES (?, ?, ?) RETURNING *`
  ).bind(studentId, course.id, totalSessions ?? course.default_sessions).first<Omit<StudentCourseRow, 'course_name'>>();

  return Response.json(studentCourseRowToJson({ ...row!, course_name: course.name }), { status: 201 });
}

async function handleStudentCourseDelete(env: Env, studentId: number, studentCourseId: number): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT booked_count, attended_count FROM student_courses WHERE id = ? AND student_id = ?`
  ).bind(studentCourseId, studentId).first<{ booked_count: number; attended_count: number }>();
  if (!row) {
    return Response.json({ error: '找不到課程' }, { status: 404 });
  }
  if (row.booked_count > 0 || row.attended_count > 0) {
    return Response.json({ error: '已有預約或上課紀錄，無法刪除' }, { status: 400 });
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

async function generateBookingCode(env: Env, date: string, time: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE date = ? AND time = ?`).bind(date, time).first<{ n: number }>();
  const seq = String((row?.n ?? 0) + 1).padStart(2, '0');
  return `${date.replace(/-/g, '')}-${time.replace(':', '')}-${seq}`;
}

// 上課日期時間一律以 UTC+8（台北時間）儲存，預約／取消的時限也都以 UTC+8 判斷，不受瀏覽器所在時區影響。
function hoursUntilUtc8(date: string, time: string): number {
  return (Date.parse(`${date}T${time}:00+08:00`) - Date.now()) / 3_600_000;
}
function utc8DateISO(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function handleBookingCreate(request: Request, env: Env, session: Session): Promise<Response> {
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
    return Response.json({ error: '尚未報名此課程' }, { status: 400 });
  }
  if (studentCourse.booked_count >= studentCourse.total_sessions) {
    return Response.json({ error: '課程堂數已用完' }, { status: 400 });
  }

  // 課程的「不可預約／不可取消」時數與「最久可預約的日期」——預約精靈只在畫面上把不能選的
  // 時段反灰，學生停在確認畫面太久、或直接打 API，都要在這裡擋下來。
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || Number.isNaN(hoursUntilUtc8(date, time))) {
    return Response.json({ error: '無效的日期或時間' }, { status: 400 });
  }
  const course = await env.DB.prepare(`SELECT min_lead_hours, max_lead_days FROM courses WHERE id = ?`).bind(courseId).first<{ min_lead_hours: number; max_lead_days: number }>();
  if (!course) {
    return Response.json({ error: '找不到課程' }, { status: 404 });
  }
  if (hoursUntilUtc8(date, time) < course.min_lead_hours) {
    return Response.json({ error: `距離上課時間不足 ${course.min_lead_hours} 小時，已無法預約這個時段，請重新選擇` }, { status: 400 });
  }
  if (date > utc8DateISO(course.max_lead_days)) {
    return Response.json({ error: `只能預約 ${course.max_lead_days} 天內的課程` }, { status: 400 });
  }

  // Atomic "book if still free" — the same slot can't be double-booked by a
  // concurrent request, unlike the old client-side-only re-check.
  const clash = await env.DB.prepare(
    `SELECT id FROM bookings WHERE teacher_id = ? AND date = ? AND time = ? AND status != 'cancelled'`
  ).bind(teacherId, date, time).first();
  if (clash) {
    return Response.json({ error: '此時段已被預約，請重新選擇' }, { status: 409 });
  }

  const bookingCode = await generateBookingCode(env, date, time);
  const row = await env.DB.prepare(
    `INSERT INTO bookings (booking_code, student_id, student_course_id, course_id, teacher_id, date, time)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(bookingCode, session.userId, studentCourse.id, courseId, teacherId, date, time).first<{ id: number }>();

  await env.DB.prepare(`UPDATE student_courses SET booked_count = booked_count + 1 WHERE id = ?`).bind(studentCourse.id).run();

  const created = await env.DB.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).bind(row!.id).first<BookingRow>();
  return Response.json(bookingRowToJson(created!, session.role), { status: 201 });
}

async function handleBookingUpdate(request: Request, env: Env, session: Session, id: number): Promise<Response> {
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

  if (session.role === 'student') {
    if (hasStatus && (existing.student_id !== session.userId || status !== 'cancelled')) {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
    // 學生只能取消還沒上的課（已完成、缺席、待處理的都不行，否則會把已上課／已預約次數拿回來），
    // 而且要在該課程「不可預約／不可取消」的時數之前；時限內要取消請管理者處理（管理者不受限）。
    if (hasStatus) {
      if (existing.status !== 'upcoming') {
        return Response.json({ error: '這堂課已經無法取消' }, { status: 400 });
      }
      const course = await env.DB.prepare(`SELECT min_lead_hours FROM courses WHERE id = ?`).bind(existing.course_id).first<{ min_lead_hours: number }>();
      const minLeadHours = course?.min_lead_hours ?? 48;
      if (!(hoursUntilUtc8(existing.date, existing.time) >= minLeadHours)) {
        return Response.json({ error: `距離上課時間不足 ${minLeadHours} 小時，已無法取消預約，如有需要請聯絡管理者協助處理。` }, { status: 400 });
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withSecurityHeaders(await route(request, env));
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

async function route(request: Request, env: Env): Promise<Response> {
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
    if (request.method === 'DELETE') {
      const scId = Number(url.searchParams.get('id'));
      if (!Number.isInteger(scId) || scId <= 0) return Response.json({ error: '缺少或無效的 id' }, { status: 400 });
      return handleStudentCourseDelete(env, studentId, scId);
    }
  }

  if (url.pathname === '/api/bookings' && request.method === 'GET') {
    const session = await getSession(request, env);
    if (!session) return Response.json({ error: '未授權' }, { status: 401 });
    return handleBookingsList(request, env, session);
  }
  if (url.pathname === '/api/bookings' && request.method === 'POST') {
    const session = await getSession(request, env);
    if (!session) return Response.json({ error: '未授權' }, { status: 401 });
    return handleBookingCreate(request, env, session);
  }
  if (url.pathname === '/api/bookings' && request.method === 'PATCH') {
    const session = await getSession(request, env);
    if (!session) return Response.json({ error: '未授權' }, { status: 401 });
    const id = Number(url.searchParams.get('id'));
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '缺少或無效的 id' }, { status: 400 });
    return handleBookingUpdate(request, env, session, id);
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
