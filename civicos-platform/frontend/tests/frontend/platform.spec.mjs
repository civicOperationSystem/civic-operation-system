import { test, expect } from './fixtures.mjs';
import { magicLinkCallback } from '../e2e/helpers.mjs';

test('platform owner creates an organization with mocked authentication and persistence', async ({ page, context, mockApi }) => {
  const user = { id: 'frontend-owner', email: 'owner@example.org', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} };
  await context.route('https://frontend-only.test/auth/v1/user', route => route.fulfill({ json: user }));
  mockApi.handle('POST', '/api/civic/platform/login', () => ({ json: { token: 'frontend-platform-token' } }));
  const organizations = [];
  mockApi.handle('GET', '/api/civic/platform/organizations', () => ({ json: organizations }));
  mockApi.handle('POST', '/api/civic/platform/organizations', request => {
    const data = request.postDataJSON();
    const organization = { ...data, id: 'new-town', domain: data.domain || null, archived_at: null, admins: [] };
    organizations.push(organization);
    return { status: 201, json: { organization } };
  });
  await page.goto(magicLinkCallback('/platform', user.email));
  await expect(page.getByRole('heading', { name: 'Organization administration' })).toBeVisible();
  await page.getByLabel('Organization name', { exact: true }).fill('New Test Town');
  await page.getByLabel('Organization slug', { exact: true }).fill('new-test-town');
  await page.getByLabel('Bottom admin email', { exact: true }).fill('admin@example.org');
  await page.getByRole('button', { name: 'Create organization', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Organization created.');
  await expect(page.getByRole('heading', { name: 'New Test Town', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'New Test Town', exact: true })).toBeVisible();
  expect(organizations).toHaveLength(1);
});
