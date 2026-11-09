import { test, expect, portal } from './fixtures.mjs';

const passphrase = 'CivicOS-frontend-test-passphrase';

test('staff offline data requires unlock and can be cleared from this device', async ({ page }) => {
  await page.goto(`/staff?org=${portal.slug}`);
  await page.getByLabel('Offline passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm offline passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Set passphrase' }).click();
  await expect(page.getByLabel('Organization')).toBeVisible();

  await page.getByRole('button', { name: 'Lock offline data' }).click();
  await page.getByLabel('Offline passphrase', { exact: true }).fill('Incorrect-passphrase');
  await page.getByRole('button', { name: 'Unlock offline data' }).click();
  await expect(page.locator('p[role="alert"]').filter({ hasText: 'incorrect' })).toBeVisible();

  await page.getByLabel('Offline passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock offline data' }).click();
  await expect(page.getByLabel('Organization')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear this device’s offline data' }).click();
  await expect(page.getByRole('heading', { name: 'Protect offline access' })).toBeVisible();
});
