import { test, expect, portal } from './fixtures.mjs';

test('staff sign-in sends a mocked magic-link request and shows authentication failures', async ({ page, context }) => {
  let email;
  await context.route('https://frontend-only.test/auth/v1/otp**', route => {
    email = route.request().postDataJSON().email;
    return route.fulfill({ json: {} });
  });
  await page.goto(`/staff?org=${portal.slug}`);
  await page.getByLabel('Offline passphrase', { exact: true }).fill('CivicOS-frontend-test-passphrase');
  await page.getByLabel('Confirm offline passphrase').fill('CivicOS-frontend-test-passphrase');
  await page.getByRole('button', { name: 'Set passphrase' }).click();
  await expect(page.getByLabel('Organization')).toHaveAttribute('readonly', '');
  await page.getByLabel('Email', { exact: true }).fill('staff@example.org');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'one-time sign-in link has been sent' })).toBeVisible();
  expect(email).toBe('staff@example.org');
  await context.route('https://frontend-only.test/auth/v1/otp**', route => route.fulfill({
    status: 503, json: { message: 'Sign-in temporarily unavailable' },
  }));
  await page.getByLabel('Email', { exact: true }).fill('staff@example.org');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Sign-in temporarily unavailable' })).toBeVisible();
});
