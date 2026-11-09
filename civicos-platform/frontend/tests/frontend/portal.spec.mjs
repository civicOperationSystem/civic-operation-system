import { test, expect, portal } from './fixtures.mjs';

test('the portal does not display the map-domain organization picker', async ({ page }) => {
  await page.goto(`/portal/${portal.slug}`);
  await page.getByRole('navigation', { name: 'Portal sections' }).getByRole('button', { name: 'Explore the map', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Organization' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open the standalone community map' }))
    .toHaveAttribute('href', `http://127.0.0.1:3311/civic?org=${portal.slug}`);
});

test('standalone map autocomplete selects and opens an organization on the map domain', async ({ page }) => {
  await page.goto('http://127.0.0.1:3311/civic');
  const organization = page.getByLabel('Organization');
  await organization.fill('river');
  await expect(page.locator('#map-organizations option')).toHaveCount(1);
  await organization.fill('Riverside Community');
  await page.getByRole('button', { name: 'Open community map' }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3311\/civic\?org=riverside-community$/);
  await expect(page.getByRole('status').filter({ hasText: 'authorized locations' })).toHaveText('0 authorized locations');
});

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

test('direct community navigation shows a loading state until portal data arrives', async ({ page, mockApi }) => {
  let releasePortal;
  const portalResponse = new Promise(resolve => { releasePortal = resolve; });
  mockApi.handle('GET', `/api/civic/public/${portal.slug}`, async () => {
    await portalResponse;
    return { json: portal };
  });

  await page.goto(`/portal/${portal.slug}`);
  await expect(page.getByRole('status')).toHaveText('Loading public information. This usually takes a moment.');
  releasePortal();
  await expect(page.getByRole('heading', { name: portal.name, exact: true })).toBeVisible();
});

test('organization directory errors can be retried without reloading the public site', async ({ page, mockApi }) => {
  mockApi.handle('GET', '/api/civic/public/organizations/list', () => ({
    status: 503, json: { message: 'Directory temporarily unavailable' },
  }));
  await page.goto('/portal');
  await expect(page.getByRole('alert').filter({ hasText: 'Directory temporarily unavailable' })).toBeVisible();

  mockApi.handle('GET', '/api/civic/public/organizations/list', () => ({
    json: [{ name: portal.name, slug: portal.slug }],
  }));
  await page.getByRole('button', { name: 'Retry loading organizations' }).click();
  await expect(page.getByRole('link', { name: `Open ${portal.name} portal` })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Protect this offline report' })).toBeVisible();
  await page.getByLabel('Offline passphrase', { exact: true }).fill('CivicOS-offline-report-test-passphrase');
  await page.getByLabel('Confirm offline passphrase', { exact: true }).fill('CivicOS-offline-report-test-passphrase');
  await page.getByRole('button', { name: 'Set passphrase and encrypt report' }).click();
  const savedReports = page.getByRole('region', { name: 'Saved public reports' });
  await expect(savedReports.getByText(/Waiting to send/)).toBeVisible();
  const storedReport = await page.evaluate(async slug => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('civicos-offline-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const cache = await new Promise((resolve, reject) => {
      const request = db.transaction('portals').objectStore('portals').get(slug);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return cache.reports[0].report;
  }, portal.slug);
  expect(storedReport).toMatchObject({ version: 1 });
  expect(JSON.stringify(storedReport)).not.toContain('Report saved while offline');
  expect(JSON.stringify(storedReport)).not.toContain('Community garden');
  expect(submissions).toBe(0);
  await context.setOffline(false);
  await expect(savedReports.getByText(/Submitted · Tracking reference/)).toBeVisible();
  expect(submissions).toBe(1);
});
