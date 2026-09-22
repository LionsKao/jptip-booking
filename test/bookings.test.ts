import { describe, it } from 'vitest';
import { fetchWorker, login, SEEDED, withCookie } from './helpers';

async function makeBookableCourse(adminCookie: string, name: string) {
  const course = (await (await fetchWorker('/api/courses', withCookie(adminCookie, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }))).json()) as { id: number; name: string };
  await fetchWorker('/api/students/courses?studentId=1', withCookie(adminCookie, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: name, totalSessions: 2 }),
  }));
  return course;
}

describe('POST /api/bookings', () => {
  it('is 401 for a non-student session', async ({ expect }) => {
    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    const res = await fetchWorker('/api/bookings', withCookie(teacherCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: 1, teacherId: 1, date: '2026-11-10', time: '10:00' }),
    }));
    expect(res.status).toBe(401);
  });

  it('is 400 when the student is not enrolled in the course', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = (await (await fetchWorker('/api/courses', withCookie(adminCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '未報名課程 A' }),
    }))).json()) as { id: number };

    const studentCookie = await login(SEEDED.student.email, 'student');
    const res = await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2026-11-10', time: '10:00' }),
    }));
    expect(res.status).toBe(400);
  });

  it('creates a booking, incrementing the enrollment\'s booked count', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 E');

    const studentCookie = await login(SEEDED.student.email, 'student');
    const res = await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2026-11-11', time: '09:00' }),
    }));
    expect(res.status).toBe(201);
    const booking = (await res.json()) as Record<string, unknown>;
    expect(booking.status).toBe('upcoming');
    expect(booking.bookingCode).toMatch(/^20261111-0900-\d{2}$/);

    const enrollments = (await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[];
    expect(enrollments.find((e) => e.name === course.name)!.booked).toBe('1/2');
  });

  it('is 409 when the same teacher/date/time is already booked', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 F');
    const studentCookie = await login(SEEDED.student.email, 'student');

    const body = JSON.stringify({ courseId: course.id, teacherId: 1, date: '2026-11-12', time: '11:00' });
    const first = await fetchWorker('/api/bookings', withCookie(studentCookie, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }));
    expect(first.status).toBe(201);

    const second = await fetchWorker('/api/bookings', withCookie(studentCookie, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }));
    expect(second.status).toBe(409);
  });

  it('is 400 once the enrollment\'s quota is used up', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 G'); // totalSessions: 2
    const studentCookie = await login(SEEDED.student.email, 'student');

    await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2026-11-13', time: '09:00' }),
    }));
    await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2026-11-13', time: '10:00' }),
    }));
    const third = await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2026-11-13', time: '11:00' }),
    }));
    expect(third.status).toBe(400);
  });
});

describe('GET /api/bookings', () => {
  it('scopes a student session to their own bookings even if studentId is passed', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 H');
    const studentCookie = await login(SEEDED.student.email, 'student');
    await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2026-11-14', time: '09:00' }),
    }));

    const student2Cookie = await login('student2@jptip.co.jp', 'student');
    const list = (await (await fetchWorker('/api/bookings?studentId=1', withCookie(student2Cookie))).json()) as Record<string, unknown>[];
    expect(list.every((b) => b.studentId === 2 || b.studentId === undefined)).toBe(true);
    expect(list.some((b) => b.course === course.name)).toBe(false);
  });

  it('redacts student identity when a student session queries another teacher\'s schedule', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 I');
    const bookerCookie = await login(SEEDED.student.email, 'student');
    await fetchWorker('/api/bookings', withCookie(bookerCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2026-11-15', time: '09:00' }),
    }));

    const lookerCookie = await login('student2@jptip.co.jp', 'student');
    const res = await fetchWorker('/api/bookings?teacherId=1&date=2026-11-15', withCookie(lookerCookie));
    expect(res.status).toBe(200);
    const list = (await res.json()) as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(0);
    for (const b of list) {
      expect(b.studentId).toBeUndefined();
      expect(b.studentName).toBeUndefined();
      expect(b.teacherId).toBe(1);
    }
  });

  it('a teacher session is scoped to their own bookings regardless of query params', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 J');
    const studentCookie = await login(SEEDED.student.email, 'student');
    await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2026-11-16', time: '09:00' }),
    }));

    const teacher2Cookie = await login('teacher2@jptip.co.jp', 'teacher');
    const list = (await (await fetchWorker('/api/bookings?teacherId=1', withCookie(teacher2Cookie))).json()) as Record<string, unknown>[];
    expect(list.every((b) => b.teacherId === 2)).toBe(true);
  });
});

describe('PATCH /api/bookings', () => {
  async function createBooking(studentCookie: string, courseId: number, date: string, time = '09:00') {
    const res = await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId, teacherId: 1, date, time }),
    }));
    return (await res.json()) as { id: number };
  }

  it('a student may only cancel their own booking', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 K');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await createBooking(studentCookie, course.id, '2026-11-17');

    const student2Cookie = await login('student2@jptip.co.jp', 'student');
    expect((await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(student2Cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    }))).status).toBe(401);

    // Can't set any other status on their own booking either.
    expect((await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(studentCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'attended' }),
    }))).status).toBe(401);

    const res = await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(studentCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    }));
    expect(res.status).toBe(200);
  });

  it('cancelling refunds booked_count; a teacher marking attended increments attended_count', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 L');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await createBooking(studentCookie, course.id, '2026-11-18');

    let enrollments = (await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[];
    expect(enrollments.find((e) => e.name === course.name)!.booked).toBe('1/2');

    await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(studentCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    }));
    enrollments = (await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[];
    expect(enrollments.find((e) => e.name === course.name)!.booked).toBe('0/2');

    const booking2 = await createBooking(studentCookie, course.id, '2026-11-19');
    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    const patchRes = await fetchWorker(`/api/bookings?id=${booking2.id}`, withCookie(teacherCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'attended' }),
    }));
    expect(patchRes.status).toBe(200);
    enrollments = (await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[];
    expect(enrollments.find((e) => e.name === course.name)!.attended).toBe('1/2');
  });

  it('a teacher may only mark their OWN booking attended, and only to attended', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 M');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await createBooking(studentCookie, course.id, '2026-11-20');

    const teacher2Cookie = await login('teacher2@jptip.co.jp', 'teacher');
    expect((await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(teacher2Cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'attended' }),
    }))).status).toBe(401);

    const teacher1Cookie = await login(SEEDED.teacher.email, 'teacher');
    expect((await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(teacher1Cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    }))).status).toBe(401);
  });

  it('an admin may set any status on any booking', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 N');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await createBooking(studentCookie, course.id, '2026-11-21');

    const res = await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(adminCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'absent' }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe('absent');
  });

  it('is 404 for a booking that does not exist', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/bookings?id=999999', withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'attended' }),
    }));
    expect(res.status).toBe(404);
  });
});
