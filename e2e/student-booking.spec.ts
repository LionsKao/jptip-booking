import { expect, test } from '@playwright/test';
import { login, seedBookableCourse, SEEDED } from './helpers';

test('a student can complete the full booking wizard and see it in their history', async ({ page }) => {
  await seedBookableCourse(page);
  await login(page, 'student', SEEDED.student.email);

  await page.locator('[data-action="new-booking"]').click();
  // Workers Assets drops the .html extension on the way through.
  await expect(page).toHaveURL(/\/student\/booking$/);

  // Step 1: notice screen.
  await page.locator('#start-booking').click();

  // Step 2: course — seeded so the student owns exactly one, which
  // renderCourseCards() auto-selects.
  await expect(page.locator('.booking-step[data-step="2"] .course-card.selected')).toBeVisible();
  await page.locator('.booking-step[data-step="2"] [data-wizard-next="3"]').click();

  // Step 3: teacher — same auto-select-when-only-one behaviour.
  await expect(page.locator('#teachers .teacher-card.selected')).toBeVisible();
  await page.locator('.booking-step[data-step="3"] [data-wizard-next="4"]').click();

  // Step 4: date (today, seeded as bookable) + a time slot.
  await page.locator('.datepicker-grid button.today').click();
  await page.locator('.time-slots .time-slot').first().click();
  await page.locator('.booking-step[data-step="4"] [data-wizard-next="5"]').click();

  // Step 5: confirm — course/teacher names carried through from earlier steps.
  await expect(page.locator('[data-confirm-course]')).toHaveText('N5 綜合日本語 J1');
  await expect(page.locator('[data-confirm-teacher]')).toHaveText('田中老師');
  await page.locator('#submit-booking').click();

  await expect(page.getByText('預約成功！')).toBeVisible();

  await page.locator('#back-home-btn').click();
  await page.locator('[data-action="booking-history"]').click();
  await expect(page).toHaveURL(/\/student\/booking-history$/);

  const todayCard = page.locator('#today-cards .booking-card', { hasText: 'N5 綜合日本語 J1' });
  await expect(todayCard).toBeVisible();
  await expect(todayCard).toContainText('田中老師');
});

test('cannot advance past the date/time step without picking both', async ({ page }) => {
  await seedBookableCourse(page);
  await login(page, 'student', SEEDED.student.email);
  await page.goto('/student/booking.html');
  await page.locator('#start-booking').click();
  await page.locator('.booking-step[data-step="2"] [data-wizard-next="3"]').click();
  await page.locator('.booking-step[data-step="3"] [data-wizard-next="4"]').click();

  // Neither a date nor a time slot has been picked yet.
  await page.locator('.booking-step[data-step="4"] [data-wizard-next="5"]').click();
  await expect(page.locator('#booking-alert-text')).toHaveText('請先選擇日期與時間');
  await expect(page.locator('.booking-step[data-step="4"]')).toBeVisible();
});
