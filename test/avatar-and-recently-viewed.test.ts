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
    expect(path).toMatch(/^avatars\/teacher-1-\d+\.jpg$/);

    const row = await env.DB.prepare(`SELECT photo_path FROM teachers WHERE id = 1`).first<{ photo_path: string }>();
    expect(row?.photo_path).toBe(path);

    const stored = await env.AVATARS.get(path);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(FAKE_JPEG);
  });

  it('uploads a course cover and updates the course row\'s photo_path in D1', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const created = await fetchWorker('/api/courses', withCookie(cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'N5 綜合日本語 J1' }),
    })).then((res) => res.json() as Promise<{ id: number }>);

    const res = await fetchWorker(`/api/avatar/upload?role=course&id=${created.id}`, uploadInit(cookie, FAKE_JPEG, 'image/png'));
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path).toMatch(new RegExp(`^courses/course-${created.id}-\\d+\\.png$`));

    const row = await env.DB.prepare(`SELECT photo_path FROM courses WHERE id = ?`).bind(created.id).first<{ photo_path: string }>();
    expect(row?.photo_path).toBe(path);
  });

  it('gives every upload a fresh key (the served image is cached as immutable) and deletes the replaced one', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const first = ((await (await fetchWorker('/api/avatar/upload?role=teacher&id=1', uploadInit(cookie))).json()) as { path: string }).path;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = ((await (await fetchWorker('/api/avatar/upload?role=teacher&id=1', uploadInit(cookie))).json()) as { path: string }).path;
    expect(second).not.toBe(first);
    expect(await env.AVATARS.get(first)).toBeNull();
    expect(await env.AVATARS.get(second)).not.toBeNull();
  });

  it('rejects an invalid role even for an admin', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/avatar/upload?role=admin&id=1', uploadInit(cookie));
    expect(res.status).toBe(400);
  });

  it('rejects SVG (an image/* type that can carry script) and accepts JPEG/PNG/WebP only', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await fetchWorker('/api/avatar/upload?role=teacher&id=1', uploadInit(cookie, svg, 'image/svg+xml'))).status).toBe(400);
    expect((await fetchWorker('/api/avatar/upload?role=teacher&id=1', uploadInit(cookie, FAKE_JPEG, 'image/gif'))).status).toBe(400);
    const webp = await fetchWorker('/api/avatar/upload?role=teacher&id=1', uploadInit(cookie, FAKE_JPEG, 'image/webp'));
    expect(webp.status).toBe(200);
    expect(((await webp.json()) as { path: string }).path).toMatch(/\.webp$/);

    const studentCookie = await login(SEEDED.student.email, 'student');
    expect((await fetchWorker('/api/me/avatar', uploadInit(studentCookie, svg, 'image/svg+xml'))).status).toBe(400);
  });

  it('serves uploaded images with nosniff and a sandboxing CSP, so nothing in them can run', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const { path } = (await (await fetchWorker('/api/avatar/upload?role=teacher&id=1', uploadInit(cookie))).json()) as { path: string };
    const res = await fetchWorker(`/${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
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
