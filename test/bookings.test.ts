import { describe, it } from 'vitest';
import { fetchWorker, login, SEEDED, withCookie } from './helpers';

// 上課日期時間以 UTC+8 儲存；回傳 UTC+8 的「現在 + hours 小時」的日期與整點時間
function utc8SlotFromNow(hours: number) {
  const iso = new Date(Date.now() + (hours + 8) * 3_600_000).toISOString();
  return { date: iso.slice(0, 10), time: `${iso.slice(11, 13)}:00` };
}

// 測試用的預約日期固定寫在 2099 年（不會因為真的日期往後走而變成「已經過去」），所以把
// 「最久可預約的日期」放寬到 100 年；時限本身另外有專門的測試。
async function makeBookableCourse(adminCookie: string, name: string) {
  const course = (await (await fetchWorker('/api/courses', withCookie(adminCookie, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }))).json()) as { id: number; name: string };
  await fetchWorker(`/api/courses?id=${course.id}`, withCookie(adminCookie, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxLeadDays: 36500 }),
  }));
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
      body: JSON.stringify({ courseId: 1, teacherId: 1, date: '2099-11-10', time: '10:00' }),
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
      body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2099-11-10', time: '10:00' }),
    }));
    expect(res.status).toBe(400);
  });

  it('creates a booking, incrementing the enrollment\'s booked count', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 E');

    const studentCookie = await login(SEEDED.student.email, 'student');
    const res = await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2099-11-11', time: '09:00' }),
    }));
    expect(res.status).toBe(201);
    const booking = (await res.json()) as Record<string, unknown>;
    expect(booking.status).toBe('upcoming');
    expect(booking.bookingCode).toMatch(/^20991111-0900-\d{2}$/);

    const enrollments = (await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[];
    expect(enrollments.find((e) => e.name === course.name)!.booked).toBe('1/2');
  });

  it('is 409 when the same teacher/date/time is already booked', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 F');
    const studentCookie = await login(SEEDED.student.email, 'student');

    const body = JSON.stringify({ courseId: course.id, teacherId: 1, date: '2099-11-12', time: '11:00' });
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2099-11-13', time: '09:00' }),
    }));
    await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2099-11-13', time: '10:00' }),
    }));
    const third = await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2099-11-13', time: '11:00' }),
    }));
    expect(third.status).toBe(400);
  });

  it("rejects a slot inside the course's min-lead hours or beyond its max-lead days, and a malformed date", async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = (await (await fetchWorker('/api/courses', withCookie(adminCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '會話課 G2' }),
    }))).json()) as { id: number; name: string };
    await fetchWorker('/api/students/courses?studentId=1', withCookie(adminCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: course.name }),
    }));
    // 預設：48 小時內不可預約、最久可預約 30 天內
    const studentCookie = await login(SEEDED.student.email, 'student');
    const book = (slot: { date: string; time: string }) => fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, ...slot }),
    }));

    const tooSoon = await book(utc8SlotFromNow(24));
    expect(tooSoon.status).toBe(400);
    expect(((await tooSoon.json()) as { error: string }).error).toContain('48');
    expect((await book(utc8SlotFromNow(40 * 24))).status).toBe(400);
    expect((await book({ date: '2099/11/01', time: '10:00' })).status).toBe(400);
    expect((await book(utc8SlotFromNow(5 * 24))).status).toBe(201);
  });
});

