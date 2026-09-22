import { describe, it } from 'vitest';
import { fetchWorker, login, SEEDED, withCookie } from './helpers';

async function createTeacher(cookie: string, overrides: Record<string, unknown> = {}) {
  return fetchWorker('/api/teachers', withCookie(cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '新老師', email: `new-teacher-${Date.now()}@example.com`, ...overrides }),
  }));
}

describe('GET /api/teachers', () => {
  it('is 401 with no session', async ({ expect }) => {
    const res = await fetchWorker('/api/teachers');
    expect(res.status).toBe(401);
  });

  it('is reachable by any logged-in role, not just admin', async ({ expect }) => {
    const studentCookie = await login(SEEDED.student.email, 'student');
    expect((await fetchWorker('/api/teachers', withCookie(studentCookie))).status).toBe(200);
  });

  it('lists seeded teachers with an empty courses array by default', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const list = (await (await fetchWorker('/api/teachers', withCookie(cookie))).json()) as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(0);
    const teacher1 = list.find((t) => t.email === SEEDED.teacher.email)!;
    expect(teacher1.courses).toEqual([]);
    expect(teacher1.status).toBe('active');
  });
});

describe('POST /api/teachers', () => {
  it('is 401 for a non-admin session', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    const res = await createTeacher(cookie);
    expect(res.status).toBe(401);
  });

  it('rejects a missing name or invalid email', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    expect((await createTeacher(cookie, { name: '' })).status).toBe(400);
    expect((await createTeacher(cookie, { email: 'not-an-email' })).status).toBe(400);
  });

  it('rejects a duplicate email', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await createTeacher(cookie, { email: SEEDED.teacher.email });
    expect(res.status).toBe(400);
  });

  it('creates a teacher with sensible defaults', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await createTeacher(cookie);
    expect(res.status).toBe(201);
    const teacher = (await res.json()) as Record<string, unknown>;
    expect(teacher.status).toBe('inactive');
    expect(teacher.courses).toEqual([]);
    expect(teacher.receipt).toBeNull();
    expect(teacher.id).toEqual(expect.any(Number));
  });
});

describe('PATCH /api/teachers', () => {
  it('is 401 for a non-admin session', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const created = (await (await createTeacher(adminCookie)).json()) as { id: number };
    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    const res = await fetchWorker(`/api/teachers?id=${created.id}`, withCookie(teacherCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'hijacked' }),
    }));
    expect(res.status).toBe(401);
  });

  it('is 404 for a teacher that does not exist', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/teachers?id=999999', withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    }));
    expect(res.status).toBe(404);
  });

  it('updates only the fields provided', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const created = (await (await createTeacher(cookie)).json()) as Record<string, unknown> & { id: number };

    const res = await fetchWorker(`/api/teachers?id=${created.id}`, withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active', specialty: '會話' }),
    }));
    const updated = (await res.json()) as Record<string, unknown>;
    expect(updated.status).toBe('active');
    expect(updated.specialty).toBe('會話');
    expect(updated.name).toBe(created.name);
  });

  it('overwrites the whole receipt blob rather than merging it', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const created = (await (await createTeacher(cookie)).json()) as { id: number };

    await fetchWorker(`/api/teachers?id=${created.id}`, withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt: { address: '台北市', timezone: '(UTC+8) 台北' } }),
    }));

    const res = await fetchWorker(`/api/teachers?id=${created.id}`, withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt: { timezone: '(UTC+9) 東京' } }),
    }));
    const updated = (await res.json()) as { receipt: Record<string, unknown> };
    expect(updated.receipt).toEqual({ timezone: '(UTC+9) 東京' });
  });
});

describe('PATCH /api/teachers/courses', () => {
  it('is 401 for a non-admin session', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    const res = await fetchWorker('/api/teachers/courses?teacherId=1', withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: 'x', action: 'add' }),
    }));
    expect(res.status).toBe(401);
  });

  it('is 404 for a course name that does not exist', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/teachers/courses?teacherId=1', withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: '不存在的課程', action: 'add' }),
    }));
    expect(res.status).toBe(404);
  });

  it('adds then removes a course, reflected in the teacher list', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const course = (await (await fetchWorker('/api/courses', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'N5 會話 A' }),
    }))).json()) as { name: string };

    const addRes = await fetchWorker('/api/teachers/courses?teacherId=1', withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: course.name, action: 'add' }),
    }));
    expect((await addRes.json())).toEqual({ courses: [course.name] });

    const removeRes = await fetchWorker('/api/teachers/courses?teacherId=1', withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: course.name, action: 'remove' }),
    }));
    expect((await removeRes.json())).toEqual({ courses: [] });
  });
});

