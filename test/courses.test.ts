import { describe, it } from 'vitest';
import { fetchWorker, login, SEEDED, withCookie } from './helpers';

async function createCourse(cookie: string, overrides: Record<string, unknown> = {}) {
  return fetchWorker('/api/courses', withCookie(cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'N5 綜合日本語 J1', ...overrides }),
  }));
}

describe('GET /api/courses', () => {
  it('is 401 with no session', async ({ expect }) => {
    const res = await fetchWorker('/api/courses');
    expect(res.status).toBe(401);
  });

  it('is reachable by any logged-in role, not just admin', async ({ expect }) => {
    const studentCookie = await login(SEEDED.student.email, 'student');
    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    expect((await fetchWorker('/api/courses', withCookie(studentCookie))).status).toBe(200);
    expect((await fetchWorker('/api/courses', withCookie(teacherCookie))).status).toBe(200);
  });

  it('starts empty and lists what was created', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    expect(await (await fetchWorker('/api/courses', withCookie(cookie))).json()).toEqual([]);

    await createCourse(cookie);
    const list = (await (await fetchWorker('/api/courses', withCookie(cookie))).json()) as unknown[];
    expect(list).toHaveLength(1);
  });
});

describe('POST /api/courses', () => {
  it('is 401 for a non-admin session', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    const res = await createCourse(cookie);
    expect(res.status).toBe(401);
  });

  it('rejects an empty name', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await createCourse(cookie, { name: '   ' });
    expect(res.status).toBe(400);
  });

  it('creates a course with sensible defaults for everything else', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await createCourse(cookie);
    expect(res.status).toBe(201);
    const course = (await res.json()) as Record<string, unknown>;
    expect(course).toMatchObject({
      name: 'N5 綜合日本語 J1',
      description: '',
      image: null,
      status: 'active',
      durationMinutes: 100,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 20,
      scheduleIncrement: '1 小時',
      minLeadHours: 48,
      maxLeadDays: 30,
      defaultSessions: 16,
      reminderHoursBefore: 24,
    });
    expect(course.id).toEqual(expect.any(Number));
  });

  it('accepts an explicit image (the built-in random-avatar picker, not an R2 upload)', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await createCourse(cookie, { image: '017-dog.png', status: 'inactive' });
    const course = (await res.json()) as Record<string, unknown>;
    expect(course.image).toBe('017-dog.png');
    expect(course.status).toBe('inactive');
  });
});

describe('PATCH /api/courses', () => {
  it('is 401 for a non-admin session', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const created = (await (await createCourse(adminCookie)).json()) as { id: number };

    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    const res = await fetchWorker(`/api/courses?id=${created.id}`, withCookie(teacherCookie, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hijacked' }),
    }));
    expect(res.status).toBe(401);
  });

  it('is 404 for a course that does not exist', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/courses?id=999999', withCookie(cookie, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    }));
    expect(res.status).toBe(404);
  });

  it('rejects an empty body (nothing to update)', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const created = (await (await createCourse(cookie)).json()) as { id: number };
    const res = await fetchWorker(`/api/courses?id=${created.id}`, withCookie(cookie, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
  });

  it('updates only the fields provided, leaving the rest untouched', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const created = (await (await createCourse(cookie)).json()) as Record<string, unknown> & { id: number };

    // Mirrors course-detail.html's "basic info" form: name/description/image/status only.
    const basicRes = await fetchWorker(`/api/courses?id=${created.id}`, withCookie(cookie, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  N5 綜合日本語 J1（改）  ', status: 'inactive' }),
    }));
    const afterBasic = (await basicRes.json()) as Record<string, unknown>;
    expect(afterBasic.name).toBe('N5 綜合日本語 J1（改）');
    expect(afterBasic.status).toBe('inactive');
    expect(afterBasic.durationMinutes).toBe(created.durationMinutes);

    // Mirrors the separate "schedule/booking rules" form.
    const scheduleRes = await fetchWorker(`/api/courses?id=${created.id}`, withCookie(cookie, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationMinutes: 60, minLeadHours: 24, reminderHoursBefore: 12 }),
    }));
    const afterSchedule = (await scheduleRes.json()) as Record<string, unknown>;
    expect(afterSchedule.durationMinutes).toBe(60);
    expect(afterSchedule.minLeadHours).toBe(24);
    expect(afterSchedule.reminderHoursBefore).toBe(12);
    // Untouched by either PATCH — proves this really is a partial update.
    expect(afterSchedule.name).toBe('N5 綜合日本語 J1（改）');
  });

  it('updates defaultSessions, and only accepts a whole number from 1 to 999', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const course = (await (await createCourse(cookie, { name: '堂數測試課程' })).json()) as { id: number };
    const patch = (body: unknown) => fetchWorker(`/api/courses?id=${course.id}`, withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));

    for (const bad of [0, -1, 1000, 2.5, '8', null]) {
      expect((await patch({ defaultSessions: bad })).status).toBe(400);
    }
    const res = await patch({ defaultSessions: 8 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).defaultSessions).toBe(8);
  });
});
