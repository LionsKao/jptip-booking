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

// Only these two roles have a `photo_path` column (see migrations 0004 / 0007).
// 'course' has no D1 table at all yet (courses are still frontend-mock), so it
// just skips the D1 write below — the R2 object is still the source of truth.
const AVATAR_ROLE_TABLES: Record<string, string> = {
  student: 'students',
  teacher: 'teachers',
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

  // Best-effort: the admin UI's mock records don't always have a matching real
  // D1 row yet (student/teacher CRUD is still frontend-only, courses have no
  // table at all), so a no-op here is expected and fine — the R2 object is
  // still the source of truth for the path.
  const table = AVATAR_ROLE_TABLES[role];
  if (table) {
    await env.DB.prepare(`UPDATE ${table} SET photo_path = ? WHERE id = ?`).bind(key, id).run();
  }

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
