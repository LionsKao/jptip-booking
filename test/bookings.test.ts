import { env } from 'cloudflare:workers';
import { describe, it } from 'vitest';
import { fetchWorker, login, makeTeacherBookable, SEEDED, withCookie } from './helpers';

// 上課日期時間以 UTC+8 儲存；回傳 UTC+8 的「今天 + days 天」上午 10 點——離現在 days×24−14 到
// days×24+10 小時，固定 10 點是為了不管現在幾點，整堂課都排得進老師當天的時段。
function utc8SlotInDays(days: number) {
  return { date: new Date(Date.now() + 8 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10), time: '10:00' };
}

// 老師要等課程上完（開始時間＋課程時長）才能標記完成，但預約只能約未來的時段，所以直接把資料庫裡
// 這筆預約的上課時間改成 UTC+8 的 minutesAgo 分鐘前（秒數捨去，所以實際會再早一點點）。
async function setLessonStart(bookingId: number, minutesAgo: number) {
  const iso = new Date(Date.now() + 8 * 3_600_000 - minutesAgo * 60_000).toISOString();
  await env.DB.prepare(`UPDATE bookings SET date = ?, time = ? WHERE id = ?`).bind(iso.slice(0, 10), iso.slice(11, 16), bookingId).run();
}
// 預設課程時長 100 分鐘，3 小時前開始的課已經上完了
const finishLesson = (bookingId: number) => setLessonStart(bookingId, 180);

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
  await makeTeacherBookable(course.id);
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
    expect(await second.json()).toMatchObject({ code: 'slotTaken' });
  });

  it('is 400 once the enrollment\'s quota is used up', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 G'); // totalSessions: 2
    const studentCookie = await login(SEEDED.student.email, 'student');

    const book = (date: string) => fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date, time: '09:00' }),
    }));
    expect((await book('2099-12-20')).status).toBe(201);
    expect((await book('2099-12-21')).status).toBe(201);
    const third = await book('2099-12-22');
    expect(third.status).toBe(400);
    expect(await third.json()).toMatchObject({ code: 'noSessionsLeft' });
  });

  it("rejects a slot inside the course's min-lead hours or beyond its max-lead days, and a malformed date", async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = (await (await fetchWorker('/api/courses', withCookie(adminCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '會話課 G2' }),
    }))).json()) as { id: number; name: string };
    await fetchWorker('/api/students/courses?studentId=1', withCookie(adminCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseName: course.name }),
    }));
    await makeTeacherBookable(course.id);
    // 預設：48 小時內不可預約、最久可預約 30 天內
    const studentCookie = await login(SEEDED.student.email, 'student');
    const book = (slot: { date: string; time: string }) => fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, ...slot }),
    }));

    const tooSoon = await book(utc8SlotInDays(1));
    expect(tooSoon.status).toBe(400);
    expect(await tooSoon.json()).toMatchObject({ code: 'bookingTooLate', params: { hours: 48 } });
    const tooFar = await book(utc8SlotInDays(40));
    expect(tooFar.status).toBe(400);
    expect(await tooFar.json()).toMatchObject({ code: 'bookingTooFar', params: { days: 30 } });
    expect((await book({ date: '2099/11/01', time: '10:00' })).status).toBe(400);
    expect((await book(utc8SlotInDays(5))).status).toBe(201);
  });

  it('rejects a teacher who does not teach the course or is inactive', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 T1'); // 只有老師 1 開這門課
    // 新老師預設是停用；給他開這門課、全天開放，只差還沒啟用
    const newTeacher = (await (await fetchWorker('/api/teachers', withCookie(adminCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '新老師 T1', email: `t1-${Date.now()}@example.com` }),
    }))).json()) as { id: number };
    await makeTeacherBookable(course.id, newTeacher.id);
    const studentCookie = await login(SEEDED.student.email, 'student');
    const book = (teacherId: number) => fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId, date: '2099-12-02', time: '09:00' }),
    }));

    const notTeaching = await book(2);
    expect(notTeaching.status).toBe(400);
    expect(await notTeaching.json()).toMatchObject({ code: 'teacherUnavailable' });
    const inactive = await book(newTeacher.id);
    expect(inactive.status).toBe(400);
    expect(await inactive.json()).toMatchObject({ code: 'teacherUnavailable' });
  });

  it("only accepts a slot where the whole lesson fits inside the teacher's weekly hours, and not on their leave day", async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 T2'); // 100 分鐘
    const newTeacher = (await (await fetchWorker('/api/teachers', withCookie(adminCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '新老師 T2', email: `t2-${Date.now()}@example.com`, status: 'active' }),
    }))).json()) as { id: number };
    await env.DB.prepare(`INSERT INTO teacher_courses (teacher_id, course_id) VALUES (?, ?)`).bind(newTeacher.id, course.id).run();
    // 只有星期一 09:00–12:00
    await env.DB.prepare(`INSERT INTO teacher_hours (teacher_id, day_of_week, start_time, end_time) VALUES (?, 1, '09:00', '12:00')`).bind(newTeacher.id).run();
    await env.DB.prepare(`INSERT INTO teacher_leave (teacher_id, date) VALUES (?, '2099-12-07')`).bind(newTeacher.id).run();
    const studentCookie = await login(SEEDED.student.email, 'student');
    const book = (date: string, time: string) => fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: newTeacher.id, date, time }),
    }));

    for (const [date, time] of [
      ['2099-12-01', '09:00'], // 星期二沒有開放
      ['2099-11-30', '08:00'], // 開放時段之前
      ['2099-11-30', '10:30'], // 12:10 才下課，超出開放時段
      ['2099-12-07', '09:00'], // 休假日
    ]) {
      const res = await book(date, time);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'slotUnavailable' });
    }
    expect((await book('2099-11-30', '10:20')).status).toBe(201); // 剛好 12:00 下課
  });

  it("rejects a slot overlapping another booking of the same teacher, counting each lesson's duration and buffers", async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 T3'); // 100 分鐘＋課後緩衝 20 分鐘，2 堂
    const studentCookie = await login(SEEDED.student.email, 'student');
    const book = (time: string) => fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2099-12-10', time }),
    }));

    expect((await book('09:00')).status).toBe(201); // 佔用 09:00–11:00
    for (const time of ['09:00', '10:00', '10:50', '07:30']) { // 07:30 那堂要到 09:30 才結束（含緩衝）
      const res = await book(time);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'slotTaken' });
    }
    expect((await book('11:00')).status).toBe(201);
    const enrollment = ((await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[])
      .find((e) => e.name === course.name)!;
    expect(enrollment.booked).toBe('2/2'); // 被擋下來的不會扣堂數
  });

  it('lets only one of two simultaneous requests for the same slot through', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 T4');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const book = () => fetchWorker('/api/bookings', withCookie(studentCookie, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: course.id, teacherId: 1, date: '2099-12-11', time: '09:00' }),
    }));

    const statuses = (await Promise.all([book(), book()])).map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409]);
    const enrollment = ((await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[])
      .find((e) => e.name === course.name)!;
    expect(enrollment.booked).toBe('1/2');
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
    await finishLesson(booking2.id);
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
    await finishLesson(booking1.id);
    await finishLesson(booking2.id);
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
    await finishLesson(booking.id);
    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(teacherCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'attended' }),
    }));

    const res = await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(studentCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'cannotCancel' });
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
    // 先把時限關掉才約得到明天的課，約好再改回 48 小時
    await setMinLead(0);
    const soon = utc8SlotInDays(1);
    const booking = await createBooking(studentCookie, course.id, soon.date, soon.time);
    await setMinLead(48);

    const studentRes = await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(studentCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    }));
    expect(studentRes.status).toBe(400);
    expect(await studentRes.json()).toMatchObject({ code: 'cancelTooLate', params: { hours: 48 } });

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

  it("a teacher can only mark a lesson attended once it has ended (start + the course's duration), and only an upcoming one", async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 M2');
    await fetchWorker(`/api/courses?id=${course.id}`, withCookie(adminCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ durationMinutes: 30 }),
    }));
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await createBooking(studentCookie, course.id, '2099-11-28');
    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    const markAttended = () => fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(teacherCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'attended', teacherRating: 5 }),
    }));

    const notStarted = await markAttended();
    expect(notStarted.status).toBe(400);
    expect(await notStarted.json()).toMatchObject({ code: 'lessonNotEnded' });

    await setLessonStart(booking.id, 20); // 30 分鐘的課，20 分鐘前開始：還在上課
    const inProgress = await markAttended();
    expect(inProgress.status).toBe(400);
    expect(await inProgress.json()).toMatchObject({ code: 'lessonNotEnded' });

    await setLessonStart(booking.id, 40); // 已經下課
    expect((await markAttended()).status).toBe(200);

    // 已經不是 upcoming（這裡是已完成）就不能再標記，已取消的課也一樣，避免預約次數被重複計算
    const again = await markAttended();
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: 'cannotComplete' });
    const enrollment = ((await (await fetchWorker('/api/students/courses', withCookie(studentCookie))).json()) as Record<string, unknown>[])
      .find((e) => e.name === course.name)!;
    expect(enrollment).toMatchObject({ booked: '1/2', attended: '1/2' });
  });

  it('an admin can still mark a lesson attended before it has ended', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 M3');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await createBooking(studentCookie, course.id, '2099-11-29');

    const res = await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(adminCookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'attended' }),
    }));
    expect(res.status).toBe(200);
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

    await finishLesson(booking.id);
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

  it('limits the student comment and teacher note to 500 characters', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = await makeBookableCourse(adminCookie, '會話課 P');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await createBooking(studentCookie, course.id, '2099-11-23');
    await finishLesson(booking.id);
    const teacherCookie = await login(SEEDED.teacher.email, 'teacher');
    const patch = (cookie: string, body: unknown) => fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));

    const longNote = await patch(teacherCookie, { status: 'attended', teacherRating: 5, teacherNote: 'あ'.repeat(501) });
    expect(longNote.status).toBe(400);
    expect(await longNote.json()).toMatchObject({ code: 'textTooLong', params: { max: 500 } });
    expect((await patch(teacherCookie, { status: 'attended', teacherRating: 5, teacherNote: 'あ'.repeat(500) })).status).toBe(200);

    expect((await patch(studentCookie, { rating: 5, studentComment: 'a'.repeat(501) })).status).toBe(400);
    expect((await patch(studentCookie, { rating: 5, studentComment: 'a'.repeat(500) })).status).toBe(200);
  });

  it('is 404 for a booking that does not exist', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await fetchWorker('/api/bookings?id=999999', withCookie(cookie, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'attended' }),
    }));
    expect(res.status).toBe(404);
  });
});
