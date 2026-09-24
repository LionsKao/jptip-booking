import { env } from 'cloudflare:workers';
import { describe, it } from 'vitest';
import { fetchWorker, login, SEEDED, withCookie } from './helpers';

const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function patchProfile(cookie: string | null, body: unknown): Promise<Response> {
  const init: RequestInit = { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  return fetchWorker('/api/me/profile', cookie ? withCookie(cookie, init) : init);
}

function uploadOwnAvatar(cookie: string | null): Promise<Response> {
  const init: RequestInit = { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: FAKE_JPEG };
  return fetchWorker('/api/me/avatar', cookie ? withCookie(cookie, init) : init);
}

describe('PATCH /api/me/profile', () => {
  it('is 401 with no session or for an admin', async ({ expect }) => {
    expect((await patchProfile(null, { phone: '0912345678' })).status).toBe(401);
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    expect((await patchProfile(adminCookie, { phone: '0912345678' })).status).toBe(401);
  });

  it('lets a student change their phone, timezone and animal avatar on their own row', async ({ expect }) => {
    const cookie = await login(SEEDED.student.email, 'student');
    const res = await patchProfile(cookie, { phone: '0912-345-678', timezone: 'UTC+09:00 大阪、札幌、東京', avatar: '010-cat.png' });
    expect(res.status).toBe(200);
    const me = (await res.json()) as Record<string, unknown>;
    expect(me.email).toBe(SEEDED.student.email);
    expect(me.phone).toBe('0912345678');
    expect(me.timezone).toBe('UTC+09:00 大阪、札幌、東京');
    expect(me.avatar).toBe('010-cat.png');
  });

  it('refuses fields a student may not change themselves', async ({ expect }) => {
    const cookie = await login(SEEDED.student.email, 'student');
    for (const body of [{ name: '改名' }, { email: 'x@example.com' }, { teamsLink: 'https://x' }, { status: 'inactive' }, { specialty: '日文' }]) {
      expect((await patchProfile(cookie, body)).status).toBe(400);
    }
  });

  it('refuses a blank student phone, an unknown timezone, and an avatar that is not a bundled animal', async ({ expect }) => {
    const cookie = await login(SEEDED.student.email, 'student');
    expect((await patchProfile(cookie, { phone: '' })).status).toBe(400);
    expect((await patchProfile(cookie, { timezone: 'UTC+05:00 Somewhere' })).status).toBe(400);
    expect((await patchProfile(cookie, { avatar: 'avatars/teacher-1-1.jpg' })).status).toBe(400);
    expect((await patchProfile(cookie, { avatar: 'data:image/png;base64,AAAA' })).status).toBe(400);
  });

  it('lets a teacher change specialty/motto, and sets the timezone inside the receipt without touching the rest of it', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const list = (await (await fetchWorker('/api/teachers', withCookie(adminCookie))).json()) as Record<string, unknown>[];
    const teacher1 = list.find((t) => t.email === SEEDED.teacher.email)!;
    await fetchWorker(`/api/teachers?id=${teacher1.id}`, withCookie(adminCookie, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt: { timezone: 'UTC+08:00 台北', wage: '3000', bankAccountNo: '1234567' } }),
    }));

    const cookie = await login(SEEDED.teacher.email, 'teacher');
    const res = await patchProfile(cookie, { specialty: ' 日文會話 ', motto: '一緒に学びましょう', timezone: 'UTC+06:30 仰光' });
    expect(res.status).toBe(200);
    const me = (await res.json()) as Record<string, unknown>;
    expect(me.specialty).toBe('日文會話');
    expect(me.motto).toBe('一緒に学びましょう');
    expect(me.receipt).toEqual({ timezone: 'UTC+06:30 仰光', wage: '3000', bankAccountNo: '1234567' });
  });

  it('refuses the receipt and other admin-managed fields for a teacher', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    for (const body of [{ receipt: { wage: '9999' } }, { name: '改名' }, { status: 'active' }, { courses: [] }]) {
      expect((await patchProfile(cookie, body)).status).toBe(400);
    }
  });
});

describe('PUT /api/me/avatar', () => {
  it('is 401 with no session or for an admin', async ({ expect }) => {
    expect((await uploadOwnAvatar(null)).status).toBe(401);
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    expect((await uploadOwnAvatar(adminCookie)).status).toBe(401);
  });

  it('stores the photo under the logged-in user, and switching back to an animal deletes it', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    const me = (await (await fetchWorker('/api/teachers/me', withCookie(cookie))).json()) as { id: number };

    const res = await uploadOwnAvatar(cookie);
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path).toMatch(new RegExp(`^avatars/teacher-${me.id}-\\d+\\.jpg$`));
    expect(await env.AVATARS.get(path)).not.toBeNull();

    const patched = (await (await patchProfile(cookie, { avatar: '001-bear.png' })).json()) as { avatar: string };
    expect(patched.avatar).toBe('001-bear.png');
    expect(await env.AVATARS.get(path)).toBeNull();
  });
});
