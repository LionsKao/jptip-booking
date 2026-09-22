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

// Self-service language switch — the student/teacher themselves updates only
// this one field on their own row (identified by session.userId, never a
// client-supplied id), separate from the admin-only full-profile PATCH.
async function handleOwnLanguageUpdate(request: Request, env: Env, session: Session): Promise<Response> {
  const table = session.role === 'student' ? 'students' : 'teachers';
  const body = await request.json<{ language?: string }>();
  if (!isSupportedLanguage(body.language)) {
    return Response.json({ error: '不支援的語言' }, { status: 400 });
  }
  await env.DB.prepare(`UPDATE ${table} SET language = ? WHERE id = ?`).bind(body.language, session.userId).run();
  return Response.json({ language: body.language });
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
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

async function handleOtpRequest(request: Request, env: Env): Promise<Response> {
  const { email, role } = await request.json<{ email?: string; role?: string }>();

  if (!email || !isValidEmail(email)) {
    return Response.json({ error: '請輸入有效的 Email 格式' }, { status: 400 });
  }
  if (!role || !ROLE_TABLES[role]) {
    return Response.json({ error: '無效的角色' }, { status: 400 });
  }

  const existing = await env.DB.prepare(`SELECT id FROM ${ROLE_TABLES[role]} WHERE email = ?`).bind(email).first();
  if (!existing) {
    return Response.json({ error: '無此帳號' }, { status: 400 });
  }

  const code = generateCode();

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
    const row = await env.DB.prepare(
      `SELECT id FROM otp_codes
       WHERE email = ? AND role = ? AND code = ? AND used = 0
         AND expires_at > datetime('now', '+8 hours')
       ORDER BY id DESC LIMIT 1`
    ).bind(email, role, code).first<{ id: number }>();

    if (!row) {
      return Response.json({ error: '驗證碼錯誤或已過期' }, { status: 400 });
    }

    await env.DB.prepare(`UPDATE otp_codes SET used = 1 WHERE id = ?`).bind(row.id).run();
  }

  // No account-creation fallback here: handleOtpRequest already refuses to
  // send a code for an email that isn't in the role's table, so by the time
  // a code is verified the account is guaranteed to already exist.
  const account = await env.DB.prepare(`SELECT id FROM ${ROLE_TABLES[role]} WHERE email = ?`).bind(email).first<{ id: number }>();
  if (!account) {
    return Response.json({ error: '帳號不存在' }, { status: 400 });
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

async function handleAvatarUpload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const role = url.searchParams.get('role') || '';
  const id = Number(url.searchParams.get('id'));

  if (!UPLOAD_ROLES.has(role) || !Number.isInteger(id) || id <= 0) {
    return Response.json({ error: '缺少或無效的 role/id' }, { status: 400 });
  }

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.startsWith('image/')) {
    return Response.json({ error: '檔案格式必須是圖片' }, { status: 400 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_AVATAR_BYTES) {
    return Response.json({ error: '圖片檔案大小不正確' }, { status: 400 });
  }

  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  const key = role === 'course' ? `courses/course-${id}.${ext}` : `avatars/${role}-${id}.${ext}`;

  await env.AVATARS.put(key, body, { httpMetadata: { contentType } });

  await env.DB.prepare(`UPDATE ${AVATAR_ROLE_TABLES[role]} SET photo_path = ? WHERE id = ?`).bind(key, id).run();

  return Response.json({ path: key });
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
};

async function handleCourseUpdate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: '缺少或無效的 id' }, { status: 400 });
  }

  const body = await request.json<CourseBody>();
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

