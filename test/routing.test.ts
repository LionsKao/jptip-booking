import { env } from 'cloudflare:workers';
import { afterEach, describe, it } from 'vitest';
import { fetchWorker, login, SEEDED, withCookie } from './helpers';

// This suite uses the per-test `expect` from the test context (not a
// vitest global), so the shared assertion takes it as a parameter.
function expectRedirectHome(expect: (actual: unknown) => any, res: Response) {
  expect(res.status).toBe(302);
  expect(res.headers.get('Location')).toBe('https://example.com/');
}

describe('static page role gating', () => {
  it('/admin/ with no session redirects home', async ({ expect }) => {
    const res = await fetchWorker('/admin/', { redirect: 'manual' });
    expectRedirectHome(expect, res);
  });

  it('/admin/ with a student session redirects home', async ({ expect }) => {
    const cookie = await login(SEEDED.student.email, 'student');
    const res = await fetchWorker('/admin/', withCookie(cookie, { redirect: 'manual' }));
    expectRedirectHome(expect, res);
  });

  it('/admin/ with an admin session is not redirected', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/admin/', withCookie(cookie, { redirect: 'manual' }));
    expect(res.status).not.toBe(302);
  });

  it('/student/booking.html with a teacher session redirects home', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    const res = await fetchWorker('/student/booking.html', withCookie(cookie, { redirect: 'manual' }));
    expectRedirectHome(expect, res);
  });

  it('/teacher/hours.html with a teacher session is not redirected', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    const res = await fetchWorker('/teacher/hours.html', withCookie(cookie, { redirect: 'manual' }));
    expect(res.status).not.toBe(302);
  });

  it('/teacher/hours.html with a student session redirects home', async ({ expect }) => {
    const cookie = await login(SEEDED.student.email, 'student');
    const res = await fetchWorker('/teacher/hours.html', withCookie(cookie, { redirect: 'manual' }));
    expectRedirectHome(expect, res);
  });

  it('/teacher/hours with an admin session redirects home (admins use /admin/teacher-hours instead)', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/teacher/hours', withCookie(cookie, { redirect: 'manual' }));
    expectRedirectHome(expect, res);
  });

  for (const [alias, marker] of [
    ['/admin/teacher-hours', 'hours-add-btn'],
    ['/admin/teacher-lessons', 'lessons-timezone-note'],
    ['/admin/teacher-leave', 'leaveConfirmModal'],
  ] as const) {
    it(`${alias} serves the shared teacher page to an admin`, async ({ expect }) => {
      const cookie = await login(SEEDED.admin.email, 'admin');
      const res = await fetchWorker(`${alias}?id=1`, withCookie(cookie, { redirect: 'manual' }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(marker);
    });

    it(`${alias} with a teacher session redirects home`, async ({ expect }) => {
      const cookie = await login(SEEDED.teacher.email, 'teacher');
      const res = await fetchWorker(`${alias}?id=1`, withCookie(cookie, { redirect: 'manual' }));
      expectRedirectHome(expect, res);
    });
  }

  it('/ (the login page) is never gated', async ({ expect }) => {
    const res = await fetchWorker('/', { redirect: 'manual' });
    expect(res.status).not.toBe(302);
  });
});

describe('dev-only pages (email.html / ui.html)', () => {
  afterEach(() => {
    env.ALLOW_ANY_OTP = 'false';
  });

  it('email.html is 404 when ALLOW_ANY_OTP is unset (production)', async ({ expect }) => {
    const res = await fetchWorker('/email.html');
    expect(res.status).toBe(404);
  });

  it('ui.html is 404 when ALLOW_ANY_OTP is unset (production)', async ({ expect }) => {
    const res = await fetchWorker('/ui.html');
    expect(res.status).toBe(404);
  });

  it('email.html is reachable when ALLOW_ANY_OTP=true (local/test)', async ({ expect }) => {
    env.ALLOW_ANY_OTP = 'true';
    const res = await fetchWorker('/email.html');
    expect(res.status).not.toBe(404);
  });

  it('is not gated by session — no login needed either way', async ({ expect }) => {
    env.ALLOW_ANY_OTP = 'true';
    const res = await fetchWorker('/ui.html');
    expect(res.status).not.toBe(404);
  });
});

describe('security headers', () => {
  it('adds anti-framing, nosniff and referrer headers to Worker responses (APIs and gated pages)', async ({ expect }) => {
    for (const path of ['/api/config', '/admin/students.html']) {
      const res = await fetchWorker(path, { redirect: 'manual' });
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    }
  });
});
