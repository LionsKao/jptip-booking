import type { Page } from '@playwright/test';

export const SEEDED = {
  student: { email: 'student1@jptip.co.jp', role: 'student' as const },
  teacher: { email: 'teacher1@jptip.co.jp', role: 'teacher' as const },
  admin: { email: 'admin1@jptip.co.jp', role: 'admin' as const },
};

// Drives the real login UI end to end (role card -> email -> OTP) using the
// local dev site's ALLOW_ANY_OTP bypass (any 6-digit code), and waits for
// the resulting redirect into that role's home page.
export async function login(page: Page, role: 'student' | 'teacher' | 'admin', email: string) {
  await page.goto('/');
  await page.locator(`#entry-cards [data-role="${role}"]`).click();

  await page.locator('#login-email').fill(email);
  await page.locator('[data-login-send]').click();
  await page.locator('#loginAlertModal .btn.blue[data-modal-close]').click();

  const otpBoxes = page.locator('.otp-box');
  const digits = '135790';
  for (let i = 0; i < 6; i++) {
    await otpBoxes.nth(i).fill(digits[i]);
  }
  await page.locator('[data-login-submit]').click();

  await page.waitForURL(`**/${role}/`);
}

// Teachers/students/courses/hours/bookings are all real D1 data now — this
// seeds everything a booking test needs via the real API (as admin), then
// logs out so the caller's own login (whichever role the test is actually
// about) starts from scratch. The course name is unique per call: the local
// dev D1 isn't reset between runs, so a fixed name would pile up duplicate
// courses across runs and break the "only one course card" assumption
// booking-flow tests rely on.
export async function seedBookableCourse(page: Page): Promise<{ courseName: string }> {
  const courseName = `E2E 測試課程 ${Date.now()}`;

  await login(page, 'admin', SEEDED.admin.email);

  // The local dev D1 isn't reset between runs and may carry extra rows from
  // earlier manual testing (e.g. a real account added ahead of the seeded
  // quick-login ones) — never assume "student1@jptip.co.jp is id 1", always
  // resolve the real id by email.
  const [course, teacherId, studentId] = await page.evaluate(async ({ name, teacherEmail, studentEmail }) => {
    // POST /api/courses only accepts the fields course-add.html's form has
    // (name/description/image/status) — duration/buffer/increment/lead-time
    // stay at their DB defaults (100min, 20min after-buffer, 1hr increment,
    // 48hr min lead, 30 day max), same as a real admin creating a course
    // would get before visiting course-detail.html to tune them. That's a
    // perfectly bookable config on its own, no need to also PATCH it here.
    const course = await fetch('/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: '入門日文會話與文法', status: 'active' }),
    }).then((res) => res.json()) as { id: number; name: string };

    const teachers = await fetch('/api/teachers').then((res) => res.json()) as { id: number; email: string }[];
    const teacherId = teachers.find((t) => t.email === teacherEmail)!.id;

    const students = await fetch('/api/students').then((res) => res.json()) as { id: number; email: string }[];
    const studentId = students.find((s) => s.email === studentEmail)!.id;

    return [course, teacherId, studentId] as const;
  }, { name: courseName, teacherEmail: SEEDED.teacher.email, studentEmail: SEEDED.student.email });

  await page.evaluate(({ name, teacherId }) => fetch(`/api/teachers/courses?teacherId=${teacherId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseName: name, action: 'add' }),
  }), { name: courseName, teacherId });

  // The seeded teacher needs a bookable slot on every weekday — a slot must
  // still be later than "now" to be bookable, so if the suite runs late in
  // the evening today may have nothing left; the booking test picks
  // whichever day in the calendar actually comes back enabled instead of
  // assuming "today". Clear any hours left over from a previous run first
  // so they don't pile up indefinitely across local dev runs.
  await page.evaluate(async (teacherId) => {
    const existing = await fetch(`/api/teachers/hours?teacherId=${teacherId}`).then((res) => res.json()) as { id: number }[];
    await Promise.all(existing.map((h) => fetch(`/api/teachers/hours?teacherId=${teacherId}&id=${h.id}`, { method: 'DELETE' })));

    const ALL_WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    await Promise.all(ALL_WEEKDAYS.map((day) => fetch(`/api/teachers/hours?teacherId=${teacherId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day, start: '00:00', end: '23:30' }),
    })));
  }, teacherId);

  // The student must already own the course with unused booking quota.
  await page.evaluate(({ name, studentId }) => fetch(`/api/students/courses?studentId=${studentId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseName: name, totalSessions: 16 }),
  }), { name: courseName, studentId });

  await page.evaluate(() => fetch('/api/logout', { method: 'POST' }));

  return { courseName: course.name };
}
