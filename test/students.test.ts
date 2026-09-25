import { describe, it } from 'vitest';
import { fetchWorker, login, makeTeacherBookable, SEEDED, withCookie } from './helpers';

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
    const res = await createStudent(cookie, { email: SEEDED.student.email });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'emailTaken' });
  });
});

describe('PATCH /api/students', () => {
  it("rejects changing the email to another student's, but keeping their own is fine", async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const created = (await (await createStudent(cookie)).json()) as { id: number; email: string };
    const patch = (email: string) => fetchWorker(`/api/students?id=${created.id}`, withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    }));

    const taken = await patch(SEEDED.student.email);
    expect(taken.status).toBe(400);
    expect(await taken.json()).toMatchObject({ code: 'emailTaken' });
    expect((await patch(created.email)).status).toBe(200);
  });

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

  it("uses the course's defaultSessions when totalSessions is omitted, an explicit totalSessions when given, and rejects an invalid one", async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const course = (await (await fetchWorker('/api/courses', withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '衝刺班 S' }),
    }))).json()) as { id: number; name: string };
    await fetchWorker(`/api/courses?id=${course.id}`, withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultSessions: 8 }),
    }));
    const enroll = (studentId: number, body: Record<string, unknown>) => fetchWorker(`/api/students/courses?studentId=${studentId}`, withCookie(cookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: course.name, ...body }),
    }));

    expect(((await (await enroll(1, {})).json()) as Record<string, unknown>).booked).toBe('0/8');
    expect(((await (await enroll(2, { totalSessions: 24 })).json()) as Record<string, unknown>).booked).toBe('0/24');
    for (const bad of [0, 1000, 1.5, '16']) {
      expect((await enroll(3, { totalSessions: bad })).status).toBe(400);
    }
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
    await makeTeacherBookable(course.id);
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booked = await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // 10 天後（UTC+8）：落在課程預設的可預約時限內（48 小時後～30 天內）
      body: JSON.stringify({ courseId: course.id, teacherId: 1, date: new Date(Date.now() + 8 * 3_600_000 + 10 * 86_400_000).toISOString().slice(0, 10), time: '10:00' }),
    }));
    expect(booked.status).toBe(201);

    const blockedDelete = await fetchWorker(`/api/students/courses?studentId=1&id=${enrollment2.id}`, withCookie(cookie, { method: 'DELETE' }));
    expect(blockedDelete.status).toBe(400);
  });
});