describe('/api/teachers/hours', () => {
  it('GET is 401 with no session', async ({ expect }) => {
    expect((await fetchWorker('/api/teachers/hours?teacherId=1')).status).toBe(401);
  });

  it('a teacher session writing with a mismatched ?teacherId= is silently pinned to their own id, not the URL one', async ({ expect }) => {
    // Matches this codebase's established convention (see the earlier
    // teacherId-URL-tampering fix on /teacher/* pages): a non-admin session's
    // own identity always wins over a query param, rather than 401ing.
    const teacher2Cookie = await login('teacher2@jptip.co.jp', 'teacher');
    const res = await fetchWorker('/api/teachers/hours?teacherId=1', withCookie(teacher2Cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day: '星期一', start: '09:00', end: '12:00' }),
    }));
    expect(res.status).toBe(201);

    const teacher1Cookie = await login(SEEDED.teacher.email, 'teacher');
    expect(await (await fetchWorker('/api/teachers/hours?teacherId=1', withCookie(teacher1Cookie))).json()).toEqual([]);
    const teacher2Hours = await (await fetchWorker('/api/teachers/hours?teacherId=2', withCookie(teacher2Cookie))).json() as unknown[];
    expect(teacher2Hours).toHaveLength(1);
  });

  it('rejects an invalid day or start >= end', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    expect((await fetchWorker('/api/teachers/hours?teacherId=1', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day: '星期九', start: '09:00', end: '12:00' }),
    }))).status).toBe(400);
    expect((await fetchWorker('/api/teachers/hours?teacherId=1', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day: '星期一', start: '12:00', end: '09:00' }),
    }))).status).toBe(400);
  });

  it('a teacher can add and then delete their own slot; an admin can manage on their behalf', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    const created = (await (await fetchWorker('/api/teachers/hours?teacherId=1', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day: '星期二', start: '13:00', end: '17:00' }),
    }))).json()) as { id: number; day: string; start: string; end: string };
    expect(created).toMatchObject({ day: '星期二', start: '13:00', end: '17:00' });

    const list = (await (await fetchWorker('/api/teachers/hours?teacherId=1', withCookie(cookie))).json()) as unknown[];
    expect(list).toHaveLength(1);

    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const delRes = await fetchWorker(`/api/teachers/hours?teacherId=1&id=${created.id}`, withCookie(adminCookie, { method: 'DELETE' }));
    expect(delRes.status).toBe(200);
    expect((await (await fetchWorker('/api/teachers/hours?teacherId=1', withCookie(cookie))).json())).toEqual([]);
  });
});

describe('/api/teachers/leave', () => {
  it('upserts the same date instead of duplicating it', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    await fetchWorker('/api/teachers/leave?teacherId=1', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-10-01' }),
    }));
    await fetchWorker('/api/teachers/leave?teacherId=1', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-10-01' }),
    }));
    const list = (await (await fetchWorker('/api/teachers/leave?teacherId=1', withCookie(cookie))).json()) as unknown[];
    expect(list).toHaveLength(1);
  });

  it('deletes a leave day', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    const created = (await (await fetchWorker('/api/teachers/leave?teacherId=1', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-10-05' }),
    }))).json()) as { id: number };
    const res = await fetchWorker(`/api/teachers/leave?teacherId=1&id=${created.id}`, withCookie(cookie, { method: 'DELETE' }));
    expect(res.status).toBe(200);
  });

  it('is 404 deleting a leave day that does not belong to that teacher', async ({ expect }) => {
    const cookie = await login(SEEDED.teacher.email, 'teacher');
    const created = (await (await fetchWorker('/api/teachers/leave?teacherId=1', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-10-06' }),
    }))).json()) as { id: number };

    const teacher2Cookie = await login('teacher2@jptip.co.jp', 'teacher');
    const res = await fetchWorker(`/api/teachers/leave?teacherId=2&id=${created.id}`, withCookie(teacher2Cookie, { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });
});