async function handleTeachersList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT * FROM teachers ORDER BY id`).all<TeacherRow>();
  return Response.json(await Promise.all(results.map((row) => teacherRowToJson(env, row))));
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

async function handleTeacherLeaveCreate(request: Request, env: Env, teacherId: number): Promise<Response> {
  const { date } = await request.json<{ date?: string }>();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: '缺少或無效的日期' }, { status: 400 });
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
  const { courseName, totalSessions } = await request.json<{ courseName?: string; totalSessions?: number }>();
  if (!courseName) {
    return Response.json({ error: '缺少課程名稱' }, { status: 400 });
  }
  const course = await env.DB.prepare(`SELECT id, name FROM courses WHERE name = ?`).bind(courseName).first<{ id: number; name: string }>();
  if (!course) {
    return Response.json({ error: '找不到課程' }, { status: 404 });
  }

  const row = await env.DB.prepare(
    `INSERT INTO student_courses (student_id, course_id, total_sessions) VALUES (?, ?, ?) RETURNING *`
  ).bind(studentId, course.id, Number.isInteger(totalSessions) && totalSessions! > 0 ? totalSessions : 16).first<Omit<StudentCourseRow, 'course_name'>>();

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
  student_name: string;
  teacher_name: string;
  course_name: string;
}

function bookingRowToJson(row: BookingRow) {
  return {
    id: row.id,
    bookingCode: row.booking_code,
    studentId: row.student_id,
    studentName: row.student_name,
    courseId: row.course_id,
    course: row.course_name,
    teacherId: row.teacher_id,
    teacher: row.teacher_name,
    date: row.date,
    time: row.time,
    status: row.status,
  };
}

const BOOKING_SELECT = `SELECT b.*, s.name AS student_name, t.name AS teacher_name, c.name AS course_name
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

  const json = results.map(bookingRowToJson);
  if (redactStudentIdentity) {
    for (const b of json) { (b as { studentId?: number }).studentId = undefined; (b as { studentName?: string }).studentName = undefined; }
  }
  return Response.json(json);
}

async function generateBookingCode(env: Env, date: string, time: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE date = ? AND time = ?`).bind(date, time).first<{ n: number }>();
  const seq = String((row?.n ?? 0) + 1).padStart(2, '0');
  return `${date.replace(/-/g, '')}-${time.replace(':', '')}-${seq}`;
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
  return Response.json(bookingRowToJson(created!), { status: 201 });
}

async function handleBookingUpdate(request: Request, env: Env, session: Session, id: number): Promise<Response> {
  const existing = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first<BookingRow>();
  if (!existing) {
    return Response.json({ error: '找不到預約' }, { status: 404 });
  }

  const { status } = await request.json<{ status?: string }>();
  const VALID_STATUSES = new Set(['upcoming', 'attended', 'cancelled', 'absent', 'pending']);
  if (!status || !VALID_STATUSES.has(status)) {
    return Response.json({ error: '缺少或無效的狀態' }, { status: 400 });
  }

  if (session.role === 'student') {
    if (existing.student_id !== session.userId || status !== 'cancelled') {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
  } else if (session.role === 'teacher') {
    if (existing.teacher_id !== session.userId || status !== 'attended') {
      return Response.json({ error: '未授權' }, { status: 401 });
    }
  } // admin: no restriction

  const oldStatus = existing.status;
  await env.DB.prepare(`UPDATE bookings SET status = ? WHERE id = ?`).bind(status, id).run();

  let bookedDelta = 0;
  let attendedDelta = 0;
  if (oldStatus !== 'cancelled' && status === 'cancelled') bookedDelta = -1;
  if (oldStatus === 'cancelled' && status !== 'cancelled') bookedDelta = 1;
  if (oldStatus !== 'attended' && status === 'attended') attendedDelta = 1;
  if (oldStatus === 'attended' && status !== 'attended') attendedDelta = -1;
  if (bookedDelta || attendedDelta) {
    await env.DB.prepare(
      `UPDATE student_courses SET booked_count = booked_count + ?, attended_count = attended_count + ? WHERE id = ?`
    ).bind(bookedDelta, attendedDelta, existing.student_course_id).run();
  }

  const updated = await env.DB.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).bind(id).first<BookingRow>();
  return Response.json(bookingRowToJson(updated!));
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
      return handleTeachersList(env);
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
    // ?teacherId= honored-only-for-admin pattern used for /teacher/* pages.
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
    // Language switch — student or teacher only, always on their own record.
    if (url.pathname === '/api/me/language' && request.method === 'PATCH') {
      const session = await getSession(request, env);
      if (!session || (session.role !== 'student' && session.role !== 'teacher')) {
        return Response.json({ error: '未授權' }, { status: 401 });
      }
      return handleOwnLanguageUpdate(request, env, session);
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

    // Admin also needs into /teacher/* — admin/teacher-detail.html links there
    // (with a ?teacherId= param) to manage a teacher's hours/leave/lessons on
    // their behalf.
    const ALLOWED_SESSION_ROLES: Record<string, readonly string[]> = {
      admin: ['admin'],
      teacher: ['teacher', 'admin'],
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

    return env.ASSETS.fetch(request);
  },
};
