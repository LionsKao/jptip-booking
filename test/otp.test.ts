import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, it, vi } from 'vitest';
import { fetchWorker, latestOtpCode, login, mockGraph, requestOtp, SEEDED, verifyOtp, withCookie } from './helpers';

// 把這個帳號既有的驗證碼申請時間往前推，模擬「已經過了一段時間」（申請頻率限制是看建立時間）
async function backdateOtpRequests(email: string, role: string, seconds: number): Promise<void> {
  await env.DB.prepare(`UPDATE otp_codes SET created_at = datetime(created_at, ?) WHERE email = ? AND role = ?`).bind(`-${seconds} seconds`, email, role).run();
}

async function otpRowCount(email: string, role: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM otp_codes WHERE email = ? AND role = ?`).bind(email, role).first<{ n: number }>();
  return row?.n ?? 0;
}

// 暴力猜碼的測試會把帳號鎖住，所以每個測試用自己新建的學生帳號，不影響其他測試用的種子帳號
async function createStudentAccount(overrides: Record<string, unknown> = {}): Promise<{ id: number; email: string }> {
  const adminCookie = await login(SEEDED.admin.email, 'admin');
  const email = `otp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await fetchWorker('/api/students', withCookie(adminCookie, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'OTP 測試', email, ...overrides }),
  }));
  return (await res.json()) as { id: number; email: string };
}

afterEach(() => {
  env.ALLOW_ANY_OTP = 'false';
  env.MS_CLIENT_SECRET = '';
  vi.restoreAllMocks();
});

