import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, it } from 'vitest';
import { fetchWorker, latestOtpCode, requestOtp, SEEDED, verifyOtp } from './helpers';

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

  it('rejects an email with no matching account for that role', async ({ expect }) => {
    const res = await requestOtp('nobody@jptip.co.jp', 'student');
    expect(res.status).toBe(400);
  });

  it('rejects a real student email requested under the teacher role', async ({ expect }) => {
    const res = await requestOtp(SEEDED.student.email, 'teacher');
    expect(res.status).toBe(400);
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