describe('GET /api/bookings', () => {
  it('scopes a student session to their own bookings even if studentId is passed', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 H');
    const studentCookie = await login(SEEDED.student.email, 'student');
    await fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2099-11-14', time: '09:00' }),
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2099-11-15', time: '09:00' }),
    }));

    const lookerCookie = await login('student2@jptip.co.jp', 'student');
    const res = await fetchWorker('/api/bookings?teacherId=1&date=2099-11-15', withCookie(lookerCookie));
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2099-11-16', time: '09:00' }),
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
    const booking = await createBooking(studentCookie, course.id, '2099-11-17');

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
    const booking = await createBooking(studentCookie, course.id, '2099-11-18');

    let enrollments = (await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[];
    expect(enrollments.find((e) => e.name === course.name)!.booked).toBe('1/2');

    await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(studentCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    }));
    enrollments = (await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[];
    expect(enrollments.find((e) => e.name === course.name)!.booked).toBe('0/2');

    const booking2 = await createBooking(studentCookie, course.id, '2099-11-19');
    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    const patchRes = await fetchWorker(`/api/bookings?id=${booking2.id}`, withCookie(teacherCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'attended' }),
    }));
    expect(patchRes.status).toBe(200);
    enrollments = (await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[];
    expect(enrollments.find((e) => e.name === course.name)!.attended).toBe('1/2');
  });

  it('marks the enrollment completed once every session is attended, and back to ongoing if one is un-attended', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 L2'); // totalSessions: 2
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking1 = await createBooking(studentCookie, course.id, '2099-11-25');
    const booking2 = await createBooking(studentCookie, course.id, '2099-11-26');
    const enrollment = async () => ((await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[])
      .find((e) => e.name === course.name)!;
    const patch = (cookie: string, id: number, body: unknown) => fetchWorker(`/api/bookings?id=${id}`, withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));

    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    await patch(teacherCookie, booking1.id, { status: 'attended', teacherRating: 5 });
    expect(await enrollment()).toMatchObject({ attended: '1/2', status: 'ongoing' });

    await patch(teacherCookie, booking2.id, { status: 'attended', teacherRating: 4 });
    expect(await enrollment()).toMatchObject({ attended: '2/2', status: 'completed' });

    await patch(adminCookie, booking2.id, { status: 'absent' });
    expect(await enrollment()).toMatchObject({ attended: '1/2', status: 'ongoing' });
  });

  it('a student cannot cancel a booking that is no longer upcoming (e.g. already attended)', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 L3');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await createBooking(studentCookie, course.id, '2099-11-27');
    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(teacherCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'attended' }),
    }));

    const res = await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(studentCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    }));
    expect(res.status).toBe(400);
    const enrollment = ((await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[])
      .find((e) => e.name === course.name)!;
    expect(enrollment).toMatchObject({ booked: '1/2', attended: '1/2' });
  });

  it("a student cannot cancel within the course's min-lead hours, but an admin still can (and the session is refunded)", async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 L4');
    const setMinLead = (hours: number) => fetchWorker(`/api/courses?id=${course.id}`, withCookie(adminCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minLeadHours: hours }),
    }));
    const studentCookie = await login(SEEDED.student.email, 'student');
    // 先把時限關掉才約得到 24 小時後的課，約好再改回 48 小時
    await setMinLead(0);
    const soon = utc8SlotFromNow(24);
    const booking = await createBooking(studentCookie, course.id, soon.date, soon.time);
    await setMinLead(48);

    const studentRes = await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(studentCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    }));
    expect(studentRes.status).toBe(400);
    expect(((await studentRes.json()) as { error: string }).error).toContain('48');

    const adminRes = await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(adminCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    }));
    expect(adminRes.status).toBe(200);
    const enrollment = ((await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[])
      .find((e) => e.name === course.name)!;
    expect(enrollment.booked).toBe('0/2');
  });

  it('a teacher may only mark their OWN booking attended, and only to attended', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 M');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await createBooking(studentCookie, course.id, '2099-11-20');

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
    const booking = await createBooking(studentCookie, course.id, '2099-11-21');

    const res = await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(adminCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'absent' }),
    }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe('absent');
  });

  it('feedback visibility: students never see teacherRating/teacherNote, teachers never see rating/studentComment, admins see both', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 O');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await createBooking(studentCookie, course.id, '2099-11-22');
    const patch = (cookie: string, body: unknown) => fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));

    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    expect((await patch(teacherCookie, { status: 'attended', teacherRating: 3, teacherNote: '老師的課堂記錄' })).status).toBe(200);
    const ratedRes = await patch(studentCookie, { rating: 4, studentComment: '學生的留言' });
    expect(ratedRes.status).toBe(200);

    // PATCH responses are redacted the same way as the list.
    const ratedJson = (await ratedRes.json()) as Record<string, unknown>;
    expect(ratedJson.rating).toBe(4);
    expect(ratedJson).not.toHaveProperty('teacherRating');
    expect(ratedJson).not.toHaveProperty('teacherNote');

    const find = async (cookie: string) => {
      const list = (await (await fetchWorker('/api/bookings', withCookie(cookie))).json()) as Record<string, unknown>[];
      return list.find((b) => b.id === booking.id)!;
    };

    const asStudent = await find(studentCookie);
    expect(asStudent.rating).toBe(4);
    expect(asStudent.studentComment).toBe('學生的留言');
    expect(asStudent).not.toHaveProperty('teacherRating');
    expect(asStudent).not.toHaveProperty('teacherNote');

    const asTeacher = await find(teacherCookie);
    expect(asTeacher.teacherRating).toBe(3);
    expect(asTeacher.teacherNote).toBe('老師的課堂記錄');
    expect(asTeacher).not.toHaveProperty('rating');
    expect(asTeacher).not.toHaveProperty('studentComment');

    const asAdmin = await find(adminCookie);
    expect(asAdmin.rating).toBe(4);
    expect(asAdmin.studentComment).toBe('學生的留言');
    expect(asAdmin.teacherRating).toBe(3);
    expect(asAdmin.teacherNote).toBe('老師的課堂記錄');

    // Another student browsing this teacher's schedule sees neither party's feedback.
    const student2Cookie = await login('student2@jptip.co.jp', 'student');
    const schedule = (await (await fetchWorker('/api/bookings?teacherId=1', withCookie(student2Cookie))).json()) as Record<string, unknown>[];
    const asOtherStudent = schedule.find((b) => b.id === booking.id)!;
    expect(asOtherStudent).not.toHaveProperty('rating');
    expect(asOtherStudent).not.toHaveProperty('studentComment');
    expect(asOtherStudent).not.toHaveProperty('teacherNote');
    expect(asOtherStudent).not.toHaveProperty('teacherRating');

    // Writes are scoped the same way: a student can't set teacherRating, a teacher can't set rating,
    // another teacher can't rate this lesson, and out-of-range values are rejected.
    expect((await patch(studentCookie, { teacherRating: 5 })).status).toBe(401);
    expect((await patch(teacherCookie, { rating: 5 })).status).toBe(401);
    const teacher2Cookie = await login('teacher2@jptip.co.jp', 'teacher');
    expect((await patch(teacher2Cookie, { teacherRating: 5 })).status).toBe(401);
    expect((await patch(teacherCookie, { teacherRating: 6 })).status).toBe(400);
  });

  it('is 404 for a booking that does not exist', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/bookings?id=999999', withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'attended' }),
    }));
    expect(res.status).toBe(404);
  });
});
