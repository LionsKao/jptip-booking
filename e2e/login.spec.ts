import { expect, test } from '@playwright/test';
import { login, SEEDED } from './helpers';

test('student login redirects to the student home', async ({ page }) => {
  await login(page, 'student', SEEDED.student.email);
  await expect(page).toHaveURL(/\/student\/$/);
  await expect(page.getByRole('heading', { name: '新增預約' })).toBeVisible();
});

test('teacher login redirects to the teacher home', async ({ page }) => {
  await login(page, 'teacher', SEEDED.teacher.email);
  await expect(page).toHaveURL(/\/teacher\/$/);
});

test('admin login redirects to the admin home', async ({ page }) => {
  await login(page, 'admin', SEEDED.admin.email);
  await expect(page).toHaveURL(/\/admin\/$/);
  await expect(page.getByRole('heading', { name: '學生管理' })).toBeVisible();
});

test('an email with no matching account is rejected before any code is sent', async ({ page }) => {
  await page.goto('/');
  await page.locator('#entry-cards [data-role="student"]').click();
  await page.locator('#login-email').fill('nobody@jptip.co.jp');
  await page.locator('[data-login-send]').click();

  await expect(page.locator('#login-alert-text')).toHaveText('無此帳號');
  // Still on step 1 — the OTP boxes never became enabled.
  await expect(page.locator('.otp-box').first()).toBeDisabled();
});

test('logging out ends the session, and the page it returns to is not the protected one', async ({ page }) => {
  await login(page, 'admin', SEEDED.admin.email);

  await page.locator('#logout-btn').click();
  await page.locator('#logout-confirm-btn').click();

  await expect(page).toHaveURL('/');
  // The old page is gone server-side, not just client-navigated away from:
  // going back to it directly should now bounce to login again.
  await page.goto('/admin/');
  await expect(page).toHaveURL('/');
});
