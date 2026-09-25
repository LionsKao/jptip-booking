import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, it } from 'vitest';
import { fetchWorker, latestOtpCode, login, requestOtp, SEEDED, verifyOtp, withCookie } from './helpers';

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

  // 回應要跟真的有帳號時一模一樣，不然可以拿來試出哪些 Email 有註冊
  it('answers an unknown email exactly like a known one, but issues no code', async ({ expect }) => {
    const res = await requestOtp('nobody@jptip.co.jp', 'student');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await otpRowCount('nobody@jptip.co.jp', 'student')).toBe(0);
  });

  it('answers a real student email requested under the teacher role the same way, issuing no code', async ({ expect }) => {
    const res = await requestOtp(SEEDED.student.email, 'teacher');
    expect(res.status).toBe(200);
    expect(await otpRowCount(SEEDED.student.email, 'teacher')).toBe(0);
  });

  it('issues no code for a deactivated account', async ({ expect }) => {
    const student = await createStudentAccount({ status: 'inactive' });
    const res = await requestOtp(student.email, 'student');
    expect(res.status).toBe(200);
    expect(await otpRowCount(student.email, 'student')).toBe(0);
  });

  it('a new code invalidates the previous one', async ({ expect }) => {
    const student = await createStudentAccount();
    await requestOtp(student.email, 'student');
    const first = await latestOtpCode(student.email, 'student');
    await requestOtp(student.email, 'student');
    const second = await latestOtpCode(student.email, 'student');
    if (first !== second) expect((await verifyOtp(student.email, 'student', first)).status).toBe(400);
    expect((await verifyOtp(student.email, 'student', second)).status).toBe(200);
  });

  it('accepts a known account and persists a 6-digit code', async ({ expect }) => {
    const res = await requestOtp(SEEDED.teacher.email, 'teacher');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const code = await latestOtpCode(SEEDED.teacher.email, 'teacher');
    expect(code).toMatch(/^\d{6}$/);
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
