export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
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
  return Response.json({ ok: true });
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

    return env.ASSETS.fetch(request);
  },
};
