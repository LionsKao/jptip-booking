import { expect, test } from '@playwright/test';
import { login, seedBookableCourse, SEEDED } from './helpers';

test('a student can complete the full booking wizard and see it in their history', async ({ page }) => {
  const { courseName } = await seedBookableCourse(page);
  await login(page, 'student', SEEDED.student.email);

  await page.locator('[data-action="new-booking"]').click();
  // Workers Assets drops the .html extension on the way through.
  await expect(page).toHaveURL(/\/student\/booking$/);

  // Step 1: notice screen.
  await page.locator('#start-booking').click();

  // Step 2: course — pick the one this test seeded explicitly. The local
  // dev D1 isn't reset between runs, so this student accumulates other
  // owned courses from earlier test runs over time; renderCourseCards()
  // only auto-selects when there's exactly one, so don't rely on that.
  const courseCard = page.locator('.booking-step[data-step="2"] .course-card', { hasText: courseName });
  await courseCard.click();
  await expect(courseCard).toHaveClass(/selected/);
  await page.locator('.booking-step[data-step="2"] [data-wizard-next="3"]').click();

  // Step 3: teacher — same auto-select-when-only-one behaviour.
  await expect(page.locator('#teachers .teacher-card.selected')).toBeVisible();
  // Entering step 4 kicks off ensureScheduleCache() (hours/leave/bookings for
  // the selected teacher), which refreshDayDisabledStates() depends on to mark
  // any day disabled at all. `networkidle` is not a reliable signal for these
  // specifically — since they're fired *by* this click rather than already
  // in flight when the wait starts, Playwright's idle window can elapse
  // before they're even issued, letting a genuinely-unavailable day (already
  // past, still `.selected`-free of `.disabled`) get picked below. Waiting
  // for the actual responses tied to this click removes that race.
  await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/teachers/hours') && res.ok()),
    page.waitForResponse((res) => res.url().includes('/api/teachers/leave') && res.ok()),
    page.waitForResponse((res) => res.url().includes('/api/bookings') && res.ok()),
    page.locator('.booking-step[data-step="3"] [data-wizard-next="4"]').click(),
  ]);

  // Step 4: pick whichever day the calendar actually left bookable — every
  // weekday is seeded as available, but "today" can run out of remaining
  // slots late in the day (or, on a heavily-reused local dev D1, run out
  // for weeks), so don't assume it specifically. The datepicker widget's own
  // click handler replaces its entire button grid synchronously on every
  // click (script.js's render()), which makes Playwright's real-mouse click
  // path (hover, then a stability/hit-test check, then mousedown/mouseup)
  // flake with "intercepts pointer events" against that churn. Dispatching
  // the click straight to the DOM sidesteps that hit-testing entirely and is
  // reliable here.
  await page.evaluate(() => {
    const day = [...document.querySelectorAll('.datepicker-grid button')]
      .find((b) => !b.classList.contains('muted') && !b.classList.contains('disabled'));
    (day as HTMLElement).click();
  });
  // Disabled placeholder slots render too now (so the panel isn't blank
  // before a date is picked) — only the bookable ones are clickable.
  await page.locator('.time-slots .time-slot:not(.disabled)').first().click();
  await page.locator('.booking-step[data-step="4"] [data-wizard-next="5"]').click();

  // Step 5: confirm — course/teacher names carried through from earlier steps.
  await expect(page.locator('[data-confirm-course]')).toHaveText(courseName);
  await expect(page.locator('[data-confirm-teacher]')).toHaveText('田中老師');
  await page.locator('#submit-booking').click();

  await expect(page.getByText('預約成功！')).toBeVisible();

  await page.locator('#back-home-btn').click();
  await page.locator('[data-action="booking-history"]').click();
  await expect(page).toHaveURL(/\/student\/booking-history$/);

  // history-cards (not today-cards) — the booking may land on any of the
  // seeded-available days, not necessarily today.
  const bookingCard = page.locator('#history-cards .booking-card', { hasText: courseName });
  await expect(bookingCard).toBeVisible();
  await expect(bookingCard).toContainText('田中老師');
});

test('cannot advance past the date/time step without picking both', async ({ page }) => {
  const { courseName } = await seedBookableCourse(page);
  await login(page, 'student', SEEDED.student.email);
  await page.goto('/student/booking.html');
  await page.locator('#start-booking').click();
  await page.locator('.booking-step[data-step="2"] .course-card', { hasText: courseName }).click();
  await page.locator('.booking-step[data-step="2"] [data-wizard-next="3"]').click();
  await page.locator('.booking-step[data-step="3"] [data-wizard-next="4"]').click();

  // Neither a date nor a time slot has been picked yet.
  await page.locator('.booking-step[data-step="4"] [data-wizard-next="5"]').click();
  await expect(page.locator('#booking-alert-text')).toHaveText('請先選擇日期與時間');
  await expect(page.locator('.booking-step[data-step="4"]')).toBeVisible();
});
