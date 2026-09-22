import { expect, test } from '@playwright/test';
import { login, SEEDED } from './helpers';

test('visiting an admin page with no session redirects to the login page', async ({ page }) => {
  await page.goto('/admin/students.html');
  await expect(page).toHaveURL('/');
});

test('visiting a teacher page with no session redirects to the login page', async ({ page }) => {
  await page.goto('/teacher/hours.html');
  await expect(page).toHaveURL('/');
});

test('a student session cannot reach the teacher area', async ({ page }) => {
  await login(page, 'student', SEEDED.student.email);
  await page.goto('/teacher/');
  await expect(page).toHaveURL('/');
});

test('a teacher session cannot reach the admin area', async ({ page }) => {
  await login(page, 'teacher', SEEDED.teacher.email);
  await page.goto('/admin/');
  await expect(page).toHaveURL('/');
});

test('an admin session can reach the teacher area (manages teachers on their behalf)', async ({ page }) => {
  await login(page, 'admin', SEEDED.admin.email);
  await page.goto('/teacher/hours.html?teacherId=1');
  // Workers Assets drops the .html extension on the way through.
  await expect(page).toHaveURL(/\/teacher\/hours\?teacherId=1$/);
});

test('email.html and ui.html are reachable on the local/test site', async ({ page }) => {
  const email = await page.goto('/email.html');
  expect(email?.status()).toBe(200);
  const ui = await page.goto('/ui.html');
  expect(ui?.status()).toBe(200);
});
