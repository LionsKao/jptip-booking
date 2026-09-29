import { env } from 'cloudflare:workers';
import { afterEach, describe, it, vi } from 'vitest';
import { sendDueBookingReminders } from '../src/index';
import { fetchWorker, login, makeTeacherBookable, mockGraph, SEEDED, sentMails, withCookie } from './helpers';

afterEach(() => {
  env.MS_CLIENT_SECRET = '';
  vi.restoreAllMocks();
});

const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// 預約 API 有最少 48 小時前才能預約的限制，測試用遠一點的日期先建立預約，
// 再直接改資料庫的上課時間，模擬「已經接近上課時間」而不用真的等
async function moveBookingTo(bookingId: number, hoursFromNow: number): Promise<void> {
  const shifted = new Date(Date.now() + hoursFromNow * 3_600_000 + 8 * 3_600_000);
  await env.DB.prepare(`UPDATE bookings SET date = ?, time = ? WHERE id = ?`)
    .bind(shifted.toISOString().slice(0, 10), shifted.toISOString().slice(11, 16), bookingId).run();
}

// 每筆測試預約一開始都要落在不同的日期：同一個老師、同一個日期時間建立第二筆會撞「這個時段已被
// 預約」，而 moveBookingTo 之後兩筆各自搬到別的時間，也不能讓 generateBookingCode（用當下同一
// 日期時間的既有筆數計算序號）算出重複的預約編號。
let daysOutCounter = 10;
async function setupBooking(adminCookie: string, studentCookie: string, courseName: string, teacherId = 1): Promise<{ id: number; bookingCode: string }> {
  const course = (await (await fetchWorker('/api/courses', withCookie(adminCookie, jsonInit('POST', { name: courseName })))).json()) as { id: number };
  await makeTeacherBookable(course.id, teacherId);
  const student = (await env.DB.prepare(`SELECT id FROM students WHERE email = ?`).bind(SEEDED.student.email).first<{ id: number }>())!;
  await fetchWorker(`/api/students/courses?studentId=${student.id}`, withCookie(adminCookie, jsonInit('POST', { courseName: course.name })));
  const date = new Date(Date.now() + 8 * 3_600_000 + daysOutCounter++ * 86_400_000).toISOString().slice(0, 10);
  const res = await fetchWorker('/api/bookings', withCookie(studentCookie, jsonInit('POST', { courseId: course.id, teacherId, date, time: '10:00' })));
  return (await res.json()) as { id: number; bookingCode: string };
}

