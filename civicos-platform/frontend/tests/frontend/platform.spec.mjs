import { test, expect } from './fixtures.mjs';
import { magicLinkCallback } from '../e2e/helpers.mjs';

test('platform owner creates an organization with mocked authentication and persistence', async ({ page, context, mockApi }) => {
  const user = { id: 'frontend-owner', email: 'owner@example.org', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} };
  await context.route('https://frontend-only.test/auth/v1/user', route => route.fulfill({ json: user }));
  mockApi.handle('POST', '/api/civic/platform/login', () => ({ json: { token: 'frontend-platform-token' } }));
  const organizations = [];
  mockApi.handle('GET', '/api/civic/platform/organizations', () => ({ json: organizations }));
  mockApi.handle('GET', '/api/civic/public/new-test-town', () => ({
    json: {
      id: 'new-town', name: 'New Test Town', slug: 'new-test-town', domain: null,
      settings: {
        logo: '', color: '#0d9488', timezone: 'UTC', language: 'en', contact: '',
        locations: [], departments: [], services: [], categories: ['Pothole'],
        anonymous: true, center: [0, 0], zoom: 12,
        states: [{ key: 'submitted', label: 'Submitted', next: [] }],
      },
    },
  }));
  mockApi.handle('GET', '/api/civic/public/new-test-town/content', () => ({ json: [] }));
  mockApi.handle('GET', '/api/civic/public/new-test-town/requests/calendar', () => ({ json: [] }));
  mockApi.handle('GET', '/api/civic/public/new-test-town/map', () => ({
    json: { type: 'FeatureCollection', features: [] },
  }));
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
  await expect(page.getByRole('link', { name: 'Open community map' })).toHaveAttribute(
    'href', 'http://127.0.0.1:3311/civic?org=new-test-town',
  );
  await page.getByRole('link', { name: 'Open community map' }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3311\/civic\?org=new-test-town$/);
  await expect(page.getByRole('searchbox', { name: 'Organization' })).toHaveValue('New Test Town');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'New Test Town', exact: true })).toBeVisible();
  expect(organizations).toHaveLength(1);
});
