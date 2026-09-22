import { env } from 'cloudflare:workers';
import { describe, it } from 'vitest';
import { fetchWorker, login, SEEDED, withCookie } from './helpers';

const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function uploadInit(cookie: string | null, body: BodyInit = FAKE_JPEG, contentType = 'image/jpeg'): RequestInit {
  const init: RequestInit = { method: 'PUT', headers: { 'Content-Type': contentType }, body };
  return cookie ? withCookie(cookie, init) : init;
}

describe('PUT /api/avatar/upload', () => {
  it('is 401 with no session', async ({ expect }) => {
    const res = await fetchWorker('/api/avatar/upload?role=teacher&id=1', uploadInit(null));
    expect(res.status).toBe(401);
  });

  it('is 401 for a non-admin session (e.g. the teacher whose own photo it is)', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    const res = await fetchWorker('/api/avatar/upload?role=teacher&id=1', uploadInit(cookie));
    expect(res.status).toBe(401);
  });

  it('lets an admin upload a teacher photo and updates photo_path in D1', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/avatar/upload?role=teacher&id=1', uploadInit(cookie));
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path).toBe('avatars/teacher-1.jpg');

    const row = await env.DB.prepare(`SELECT photo_path FROM teachers WHERE id = 1`).first<{ photo_path: string }>();
    expect(row?.photo_path).toBe('avatars/teacher-1.jpg');

    const stored = await env.AVATARS.get(path);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(FAKE_JPEG);
  });

  it('uploads a course cover without touching any D1 row (courses have no table yet)', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/avatar/upload?role=course&id=7', uploadInit(cookie, FAKE_JPEG, 'image/png'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: 'courses/course-7.png' });
  });

  it('rejects an invalid role even for an admin', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/avatar/upload?role=admin&id=1', uploadInit(cookie));
    expect(res.status).toBe(400);
  });

  it('rejects a non-image content type', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/avatar/upload?role=teacher&id=1', uploadInit(cookie, FAKE_JPEG, 'text/plain'));
    expect(res.status).toBe(400);
  });

  it('rejects an empty body', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/avatar/upload?role=teacher&id=1', uploadInit(cookie, new Uint8Array()));
    expect(res.status).toBe(400);
  });
});

describe('/api/recently-viewed', () => {
  it('GET and PUT are both 401 with no session', async ({ expect }) => {
    expect((await fetchWorker('/api/recently-viewed?type=teacher')).status).toBe(401);
    expect((await fetchWorker('/api/recently-viewed?type=teacher', { method: 'PUT' })).status).toBe(401);
  });

  it('GET and PUT are both 401 for a student session', async ({ expect }) => {
    const cookie = await login(SEEDED.student.email, 'student');
    expect((await fetchWorker('/api/recently-viewed?type=teacher', withCookie(cookie))).status).toBe(401);
    expect((await fetchWorker('/api/recently-viewed?type=teacher', withCookie(cookie, { method: 'PUT' }))).status).toBe(401);
  });

  it('an admin marking then listing sees the bump', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const before = Date.now();

    const markRes = await fetchWorker('/api/recently-viewed?type=teacher&id=2', withCookie(cookie, { method: 'PUT' }));
    expect(markRes.status).toBe(200);

    const listRes = await fetchWorker('/api/recently-viewed?type=teacher', withCookie(cookie));
    const map = (await listRes.json()) as Record<string, number>;
    expect(map['2']).toBeGreaterThanOrEqual(before);
  });

  it('re-marking the same entity updates its timestamp instead of erroring', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    await fetchWorker('/api/recently-viewed?type=student&id=1', withCookie(cookie, { method: 'PUT' }));
    const second = await fetchWorker('/api/recently-viewed?type=student&id=1', withCookie(cookie, { method: 'PUT' }));
    expect(second.status).toBe(200);
  });

  it('rejects an invalid type', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/recently-viewed?type=parent&id=1', withCookie(cookie));
    expect(res.status).toBe(400);
  });
});
