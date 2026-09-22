import { expect, test } from '@playwright/test';
import { login, SEEDED } from './helpers';

// Both tests below seed teacher id 1's hours — run serially so they can't
// race each other's clear-then-write under Playwright's default parallel
// workers (one test's DELETE landing between the other's DELETE and POST
// would silently wipe out the slot it just wrote).
test.describe.configure({ mode: 'serial' });

// Teacher hours are real D1 data now (no more client-seeded mock default),
// so each test seeds exactly what it needs via the real API — clearing any
// leftover rows from a previous run first, since the local dev D1 isn't
// reset between runs.
async function setTeacherHours(page: import('@playwright/test').Page, teacherId: number, slots: { day: string; start: string; end: string }[]) {
  await page.evaluate(async ({ teacherId, slots }) => {
    const existing = await fetch(`/api/teachers/hours?teacherId=${teacherId}`).then((res) => res.json()) as { id: number }[];
    await Promise.all(existing.map((h) => fetch(`/api/teachers/hours?teacherId=${teacherId}&id=${h.id}`, { method: 'DELETE' })));
    await Promise.all(slots.map((slot) => fetch(`/api/teachers/hours?teacherId=${teacherId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slot),
    })));
  }, { teacherId, slots });
}

test('admin can drill from the teacher list into a teacher\'s hours page', async ({ page }) => {
  await login(page, 'admin', SEEDED.admin.email);
  await setTeacherHours(page, 1, [{ day: '星期一', start: '09:00', end: '12:00' }]);

  // Workers Assets drops the .html extension on the way through, so these
  // patterns match the canonical (extensionless) URLs it redirects to.
  await page.locator('[data-action="teachers"]').click();
  await expect(page).toHaveURL(/\/admin\/teachers$/);

  await page.locator('.teacher-list-card[data-id="1"]').click();
  await expect(page).toHaveURL(/\/admin\/teacher-detail\?id=1$/);
  await expect(page.getByRole('heading', { name: '田中老師' })).toBeVisible();

  await page.locator('#hours-entry-card').click();
  await expect(page).toHaveURL(/\/teacher\/hours\?teacherId=1$/);

  // The auto-seeded demo hours for teacher id 1 (see teacher/hours.html) —
  // confirms the page resolved *this specific teacher's* real data, not an
  // empty/wrong one, and that the admin-viewing back button wired up right.
  await expect(page.getByText('09:00 - 12:00')).toBeVisible();
  await page.locator('#back-btn').click();
  await expect(page).toHaveURL(/\/admin\/teacher-detail\?id=1$/);
});

test('the same teacher, viewed by two different logged-in teachers, shows different hours', async ({ browser }) => {
  const teacher1 = await browser.newContext();
  const teacher2 = await browser.newContext();
  try {
    const page1 = await teacher1.newPage();
    const page2 = await teacher2.newPage();

    await login(page1, 'teacher', 'teacher1@jptip.co.jp');
    await login(page2, 'teacher', 'teacher2@jptip.co.jp');
    await setTeacherHours(page1, 1, [{ day: '星期一', start: '09:00', end: '12:00' }]);
    await setTeacherHours(page2, 2, []);

    await page1.goto('/teacher/hours.html');
    await page2.goto('/teacher/hours.html');

    await expect(page1.getByText('09:00 - 12:00')).toBeVisible();
    await expect(page2.getByText('無設定').first()).toBeVisible();
  } finally {
    await teacher1.close();
    await teacher2.close();
  }
});
