import { describe, it } from 'vitest';
import { fetchWorker, login, SEEDED, withCookie } from './helpers';

async function createStudent(cookie: string, overrides: Record<string, unknown> = {}) {
  return fetchWorker('/api/students', withCookie(cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '新學生', email: `new-student-${Date.now()}@example.com`, ...overrides }),
  }));
}

describe('GET /api/students', () => {
  it('is 401 with no session and 401 for a non-admin session', async ({ expect }) => {
    expect((await fetchWorker('/api/students')).status).toBe(401);
    const studentCookie = await login(SEEDED.student.email, 'student');
    expect((await fetchWorker('/api/students', withCookie(studentCookie))).status).toBe(401);
  });

  it('lists seeded students', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const list = (await (await fetchWorker('/api/students', withCookie(cookie))).json()) as Record<string, unknown>[];
    const student1 = list.find((s) => s.email === SEEDED.student.email)!;
    expect(student1.status).toBe('active');
    expect(student1.teamsLink).toBeNull();
  });
});

describe('POST /api/students', () => {
  it('is 401 for a non-admin session', async ({ expect }) => {
    const cookie = await login(SEEDED.student.email, 'student');
    expect((await createStudent(cookie)).status).toBe(401);
  });

  it('creates a student without requiring teamsLink (it is a reserved, not-yet-used field)', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await createStudent(cookie);
    expect(res.status).toBe(201);
    const student = (await res.json()) as Record<string, unknown>;
    expect(student.teamsLink).toBeNull();
    expect(student.status).toBe('active');
  });

  it('rejects a duplicate email', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    expect((await createStudent(cookie, { email: SEEDED.student.email })).status).toBe(400);
  });
});

describe('PATCH /api/students', () => {
  it('updates only the fields provided, including teamsLink', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const created = (await (await createStudent(cookie)).json()) as { id: number; name: string };

    const res = await fetchWorker(`/api/students?id=${created.id}`, withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamsLink: 'https://teams.microsoft.com/l/meetup/abc' }),
    }));
    const updated = (await res.json()) as Record<string, unknown>;
    expect(updated.teamsLink).toBe('https://teams.microsoft.com/l/meetup/abc');
    expect(updated.name).toBe(created.name);
  });

  it('is 404 for a student that does not exist', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/students?id=999999', withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    }));
    expect(res.status).toBe(404);
  });
});

describe('/api/students/courses', () => {
  it('a student can read their own enrollments without passing studentId', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = (await (await fetchWorker('/api/courses', withCookie(adminCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'N4 文法 B' }),
    }))).json()) as { name: string };
    await fetchWorker('/api/students/courses?studentId=1', withCookie(adminCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: course.name }),
    }));

    const studentCookie = await login(SEEDED.student.email, 'student');
    const list = (await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[];
    expect(list.some((c) => c.name === course.name)).toBe(true);
  });

  it('a mismatched ?studentId= is silently ignored for a student session (their own id always wins)', async ({ expect }) => {
    const studentCookie = await login(SEEDED.student.email, 'student');
    const res = await fetchWorker('/api/students/courses?studentId=2', withCookie(studentCookie));
    expect(res.status).toBe(200);
    // Whatever comes back is student 1's own (possibly empty) list, never student 2's.
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const ownList = await (await fetchWorker('/api/students/courses?studentId=1', withCookie(adminCookie))).json();
    expect(await res.json()).toEqual(ownList);
  });

  it('POST is 401 for a non-admin session', async ({ expect }) => {
    const studentCookie = await login(SEEDED.student.email, 'student');
    const res = await fetchWorker('/api/students/courses?studentId=1', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: 'x' }),
    }));
    expect(res.status).toBe(401);
  });

  it('defaults totalSessions to 16 and formats attended/booked as N/D', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const course = (await (await fetchWorker('/api/courses', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'N3 聽力 C' }),
    }))).json()) as { name: string };
    const res = await fetchWorker('/api/students/courses?studentId=1', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: course.name }),
    }));
    const enrollment = (await res.json()) as Record<string, unknown>;
    expect(enrollment.attended).toBe('0/16');
    expect(enrollment.booked).toBe('0/16');
  });

  it('DELETE is blocked once the enrollment has any booked or attended sessions', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const course = (await (await fetchWorker('/api/courses', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'N2 寫作 D' }),
    }))).json()) as { id: number; name: string };
    const enrollment = (await (await fetchWorker('/api/students/courses?studentId=1', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: course.name }),
    }))).json()) as { id: number };

    // Freely deletable while untouched.
    const okDelete = await fetchWorker(`/api/students/courses?studentId=1&id=${enrollment.id}`, withCookie(cookie, { method: 'DELETE' }));
    expect(okDelete.status).toBe(200);

    // Re-create, then book it once via a real teacher so booked_count > 0.
    const enrollment2 = (await (await fetchWorker('/api/students/courses?studentId=1', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: course.name }),
    }))).json()) as { id: number };
    const studentCookie = await login(SEEDED.student.email, 'student');
    await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2026-11-02', time: '10:00' }),
    }));

    const blockedDelete = await fetchWorker(`/api/students/courses?studentId=1&id=${enrollment2.id}`, withCookie(cookie, { method: 'DELETE' }));
    expect(blockedDelete.status).toBe(400);
  });
});
