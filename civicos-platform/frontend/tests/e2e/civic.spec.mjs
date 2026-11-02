import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const userIds = new Map();
test('main portal offers public organizations and opens the selected workspace', async ({ page }) => {
  const organization = {
    id: 'directory-fixture', name: 'Directory Test Town', slug: 'directory-test',
    settings: { language: 'en', timezone: 'UTC', color: '#0d9488', departments: [], services: [], anonymous: true },
  };
  await page.route('**/api/civic/public/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/organizations/list')) {
      await route.fulfill({ json: [{ name: organization.name, slug: organization.slug }] });
    } else if (path.endsWith('/portal')) {
      await route.fulfill({ status: 404, json: { message: 'No portal is configured for this domain' } });
    } else if (path.endsWith('/content')) {
      await route.fulfill({ json: [] });
    } else if (path.endsWith(`/${organization.slug}`)) {
      await route.fulfill({ json: organization });
    } else {
      await route.abort();
    }
  });
  await page.goto('/portal');
  await expect(page.getByRole('heading', { name: organization.name, exact: true })).toBeVisible();
  await expect(page.locator('#organization-suggestions option')).toHaveAttribute('value', organization.name);
  await page.getByRole('searchbox').fill('no-matching-organization');
  await expect(page.getByText('No organizations match your search.')).toBeVisible();
  await page.getByRole('searchbox').fill(organization.name);
  await expect(page.getByRole('heading', { name: organization.name, exact: true })).toBeVisible();
  await page.getByRole('searchbox').fill('/portal/directory-test');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('link', { name: `Open ${organization.name} portal` }).click();
  await expect(page.getByRole('heading', { name: organization.name, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Staff sign in' })).toHaveAttribute('href', `/staff?org=${organization.slug}`);
});

function magicLinkToken(email) {
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: userIds.get(email) || userIds.set(email, randomUUID()).get(email),
    email, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600,
  })}.e2e-signature`;
}
async function signInWithMagicLink(page, path, slug, email) {
  await page.goto(`http://127.0.0.1:3310/${path}?org=${slug}`);
  await expect(page.getByLabel('Organization')).toHaveAttribute('readonly', '');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('one-time sign-in link has been sent');
  const token = magicLinkToken(email);
  await page.goto(`http://127.0.0.1:3310/${path}?org=${slug}&e2e_auth_callback=${randomUUID()}#access_token=${encodeURIComponent(token)}&refresh_token=e2e-refresh&token_type=bearer&type=magiclink&expires_in=3600`);
}

