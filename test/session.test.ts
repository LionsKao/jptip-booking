import { env } from 'cloudflare:workers';
import { it } from 'vitest';
import { fetchWorker, login, SEEDED, withCookie } from './helpers';

it('GET /api/session is 401 with no cookie', async ({ expect }) => {
  const res = await fetchWorker('/api/session');
  expect(res.status).toBe(401);
});

it('GET /api/session is 401 with a garbage cookie', async ({ expect }) => {
  const res = await fetchWorker('/api/session', withCookie('session=not-a-real-token'));
  expect(res.status).toBe(401);
});

it('GET /api/session returns the logged-in identity', async ({ expect }) => {
  const cookie = await login(SEEDED.student.email, 'student');
  const res = await fetchWorker('/api/session', withCookie(cookie));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ role: 'student', userId: 1, email: SEEDED.student.email });
});

it('POST /api/logout clears the session so it can no longer be used', async ({ expect }) => {
  const cookie = await login(SEEDED.teacher.email, 'teacher');
  expect((await fetchWorker('/api/session', withCookie(cookie))).status).toBe(200);

  const logoutRes = await fetchWorker('/api/logout', withCookie(cookie, { method: 'POST' }));
  expect(logoutRes.status).toBe(200);
  expect(logoutRes.headers.get('Set-Cookie')).toContain('Max-Age=0');

  const after = await fetchWorker('/api/session', withCookie(cookie));
  expect(after.status).toBe(401);
});

it('logout deletes the row from D1, not just the cookie', async ({ expect }) => {
  const cookie = await login(SEEDED.admin.email, 'admin');
  const token = cookie.split('=')[1];
  await fetchWorker('/api/logout', withCookie(cookie, { method: 'POST' }));

  const row = await env.DB.prepare(`SELECT token FROM sessions WHERE token = ?`).bind(token).first();
  expect(row).toBeNull();
});

it('logout is a no-op (not an error) when there is no session cookie', async ({ expect }) => {
  const res = await fetchWorker('/api/logout', { method: 'POST' });
  expect(res.status).toBe(200);
});
