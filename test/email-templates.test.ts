import { env } from 'cloudflare:workers';
import { afterEach, describe, it, vi } from 'vitest';
import { fetchWorker, latestOtpCode, login, makeTeacherBookable, mockGraph, requestOtp, SEEDED, sentMails, withCookie } from './helpers';

afterEach(() => {
  env.MS_CLIENT_SECRET = '';
  vi.restoreAllMocks();
});

const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

type TemplateDetail = {
  key: string;
  variables: string[];
  languages: Record<string, { subject: string; html: string; defaultSubject: string; defaultHtml: string; customized: boolean; updatedAt: string | null }>;
};

async function getTemplate(cookie: string, key: string): Promise<TemplateDetail> {
  return (await (await fetchWorker(`/api/email-templates?key=${key}`, withCookie(cookie))).json()) as TemplateDetail;
}

function saveTemplate(cookie: string, key: string, languages: Record<string, unknown>): Promise<Response> {
  return fetchWorker(`/api/email-templates?key=${key}`, withCookie(cookie, jsonInit('PUT', { languages })));
}

describe('/api/email-templates', () => {
  it('is admin-only', async ({ expect }) => {
    expect((await fetchWorker('/api/email-templates')).status).toBe(401);
    for (const account of [SEEDED.student, SEEDED.teacher]) {
      const cookie = await login(account.email, account.role);
      expect((await fetchWorker('/api/email-templates', withCookie(cookie))).status).toBe(401);
      expect((await saveTemplate(cookie, 'login_student', { 'zh-Hant': { subject: 'x', html: 'x' } })).status).toBe(401);
    }
  });

  it('lists every system email in order, all using the built-in defaults at first', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const list = (await (await fetchWorker('/api/email-templates', withCookie(cookie))).json()) as { key: string; variables: string[]; customizedLanguages: string[] }[];
    expect(list.map((t) => t.key)).toEqual([
      'login_admin', 'login_teacher', 'login_student',
      'booking_created_student', 'booking_created_teacher', 'booking_cancelled_student', 'booking_cancelled_teacher',
    ]);
    expect(list.every((t) => t.customizedLanguages.length === 0)).toBe(true);
    expect(list[0].variables).toEqual(['name', 'code', 'siteUrl']);
  });

  it('returns all five languages with the default content, and 404s for an unknown key', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const tpl = await getTemplate(cookie, 'booking_created_teacher');
    expect(Object.keys(tpl.languages)).toEqual(['zh-Hant', 'ja', 'en', 'vi', 'my']);
    for (const lang of Object.values(tpl.languages)) {
      expect(lang.customized).toBe(false);
      expect(lang.subject).toBe(lang.defaultSubject);
      expect(lang.html).toBe(lang.defaultHtml);
      expect(lang.html).toContain('{{studentName}}');
    }
    expect(tpl.languages['zh-Hant'].subject).toBe('【JPTIP】新預約：{{studentName}} {{date}} {{time}}');
    expect((await fetchWorker('/api/email-templates?key=nope', withCookie(cookie))).status).toBe(404);
  });

  it('saves an edited language; saving the default content again goes back to using the default', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const res = await saveTemplate(cookie, 'booking_cancelled_teacher', { ja: { subject: '取消 {{studentName}}', html: '<p>{{teacherName}}</p>' } });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as TemplateDetail;
    expect(saved.languages.ja).toMatchObject({ subject: '取消 {{studentName}}', html: '<p>{{teacherName}}</p>', customized: true });
    expect(saved.languages.ja.updatedAt).toBeTruthy();
    expect(saved.languages.en.customized).toBe(false);

    const list = (await (await fetchWorker('/api/email-templates', withCookie(cookie))).json()) as { key: string; customizedLanguages: string[] }[];
    expect(list.find((t) => t.key === 'booking_cancelled_teacher')!.customizedLanguages).toEqual(['ja']);

    const { defaultSubject, defaultHtml } = saved.languages.ja;
    const restored = (await (await saveTemplate(cookie, 'booking_cancelled_teacher', { ja: { subject: defaultSubject, html: defaultHtml } })).json()) as TemplateDetail;
    expect(restored.languages.ja.customized).toBe(false);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_templates WHERE template_key = 'booking_cancelled_teacher'`).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('rejects an unsupported language, blank or oversized content, and a missing body', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    expect((await saveTemplate(cookie, 'login_admin', { fr: { subject: 'x', html: 'x' } })).status).toBe(400);
    expect((await saveTemplate(cookie, 'login_admin', { en: { subject: ' ', html: 'x' } })).status).toBe(400);
    expect((await saveTemplate(cookie, 'login_admin', { en: { subject: 'x', html: '' } })).status).toBe(400);
    const tooLong = await saveTemplate(cookie, 'login_admin', { en: { subject: 'x', html: 'x'.repeat(100_001) } });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({ code: 'textTooLong', params: { max: 100_000 } });
    expect((await fetchWorker('/api/email-templates?key=login_admin', withCookie(cookie, jsonInit('PUT', {})))).status).toBe(400);
    expect((await getTemplate(cookie, 'login_admin')).languages.en.customized).toBe(false);
  });
});

describe('verification email', () => {
  it('uses the saved template, escaping HTML in the name inside the body but not in the plain-text subject', async ({ expect }) => {
    const cookie = await login(SEEDED.admin.email, 'admin');
    const email = `tpl-${Date.now()}@example.com`;
    await fetchWorker('/api/students', withCookie(cookie, jsonInit('POST', { name: '王<b>小明</b>', email })));
    await saveTemplate(cookie, 'login_student', { 'zh-Hant': { subject: '驗證碼 {{code}}：{{name}}', html: '<p>{{name}}，驗證碼 {{code}}</p><p>{{typo}}</p>' } });

    env.MS_CLIENT_SECRET = 'test-secret';
    const calls = mockGraph();
    expect((await requestOtp(email, 'student')).status).toBe(200);
    const code = await latestOtpCode(email, 'student');

    const [mail] = sentMails(calls);
    expect(mail.to).toBe(email);
    expect(mail.subject).toBe(`驗證碼 ${code}：王<b>小明</b>`);
    // 範本裡打錯的變數原樣留著，看得出來是哪裡打錯
    expect(mail.html).toBe(`<p>王&lt;b&gt;小明&lt;/b&gt;，驗證碼 ${code}</p><p>{{typo}}</p>`);
  });
});

describe('booking notification emails', () => {
  it("emails the student and the teacher when a booking is made and when it's cancelled, in each one's language and timezone", async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = (await (await fetchWorker('/api/courses', withCookie(adminCookie, jsonInit('POST', { name: '通知信測試' })))).json()) as { id: number; name: string };
    await makeTeacherBookable(course.id);
    const student = (await env.DB.prepare(`SELECT id, name FROM students WHERE email = ?`).bind(SEEDED.student.email).first<{ id: number; name: string }>())!;
    const teacher = (await env.DB.prepare(`SELECT id, name FROM teachers WHERE email = ?`).bind(SEEDED.teacher.email).first<{ id: number; name: string }>())!;
    expect(teacher.id).toBe(1);
    await fetchWorker(`/api/students/courses?studentId=${student.id}`, withCookie(adminCookie, jsonInit('POST', { courseName: course.name })));
    // 學生：日文、東京（UTC+9）；老師：英文、仰光（UTC+6:30）
    await env.DB.prepare(`UPDATE students SET language = 'ja', timezone = 'UTC+09:00 東京' WHERE id = ?`).bind(student.id).run();
    await env.DB.prepare(`UPDATE teachers SET language = 'en', receipt_json = json_set(COALESCE(receipt_json, '{}'), '$.timezone', 'UTC+06:30 仰光') WHERE id = ?`).bind(teacher.id).run();
    const studentCookie = await login(SEEDED.student.email, 'student');

    env.MS_CLIENT_SECRET = 'test-secret';
    const calls = mockGraph();
    const date = new Date(Date.now() + 8 * 3_600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
    const ymd = date.replace(/-/g, '/');
    const res = await fetchWorker('/api/bookings', withCookie(studentCookie, jsonInit('POST', { courseId: course.id, teacherId: teacher.id, date, time: '10:00' })));
    expect(res.status).toBe(201);
    const booking = (await res.json()) as { id: number; bookingCode: string };

    await vi.waitFor(() => expect(sentMails(calls)).toHaveLength(2));
    const created = sentMails(calls);
    const toStudent = created.find((m) => m.to === SEEDED.student.email)!;
    const toTeacher = created.find((m) => m.to === SEEDED.teacher.email)!;
    expect(toStudent.subject).toBe(`【JPTIP】予約完了：通知信測試 ${ymd} 11:00`);
    expect(toStudent.html).toContain(`${ymd} 11:00（UTC+09:00）`);
    expect(toStudent.html).toContain(booking.bookingCode);
    expect(toStudent.html).toContain(teacher.name);
    expect(toTeacher.subject).toBe(`[JPTIP] New booking: ${student.name} ${ymd} 08:30`);
    expect(toTeacher.html).toContain(`${ymd} 08:30 (UTC+06:30)`);
    expect(toTeacher.html).toContain('https://example.com/assets/icons/');

    const cancelled = await fetchWorker(`/api/bookings?id=${booking.id}`, withCookie(studentCookie, jsonInit('PATCH', { status: 'cancelled' })));
    expect(cancelled.status).toBe(200);
    await vi.waitFor(() => expect(sentMails(calls)).toHaveLength(4));
    const cancelMails = sentMails(calls).slice(2);
    expect(cancelMails.find((m) => m.to === SEEDED.student.email)!.subject).toBe(`【JPTIP】予約キャンセル：通知信測試 ${ymd} 11:00`);
    expect(cancelMails.find((m) => m.to === SEEDED.teacher.email)!.subject).toBe(`[JPTIP] Booking cancelled: ${student.name} ${ymd} 08:30`);
  });

  it('sends nothing when the mail secret is not set', async ({ expect }) => {
    const adminCookie = await login(SEEDED.admin.email, 'admin');
    const course = (await (await fetchWorker('/api/courses', withCookie(adminCookie, jsonInit('POST', { name: '不寄信測試' })))).json()) as { id: number; name: string };
    await makeTeacherBookable(course.id);
    const student = (await env.DB.prepare(`SELECT id FROM students WHERE email = ?`).bind(SEEDED.student.email).first<{ id: number }>())!;
    await fetchWorker(`/api/students/courses?studentId=${student.id}`, withCookie(adminCookie, jsonInit('POST', { courseName: course.name })));
    const studentCookie = await login(SEEDED.student.email, 'student');

    const calls = mockGraph();
    const date = new Date(Date.now() + 8 * 3_600_000 + 11 * 86_400_000).toISOString().slice(0, 10);
    const res = await fetchWorker('/api/bookings', withCookie(studentCookie, jsonInit('POST', { courseId: course.id, teacherId: 1, date, time: '10:00' })));
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(0);
  });
});