test('resident → staff → mobile field → verification → private-safe tracking', async ({ page, browser }) => {
  const slug = process.env.E2E_SLUG;
  await page.goto(`/portal/${slug}`);
  await expect(page.getByRole('heading', { name: 'Browser Test Community', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Report a problem', exact: false }).first().click();
  await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('Pothole');
  await page.getByLabel('What happened?').fill('A dangerous pothole outside the library.');
  await page.getByLabel('Location', { exact: true }).fill('Library entrance');
  const reportMap = page.frameLocator('iframe[title="Interactive CivicOS community map"]');
  const canvas = reportMap.getByLabel('Interactive community infrastructure and service request map');
  await expect(reportMap.getByText('0 authorized locations', { exact: true })).toBeVisible();
  await expect(reportMap.locator('section[aria-busy="false"]')).toBeVisible({ timeout: 30000 });
  await page.locator('iframe[title="Interactive CivicOS community map"]').scrollIntoViewIfNeeded();
  await canvas.click({ position: { x: 150, y: 180 } });
  await expect(reportMap.getByLabel('Longitude', { exact: true })).not.toHaveValue('');
  await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue(await reportMap.getByLabel('Longitude', { exact: true }).inputValue());
  await expect(page.getByLabel('Latitude', { exact: true })).toHaveValue(await reportMap.getByLabel('Latitude', { exact: true }).inputValue());
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByText('Request received.', { exact: true })).toBeVisible();
  const reference = await page.locator('code').innerText();
  expect(reference).toMatch(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/);

  await signInWithMagicLink(page, 'staff', slug, 'admin@example.org');
  await expect(page.getByRole('heading', { name: 'Service requests', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'People & roles' }).click();
  await page.getByLabel('Email', { exact: true }).fill('worker@example.org');
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('field');
  await page.getByRole('button', { name: 'Create member' }).click();
  await expect(page.getByText('Team member created', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Staff chat', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Create channel' }).click();
  await page.getByLabel('Channel name').fill('field-operations');
  await page.getByLabel('Description').fill('Field crew coordination');
  await page.locator('form').getByRole('button', { name: 'Create channel', exact: true }).click();
  await expect(page.getByRole('heading', { name: '# field-operations', exact: true })).toBeVisible();
  await page.getByLabel('Write a message').fill('Channel dispatch message');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Channel dispatch message', { exact: true })).toBeVisible();
  await page.getByLabel('Message a teammate').selectOption({ label: 'worker@example.org · field' });
  await expect(page.getByRole('heading', { name: 'worker@example.org', exact: true })).toBeVisible();
  await page.getByLabel('Write a message').fill('Private dispatch message');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Private dispatch message', { exact: true })).toBeVisible();

  const teammateContext = await browser.newContext();
  const teammate = await teammateContext.newPage();
  await signInWithMagicLink(teammate, 'staff', slug, 'worker@example.org');
  await teammate.getByRole('button', { name: 'Staff chat', exact: true }).click();
  await teammate.getByRole('button', { name: /admin@example\.org/ }).click();
  await expect(teammate.getByText('Private dispatch message', { exact: true })).toBeVisible();
  await teammateContext.close();
  await page.getByRole('button', { name: 'Service requests', exact: true }).click();
  await page.getByRole('button', { name: 'Pothole', exact: true }).click();
  await page.getByLabel('Internal notes').fill('Private dispatch note — never public');
  await page.getByRole('button', { name: 'Move to Reviewed' }).click();
  await expect(page.getByText('Workflow updated. The transition has been recorded.', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Assign a worker' }).selectOption({ label: 'worker@example.org · field' });
  await page.getByRole('button', { name: 'Save assignment' }).click();
  await expect(page.getByText('Assignment recorded', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Move to Crew assigned' }).click();
  await expect(page.getByText('Workflow updated. The transition has been recorded.', { exact: true })).toBeVisible();
  await page.getByLabel("Publish this request's coordinates and category on the public map").check();
  await expect(page.getByText('Map visibility updated', { exact: true })).toBeVisible();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const field = await mobile.newPage();
  await signInWithMagicLink(field, 'field', slug, 'worker@example.org');
  await expect(field.getByRole('heading', { name: 'Your work, in one place' })).toBeVisible();
  await field.getByRole('button', { name: /Pothole/ }).click();
  await field.getByLabel('Internal notes').fill('Crew began work');
  await field.getByRole('button', { name: 'Start work', exact: true }).click();
  await expect(field.getByText('Workflow updated. The transition has been recorded.', { exact: true })).toBeVisible();
  await field.getByRole('button', { name: 'Complete work', exact: true }).click();
  await expect(field.getByRole('button', { name: 'Complete work', exact: true })).toHaveCount(0);
  await expect(field.getByRole('button', { name: 'Move to Verified' })).toHaveCount(0);
  expect(await field.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await mobile.close();

  await page.getByRole('button', { name: 'Pothole', exact: true }).click();
  await page.getByRole('button', { name: 'Move to Verified' }).click();
  await expect(page.getByText('Workflow updated. The transition has been recorded.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Organization settings', exact: true }).click();
  await page.getByLabel('Organization name').fill('Connected Community');
  await page.getByRole('button', { name: 'Save organization settings' }).click();
  await expect(page.getByText('Organization settings updated', { exact: true })).toBeVisible();

  await page.goto(`/portal/${slug}`);
  await expect(page.getByRole('heading', { name: 'Connected Community', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Track a request', exact: true }).first().click();
  await page.getByLabel('Tracking reference').fill(reference);
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.getByText('Verified', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Private dispatch note — never public')).toHaveCount(0);
  await expect(page.getByText('admin@example.org')).toHaveCount(0);
  await page.getByRole('button', { name: 'Explore the map' }).click();
  const map = page.frameLocator('iframe[title="Interactive CivicOS community map"]');
  await expect(map.getByText('1 authorized locations', { exact: true })).toBeVisible();
  await expect(map.getByRole('button', { name: /Pothole/ })).toBeVisible();
  await expect(page.getByText(/Map is taking too long/)).toHaveCount(0);
  await expect(map.locator('.maplibregl-canvas')).toBeVisible();
});

test('platform owner creates an organization and appoints its bottom admin', async ({ page }) => {
  const organizationSlug = `managed-${process.env.E2E_SLUG}`;
  await page.goto('/platform');
  await page.getByLabel('Platform owner email').fill('owner@example.org');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('configured platform owner email');
  const token = magicLinkToken('owner@example.org');
  await page.goto(`http://127.0.0.1:3310/platform?e2e_auth_callback=${randomUUID()}#access_token=${encodeURIComponent(token)}&refresh_token=e2e-refresh&token_type=bearer&type=magiclink&expires_in=3600`);
  await expect(page.getByRole('heading', { name: 'Organization administration' })).toBeVisible();
  await page.getByLabel('Organization name').fill('Managed Browser Organization');
  await page.getByLabel('Organization slug').fill(organizationSlug);
  await page.getByLabel('Bottom admin email').fill('bottom@example.org');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('status')).toContainText('bottom@example.org can now request a Supabase sign-in link');
  await expect(page.locator(`a[href="/staff?org=${organizationSlug}"]`)).toHaveText('Open staff sign-in');
});