describe('POST /api/otp/request', () => {
  it('rejects an invalid email format', async ({ expect }) => {
    const res = await requestOtp('not-an-email', 'student');
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('rejects an invalid role', async ({ expect }) => {
    const res = await requestOtp(SEEDED.student.email, 'principal');
    expect(res.status).toBe(400);
  });

  // 沒有帳號直接告訴使用者（打錯 Email 或選錯身分），不發驗證碼
  it('tells the user there is no such account, and issues no code', async ({ expect }) => {
    const res = await requestOtp('nobody@jptip.co.jp', 'student');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'accountNotFound' });
    expect(await otpRowCount('nobody@jptip.co.jp', 'student')).toBe(0);
  });

  it('treats a real student email requested under the teacher role as no account', async ({ expect }) => {
    const res = await requestOtp(SEEDED.student.email, 'teacher');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'accountNotFound' });
    expect(await otpRowCount(SEEDED.student.email, 'teacher')).toBe(0);
  });

  it('tells a deactivated account it is not active yet, and issues no code', async ({ expect }) => {
    const student = await createStudentAccount({ status: 'inactive' });
    const res = await requestOtp(student.email, 'student');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'accountInactive' });
    expect(await otpRowCount(student.email, 'student')).toBe(0);
  });

  it('a new code invalidates the previous one', async ({ expect }) => {
    const student = await createStudentAccount();
    await requestOtp(student.email, 'student');
    const first = await latestOtpCode(student.email, 'student');
    await backdateOtpRequests(student.email, 'student', 31);
    await requestOtp(student.email, 'student');
    const second = await latestOtpCode(student.email, 'student');
    if (first !== second) expect((await verifyOtp(student.email, 'student', first)).status).toBe(400);
    expect((await verifyOtp(student.email, 'student', second)).status).toBe(200);
  });

  it('refuses a repeat request within 30 seconds, telling the client how long to wait', async ({ expect }) => {
    const student = await createStudentAccount();
    expect((await requestOtp(student.email, 'student')).status).toBe(200);
    const again = await requestOtp(student.email, 'student');
    expect(again.status).toBe(429);
    const { retryAfter } = (await again.json()) as { retryAfter: number };
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(30);
    await backdateOtpRequests(student.email, 'student', 31);
    expect((await requestOtp(student.email, 'student')).status).toBe(200);
  });

  it('caps unverified requests at 5 per hour', async ({ expect }) => {
    const student = await createStudentAccount();
    for (let i = 0; i < 5; i++) {
      expect((await requestOtp(student.email, 'student')).status).toBe(200);
      await backdateOtpRequests(student.email, 'student', 31);
    }
    const capped = await requestOtp(student.email, 'student');
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { retryAfter?: number }).retryAfter).toBeUndefined();
  });

  it('a request that led to a successful login does not count toward the limits', async ({ expect }) => {
    const student = await createStudentAccount();
    for (let i = 0; i < 8; i++) {
      expect((await requestOtp(student.email, 'student')).status).toBe(200);
      expect((await verifyOtp(student.email, 'student', await latestOtpCode(student.email, 'student'))).status).toBe(200);
    }
  });

  it('accepts a known account and persists a 6-digit code', async ({ expect }) => {
    const res = await requestOtp(SEEDED.teacher.email, 'teacher');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const code = await latestOtpCode(SEEDED.teacher.email, 'teacher');
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe('verification email via Microsoft Graph', () => {
  it("sends the code from the sender mailbox to the account's address, in the account's language", async ({ expect }) => {
    const student = await createStudentAccount();
    await env.DB.prepare(`UPDATE students SET language = 'ja' WHERE id = ?`).bind(student.id).run();
    env.MS_CLIENT_SECRET = 'test-secret';
    const calls = mockGraph();

    const res = await requestOtp(student.email, 'student');
    expect(res.status).toBe(200);
    const code = await latestOtpCode(student.email, 'student');

    const token = calls.find((c) => c.url.startsWith('https://login.microsoftonline.com/'))!;
    expect(new URLSearchParams(token.body).get('grant_type')).toBe('client_credentials');
    expect(new URLSearchParams(token.body).get('client_secret')).toBe('test-secret');

    const send = calls.find((c) => c.url.startsWith('https://graph.microsoft.com/'))!;
    expect(send.url).toBe('https://graph.microsoft.com/v1.0/users/one-on-one%40jptip.co.jp/sendMail');
    expect(send.auth).toBe('Bearer test-token');
    const mail = JSON.parse(send.body) as { message: { subject: string; body: { content: string }; toRecipients: { emailAddress: { address: string } }[] } };
    expect(mail.message.toRecipients).toEqual([{ emailAddress: { address: student.email } }]);
    expect(mail.message.subject).toBe('🔑 ログイン認証コード');
    expect(mail.message.body.content).toContain(code);
    // 寄件備份要留著：共用信箱的寄件備份就是寄信紀錄
    expect((JSON.parse(send.body) as { saveToSentItems: boolean }).saveToSentItems).toBe(true);
  });

  // 本機寄出的信標題加上「[測試]」，在共用信箱的寄件備份裡跟正式寄出的信分得出來
  it('prefixes the subject with [測試] only when sent from localhost', async ({ expect }) => {
    const student = await createStudentAccount();
    env.MS_CLIENT_SECRET = 'test-secret';
    const calls = mockGraph();
    const subjects: string[] = [];
    for (const origin of ['http://localhost:12345', 'https://example.com']) {
      await backdateOtpRequests(student.email, 'student', 31);
      const res = await exports.default.fetch(`${origin}/api/otp/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: student.email, role: 'student' }),
      });
      expect(res.status).toBe(200);
      const send = calls.filter((c) => c.url.startsWith('https://graph.microsoft.com/')).at(-1)!;
      subjects.push((JSON.parse(send.body) as { message: { subject: string } }).message.subject);
    }
    expect(subjects).toEqual(['[測試] 🔑 您的登入驗證碼', '🔑 您的登入驗證碼']);
  });

  it('reports a send failure and voids the code that never reached the user', async ({ expect }) => {
    const student = await createStudentAccount();
    env.MS_CLIENT_SECRET = 'test-secret';
    mockGraph(500);
    const res = await requestOtp(student.email, 'student');
    expect(res.status).toBe(502);
    const row = await env.DB.prepare(`SELECT used FROM otp_codes WHERE email = ? ORDER BY id DESC LIMIT 1`).bind(student.email).first<{ used: number }>();
    expect(row?.used).toBe(1);
  });

  it('sends nothing for an unknown email', async ({ expect }) => {
    env.MS_CLIENT_SECRET = 'test-secret';
    const calls = mockGraph();
    expect((await requestOtp(`nobody-mail-${Date.now()}@example.com`, 'student')).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /api/otp/verify', () => {
  it('rejects missing fields', async ({ expect }) => {
    const res = await fetchWorker('/api/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SEEDED.student.email }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a wrong code', async ({ expect }) => {
    await requestOtp(SEEDED.student.email, 'student');
    const res = await verifyOtp(SEEDED.student.email, 'student', '000000');
    expect(res.status).toBe(400);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('rejects a code that was never requested', async ({ expect }) => {
    const res = await verifyOtp('nobody@jptip.co.jp', 'student', '123456');
    expect(res.status).toBe(400);
  });

  it('accepts the correct code, sets a session cookie, and rejects reusing it', async ({ expect }) => {
    await requestOtp(SEEDED.admin.email, 'admin');
    const code = await latestOtpCode(SEEDED.admin.email, 'admin');

    const res = await verifyOtp(SEEDED.admin.email, 'admin', code);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie');
    // fetchWorker's requests are all https://, matching the real deployment
    // (see the separate http:// case below for local wrangler dev's cookie).
    expect(setCookie).toMatch(/^session=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+/);

    const replay = await verifyOtp(SEEDED.admin.email, 'admin', code);
    expect(replay.status).toBe(400);
  });

  it('writes a sessions row with the right role/user_id/email', async ({ expect }) => {
    await requestOtp(SEEDED.teacher.email, 'teacher');
    const code = await latestOtpCode(SEEDED.teacher.email, 'teacher');
    await verifyOtp(SEEDED.teacher.email, 'teacher', code);

    const row = await env.DB.prepare(
      `SELECT role, user_id, email FROM sessions WHERE email = ? ORDER BY rowid DESC LIMIT 1`
    ).bind(SEEDED.teacher.email).first<{ role: string; user_id: number; email: string }>();
    expect(row).toEqual({ role: 'teacher', user_id: 1, email: SEEDED.teacher.email });
  });

  it('omits Secure on the cookie for a plain-http request (local wrangler dev)', async ({ expect }) => {
    await requestOtp(SEEDED.student.email, 'student');
    const code = await latestOtpCode(SEEDED.student.email, 'student');
    const res = await exports.default.fetch('http://localhost:12345/api/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SEEDED.student.email, role: 'student', code }),
    });
    expect(res.headers.get('Set-Cookie')).not.toContain('Secure');
  });

  it('burns a code after 5 wrong tries, so even the right code no longer works', async ({ expect }) => {
    const student = await createStudentAccount();
    await requestOtp(student.email, 'student');
    const code = await latestOtpCode(student.email, 'student');
    const wrong = code === '100000' ? '100001' : '100000';
    for (let i = 0; i < 5; i++) {
      expect((await verifyOtp(student.email, 'student', wrong)).status).toBe(400);
    }
    expect((await verifyOtp(student.email, 'student', code)).status).toBe(400);
  });

  it('caps parallel guesses at 5 per code (the try is claimed atomically before comparing)', async ({ expect }) => {
    const student = await createStudentAccount();
    await requestOtp(student.email, 'student');
    const code = await latestOtpCode(student.email, 'student');
    const wrong = code === '100000' ? '100001' : '100000';
    await Promise.all(Array.from({ length: 20 }, () => verifyOtp(student.email, 'student', wrong)));
    const row = await env.DB.prepare(`SELECT attempts, used FROM otp_codes WHERE email = ? ORDER BY id DESC LIMIT 1`).bind(student.email).first<{ attempts: number; used: number }>();
    expect(row).toEqual({ attempts: 5, used: 1 });
  });

  it('locks verification for the account after 10 wrong tries within an hour, even with a fresh correct code', async ({ expect }) => {
    const student = await createStudentAccount();
    for (let round = 0; round < 2; round++) {
      await requestOtp(student.email, 'student');
      const code = await latestOtpCode(student.email, 'student');
      const wrong = code === '100000' ? '100001' : '100000';
      for (let i = 0; i < 5; i++) await verifyOtp(student.email, 'student', wrong);
      await backdateOtpRequests(student.email, 'student', 31);
    }
    await requestOtp(student.email, 'student');
    const fresh = await latestOtpCode(student.email, 'student');
    const res = await verifyOtp(student.email, 'student', fresh);
    expect(res.status).toBe(429);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('a successful login does not count toward the lockout', async ({ expect }) => {
    const student = await createStudentAccount();
    for (let i = 0; i < 12; i++) {
      await requestOtp(student.email, 'student');
      const code = await latestOtpCode(student.email, 'student');
      expect((await verifyOtp(student.email, 'student', code)).status).toBe(200);
    }
  });

  it('deactivating an account logs it out everywhere and blocks a code issued before deactivation', async ({ expect }) => {
    const student = await createStudentAccount();
    const cookie = await login(student.email, 'student');
    expect((await fetchWorker('/api/students/me', withCookie(cookie))).status).toBe(200);
    await requestOtp(student.email, 'student');
    const pending = await latestOtpCode(student.email, 'student');

    const adminCookie = await login(SEEDED.admin.email, 'admin');
    await fetchWorker(`/api/students?id=${student.id}`, withCookie(adminCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'inactive' }),
    }));

    expect((await fetchWorker('/api/students/me', withCookie(cookie))).status).toBe(401);
    expect((await verifyOtp(student.email, 'student', pending)).status).toBe(400);
  });

  describe('ALLOW_ANY_OTP dev bypass', () => {
    it('is off by default: an unrequested code is still rejected', async ({ expect }) => {
      const res = await verifyOtp(SEEDED.student.email, 'student', '654321');
      expect(res.status).toBe(400);
    });

    it('accepts any 6-digit code once enabled', async ({ expect }) => {
      env.ALLOW_ANY_OTP = 'true';
      const res = await verifyOtp(SEEDED.student.email, 'student', '999999');
      expect(res.status).toBe(200);
      expect(res.headers.get('Set-Cookie')).toBeTruthy();
    });

    it('still rejects a non-6-digit value even when enabled', async ({ expect }) => {
      env.ALLOW_ANY_OTP = 'true';
      const res = await verifyOtp(SEEDED.student.email, 'student', 'abcdef');
      expect(res.status).toBe(400);
    });

    it('still refuses an unknown account even when enabled', async ({ expect }) => {
      env.ALLOW_ANY_OTP = 'true';
      const res = await verifyOtp('nobody@jptip.co.jp', 'student', '111111');
      expect(res.status).toBe(400);
    });
  });
});