describe('booking reminder emails', () => {
  it('emails the student and teacher once the booking enters the course’s reminder window, and never resends it', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await setupBooking(adminCookie, studentCookie, '提醒信測試');
    await moveBookingTo(booking.id, 5); // 預設 24 小時前提醒，5 小時後上課已經進入範圍

    env.MS_CLIENT_SECRET = 'test-secret';
    const calls = mockGraph();
    await sendDueBookingReminders(env);

    const mails = sentMails(calls);
    expect(mails).toHaveLength(2);
    const toStudent = mails.find((m) => m.to === SEEDED.student.email)!;
    const toTeacher = mails.find((m) => m.to === SEEDED.teacher.email)!;
    expect(toStudent.subject).toContain('🔔');
    expect(toStudent.subject).toContain('上課提醒');
    expect(toStudent.html).toContain(booking.bookingCode);
    expect(toTeacher.subject).toContain('🔔');
    // 提醒信不是預約成功信，不該出現堂數進度
    expect(toStudent.html).not.toContain('第幾次預約');

    const row = await env.DB.prepare(`SELECT reminder_sent_at FROM bookings WHERE id = ?`).bind(booking.id).first<{ reminder_sent_at: string | null }>();
    expect(row?.reminder_sent_at).not.toBeNull();

    // 兩封都寄成功，各自留一筆 email_log，status 是 sent
    const { results: logs } = await env.DB.prepare(`SELECT * FROM email_log WHERE booking_id = ?`).bind(booking.id).all<{ status: string; template_key: string; recipient: string }>();
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.status === 'sent')).toBe(true);
    expect(logs.map((l) => l.template_key).sort()).toEqual(['booking_reminder_student', 'booking_reminder_teacher']);

    await sendDueBookingReminders(env); // 再跑一次排程，已經寄過的不會重複寄
    expect(sentMails(calls)).toHaveLength(2);
  });

  it('does not mark the reminder sent when Graph fails, so the next run retries it, and logs the failure', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await setupBooking(adminCookie, studentCookie, '寄信失敗測試');
    await moveBookingTo(booking.id, 5);

    env.MS_CLIENT_SECRET = 'test-secret';
    mockGraph(401); // Graph 端回錯誤，模擬寄信失敗（sendMail 這個 call 還是會發出去，只是回應是錯的）
    await sendDueBookingReminders(env);

    const row = await env.DB.prepare(`SELECT reminder_sent_at FROM bookings WHERE id = ?`).bind(booking.id).first<{ reminder_sent_at: string | null }>();
    expect(row?.reminder_sent_at).toBeNull(); // 沒標記，下次排程會再試一次

    const { results: logs } = await env.DB.prepare(`SELECT * FROM email_log WHERE booking_id = ?`).bind(booking.id).all<{ status: string; error: string | null }>();
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.status === 'failed')).toBe(true);
    expect(logs.every((l) => (l.error || '').includes('401'))).toBe(true);

    // 這筆一直沒有 reminder_sent_at，還在「該提醒」的範圍內：清掉，不然會被其他測試的
    // sendDueBookingReminders() 呼叫又抓到，干擾到那些測試自己的計數
    await env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).bind(booking.id).run();
  });

  it('skips bookings outside the reminder window, already cancelled, or already reminded', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const studentCookie = await login(SEEDED.student.email, 'student');

    const tooEarly = await setupBooking(adminCookie, studentCookie, '還沒到提醒時間');
    await moveBookingTo(tooEarly.id, 30); // 30 小時後，超過預設 24 小時的提醒範圍

    const cancelled = await setupBooking(adminCookie, studentCookie, '已取消不提醒');
    await moveBookingTo(cancelled.id, 5);
    await env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).bind(cancelled.id).run();

    const alreadySent = await setupBooking(adminCookie, studentCookie, '已經寄過提醒');
    await moveBookingTo(alreadySent.id, 5);
    await env.DB.prepare(`UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ?`).bind(alreadySent.id).run();

    env.MS_CLIENT_SECRET = 'test-secret';
    const calls = mockGraph();
    await sendDueBookingReminders(env);
    expect(sentMails(calls)).toHaveLength(0);
  });

  it('honours each course’s own reminder lead time', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const course = (await (await fetchWorker('/api/courses', withCookie(adminCookie, jsonInit('POST', { name: '自訂提醒時間' })))).json()) as { id: number };
    await fetchWorker(`/api/courses?id=${course.id}`, withCookie(adminCookie, jsonInit('PATCH', { reminderHoursBefore: 2 })));
    await makeTeacherBookable(course.id);
    const student = (await env.DB.prepare(`SELECT id FROM students WHERE email = ?`).bind(SEEDED.student.email).first<{ id: number }>())!;
    await fetchWorker(`/api/students/courses?studentId=${student.id}`, withCookie(adminCookie, jsonInit('POST', { courseName: course.name })));
    const date = new Date(Date.now() + 8 * 3_600_000 + daysOutCounter++ * 86_400_000).toISOString().slice(0, 10);
    const booking = (await (await fetchWorker('/api/bookings', withCookie(studentCookie, jsonInit('POST', { courseId: course.id, teacherId: 1, date, time: '10:00' })))).json()) as { id: number };
    await moveBookingTo(booking.id, 5); // 這門課只提前 2 小時提醒，5 小時後還不算

    env.MS_CLIENT_SECRET = 'test-secret';
    const calls = mockGraph();
    await sendDueBookingReminders(env);
    expect(sentMails(calls)).toHaveLength(0);

    await moveBookingTo(booking.id, 1); // 改到 1 小時後，進入這門課的提醒範圍
    await sendDueBookingReminders(env);
    expect(sentMails(calls)).toHaveLength(2);
  });

  it('sends nothing, and leaves the booking unmarked, when the mail secret is not set', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const studentCookie = await login(SEEDED.student.email, 'student');
    const booking = await setupBooking(adminCookie, studentCookie, '沒設定寄信密鑰');
    await moveBookingTo(booking.id, 5);

    const calls = mockGraph();
    await sendDueBookingReminders(env);
    expect(sentMails(calls)).toHaveLength(0);
    const row = await env.DB.prepare(`SELECT reminder_sent_at FROM bookings WHERE id = ?`).bind(booking.id).first<{ reminder_sent_at: string | null }>();
    expect(row?.reminder_sent_at).toBeNull();
  });
});
