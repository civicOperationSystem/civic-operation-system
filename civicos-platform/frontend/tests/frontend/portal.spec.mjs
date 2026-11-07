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
