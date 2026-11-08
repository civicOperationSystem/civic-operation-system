import { test, expect, portal } from './fixtures.mjs';

test('directory search opens the selected public portal', async ({ page }) => {
  await page.goto('/portal');
  await expect(page.getByText('No portal is configured for this domain')).toHaveCount(0);
  const search = page.getByRole('combobox', { name: 'Organization name or workspace address', exact: true });
  await search.fill('no-matching-organization');
  await expect(page.getByText('No organizations match your search.')).toBeVisible();
  await search.fill(portal.name);
  await page.getByRole('link', { name: `Open ${portal.name} portal` }).click();
  await expect(page.getByRole('heading', { name: portal.name, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Staff sign in' })).toHaveAttribute('href', `/staff?org=${portal.slug}`);
});

test('map organization autocomplete opens the selected community', async ({ page }) => {
  await page.goto(`/portal/${portal.slug}`);
  await page.getByRole('navigation', { name: 'Portal sections' }).getByRole('button', { name: 'Explore the map', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'Go to a community' });
  await search.fill('Riverside');
  await expect(page.locator('#map-organization-suggestions option')).toHaveCount(1);
  await search.fill('Riverside Community');
  await page.getByRole('button', { name: 'Open community' }).click();
  await expect(page.getByRole('heading', { name: 'Riverside Community', exact: true })).toBeVisible();
});

test('resident submits a report through the mocked API', async ({ page, mockApi }) => {
  let submitted;
  const reference = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-0000-1111';
  mockApi.handle('POST', `/api/civic/public/${portal.slug}/requests`, request => {
    submitted = request.postDataJSON();
    return { status: 201, json: { reference } };
  });
  await page.goto(`/portal/${portal.slug}`);
  await page.getByRole('navigation', { name: 'Portal sections' }).getByRole('button', { name: 'Report a problem', exact: true }).click();
  await page.getByLabel('What happened?', { exact: true }).fill('Broken pavement');
  await page.getByLabel('Location', { exact: true }).fill('Community garden');
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Request received.' }).getByText(reference, { exact: true })).toBeVisible();
  expect(submitted).toMatchObject({ category: 'Pothole', description: 'Broken pavement', location: 'Community garden', anonymous: true });
  await page.reload();
  await expect(page.getByRole('region', { name: 'Saved public reports' }).getByText(reference, { exact: true })).toBeVisible();
});

test('refresh status stays distinct from the offline notice and preserves a report draft', async ({ page, mockApi }) => {
  await page.goto(`/portal/${portal.slug}`);
  await expect(page.getByRole('status').filter({ hasText: 'Public information is saved' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Portal sections' }).getByRole('button', { name: 'Report a problem', exact: true }).click();
  await page.getByLabel('What happened?', { exact: true }).fill('Unfinished resident report');
  await page.getByLabel('Location', { exact: true }).fill('Library entrance');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Portal refreshed.' })).toHaveText('Portal refreshed.');
  await expect(page.getByRole('status').filter({ hasText: 'Public information is saved' })).toBeVisible();
  await expect(page.getByLabel('What happened?', { exact: true })).toHaveValue('Unfinished resident report');
  await expect(page.getByLabel('Location', { exact: true })).toHaveValue('Library entrance');
  mockApi.handle('GET', `/api/civic/public/${portal.slug}/content`, () => ({
    status: 503, json: { message: 'Refresh temporarily unavailable' },
  }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const refreshError = page.getByRole('alert').filter({ hasText: 'Refresh temporarily unavailable' });
  await expect(refreshError).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Portal refreshed.' })).toHaveCount(0);
  await expect(page.getByLabel('What happened?', { exact: true })).toHaveValue('Unfinished resident report');
  await expect(page.getByLabel('Location', { exact: true })).toHaveValue('Library entrance');
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  mockApi.handle('GET', `/api/civic/public/${portal.slug}/content`, () => ({ json: [] }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Portal refreshed.' })).toHaveText('Portal refreshed.');
  await expect(refreshError).toHaveCount(0);
  await expect(page.getByLabel('What happened?', { exact: true })).toHaveValue('Unfinished resident report');
  await expect(page.getByLabel('Location', { exact: true })).toHaveValue('Library entrance');
});

test('public reports stay queued offline and submit once after reconnection', async ({ page, context, mockApi }) => {
  let submissions = 0;
  mockApi.handle('POST', `/api/civic/public/${portal.slug}/requests`, () => {
    submissions++;
    return { status: 201, json: { reference: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-0000-2222' } };
  });
  await page.goto(`/portal/${portal.slug}`);
  await expect(page.getByRole('status').filter({ hasText: 'Public information is saved' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Portal sections' }).getByRole('button', { name: 'Report a problem', exact: true }).click();
  await context.setOffline(true);
  await page.getByLabel('Category').selectOption('Pothole');
  await page.getByLabel('What happened?', { exact: true }).fill('Report saved while offline');
  await page.getByLabel('Location', { exact: true }).fill('Community garden');
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  const savedReports = page.getByRole('region', { name: 'Saved public reports' });
  await expect(savedReports.getByText(/Waiting to send/)).toBeVisible();
  expect(submissions).toBe(0);
  await context.setOffline(false);
  await expect(savedReports.getByText(/Submitted · Tracking reference/)).toBeVisible();
  expect(submissions).toBe(1);
});
