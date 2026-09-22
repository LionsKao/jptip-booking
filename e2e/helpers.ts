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

// Seeds the mock course catalog + a bookable weekly window for teacher id 1,
// matching the shapes public/script.js and student/booking.html expect.
// Nothing in this project auto-seeds courses (unlike teachers/students), so
// booking-flow tests need this before they can select anything.
export async function seedBookableCourse(page: Page) {
  await page.addInitScript(() => {
    // addInitScript re-runs on every navigation in this test, not just the
    // first — without this guard it would re-seed (and so wipe out) the
    // booking that was just created by a later step in the same test.
    if (window.localStorage.getItem('e2e-seeded')) return;
    window.localStorage.setItem('e2e-seeded', '1');

    const course = {
      id: 1,
      name: 'N5 綜合日本語 J1',
      description: '入門日文會話與文法',
      status: 'active',
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      scheduleIncrement: '60 分鐘',
      minLeadHours: 0,
      maxLeadDays: 60,
    };
    window.localStorage.setItem('admin-courses', JSON.stringify([course]));

    // Teacher id 1 (田中老師) must offer this course and have a weekly slot.
    const teachers = [{
      id: 1,
      name: '田中老師',
      email: 'teacher1@jptip.co.jp',
      avatar: '001-bear.png',
      specialty: '日文會話',
      motto: '',
      status: 'active',
      courses: [course.name],
    }];
    window.localStorage.setItem('admin-teachers', JSON.stringify(teachers));

    const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][new Date().getDay()];
    window.localStorage.setItem('teacher-hours', JSON.stringify({
      1: [{ id: 1, day: weekday, start: '00:00', end: '23:30' }],
    }));

    // The student must already own the course with unused booking quota,
    // matching how public/script.js's own loadStudents() seed shapes it.
    const students = [{
      id: 1, name: '王品硯', phone: '', email: 'student1@jptip.co.jp', avatar: '002-rabbit.png',
      courses: [{ id: 101, name: course.name, status: 'ongoing', attended: '0/16', booked: '0/16' }],
      bookings: [],
    }];
    window.localStorage.setItem('admin-students', JSON.stringify(students));
  });
}
