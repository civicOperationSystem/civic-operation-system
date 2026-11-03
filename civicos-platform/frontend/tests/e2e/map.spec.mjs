import { test, expect } from '@playwright/test';
import { MAP_FRAME, magicLinkToken, signInWithMagicLink, waitForMap } from './helpers.mjs';

// Runs in its own organization so pinned information does not change the location counts asserted in civic.spec.mjs.
const api = `${process.env.CIVIC_API_URL}/api/civic`;
const slug = `maps-${process.env.E2E_SLUG}`;
const organizationName = 'Map Test Community';
const admin = 'maps-admin@example.org';
const pinned = { title: 'Riverside library', longitude: '-73.985123', latitude: '40.758456' };
const unpinned = { title: 'Recycling schedule' };
const archivedTitle = 'Old road closure notice';
const today = new Date();
// Day 15 of the current month is always inside the grid the public calendar opens on.
const calendarDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-15`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${api}/platform/login`, { data: { access_token: magicLinkToken('owner@example.org') } });
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  const created = await request.post(`${api}/platform/organizations`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: organizationName, slug, admin_email: admin },
  });
  expect(created.status()).toBe(201);
});

test('bottom administrator chooses and saves the community map view for embedded and standalone maps', async ({ page }) => {
  await signInWithMagicLink(page, 'staff', slug, admin);
  await page.getByRole('button', { name: 'Organization settings', exact: true }).click();
  const longitude = page.getByLabel('Map center longitude', { exact: true });
  const latitude = page.getByLabel('Map center latitude', { exact: true });
  const zoom = page.getByLabel('Default map zoom', { exact: true });
  await expect(longitude).toHaveValue('0');
  await expect(latitude).toHaveValue('0');
  await expect(zoom).toHaveValue('2');
  await longitude.fill('12.49');
  await latitude.fill('41.89');
  await zoom.fill('11');
  const iframe = page.locator(MAP_FRAME);
  const map = iframe.contentFrame();
  await waitForMap(iframe);
  await expect(map.getByLabel('Current map view')).toHaveText('Map center: 12.49, 41.89 · Zoom: 11');
  await map.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(map.getByLabel('Current map view')).toHaveText('Map center: 12.49, 41.89 · Zoom: 12');
  const canvas = map.getByLabel('Interactive community infrastructure and service request map');
  await canvas.focus();
  await canvas.press('ArrowRight');
  await expect(map.getByLabel('Current map view')).not.toHaveText('Map center: 12.49, 41.89 · Zoom: 12');
  await map.getByRole('button', { name: 'Use current map view' }).click();
  await expect(zoom).toHaveValue('12');
  await expect(longitude).not.toHaveValue('12.49');
  const center = [Number(await longitude.inputValue()), Number(await latitude.inputValue())];
  const expectedView = `Map center: ${center.join(', ')} · Zoom: 12`;
  await page.getByRole('button', { name: 'Save organization settings', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Organization settings updated' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Organization settings', exact: true }).click();
  await expect(longitude).toHaveValue(String(center[0]));
  await expect(latitude).toHaveValue(String(center[1]));
  await expect(zoom).toHaveValue('12');
  await page.getByRole('button', { name: 'Community map', exact: true }).click();
  await waitForMap(iframe);
  await expect(map.getByLabel('Current map view')).toHaveText(expectedView);
  await page.goto(`/portal/${slug}`);
  await page.getByRole('button', { name: 'Explore the map', exact: true }).click();
  await waitForMap(iframe);
  await expect(map.getByLabel('Current map view')).toHaveText(expectedView);
  await page.getByRole('button', { name: 'Report a problem', exact: true }).first().click();
  await waitForMap(iframe);
  await expect(map.getByLabel('Current map view')).toHaveText(expectedView);
  await page.goto(`http://127.0.0.1:3311/civic?org=${slug}`);
  await expect(page.getByLabel('Current map view')).toHaveText(expectedView);
});

test('staff pick public information coordinates on a map before publishing', async ({ page }) => {
  await signInWithMagicLink(page, 'staff', slug, admin);
  await page.getByRole('button', { name: 'Public information', exact: true }).click();
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save information' }) });
  const longitude = form.getByLabel('Longitude', { exact: true });
  const latitude = form.getByLabel('Latitude', { exact: true });
  const formMap = form.frameLocator(MAP_FRAME);

  await form.getByLabel('Title', { exact: true }).fill(pinned.title);
  await form.getByLabel('Information', { exact: true }).fill('Free Wi-Fi and study rooms');
  await form.getByLabel('Location', { exact: true }).fill('12 River Road');
  await expect(form.locator(MAP_FRAME)).toHaveCount(0);

  await form.getByRole('button', { name: 'Pick location on map' }).click();
  await expect(form.getByRole('button', { name: 'Hide map' })).toHaveAttribute('aria-expanded', 'true');
  await waitForMap(form.locator(MAP_FRAME));
  await formMap.getByLabel('Interactive community infrastructure and service request map').click({ position: { x: 150, y: 180 } });
  await expect(longitude).not.toHaveValue('');
  await expect(latitude).not.toHaveValue('');
  const picked = [Number(await longitude.inputValue()), Number(await latitude.inputValue())];
  expect(Math.abs(picked[0])).toBeLessThanOrEqual(180);
  expect(Math.abs(picked[1])).toBeLessThanOrEqual(90);
  expect(Number(await formMap.getByLabel('Longitude', { exact: true }).inputValue())).toBeCloseTo(picked[0], 6);
  expect(Number(await formMap.getByLabel('Latitude', { exact: true }).inputValue())).toBeCloseTo(picked[1], 6);

  await form.getByRole('button', { name: 'Hide map' }).click();
  await expect(form.locator(MAP_FRAME)).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'View or change on map' })).toHaveAttribute('aria-expanded', 'false');
  await form.getByRole('button', { name: 'Clear coordinates' }).click();
  await expect(longitude).toHaveValue('');
  await expect(latitude).toHaveValue('');
  await expect(form.getByRole('button', { name: 'Clear coordinates' })).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Pick location on map' })).toBeVisible();

  await longitude.fill(pinned.longitude);
  await latitude.fill(pinned.latitude);
  await form.getByRole('button', { name: 'View or change on map' }).click();
  await waitForMap(form.locator(MAP_FRAME));
  await expect(formMap.locator('.maplibregl-marker')).toHaveCount(1);
  await form.getByLabel('Calendar date (optional)').fill(calendarDate);
  await form.getByLabel('Publish immediately').check();
  await form.getByRole('button', { name: 'Save information' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Content saved' })).toBeVisible();
  await expect(longitude).toHaveValue('');
  await expect(form.locator(MAP_FRAME)).toHaveCount(0);

  await form.getByRole('combobox', { name: 'Type' }).selectOption('announcement');
  await form.getByLabel('Title', { exact: true }).fill(unpinned.title);
  await form.getByLabel('Information', { exact: true }).fill('Bins are collected every Tuesday.');
  await form.getByLabel('Publish immediately').check();
  await form.getByRole('button', { name: 'Save information' }).click();
  await expect(page.getByRole('heading', { name: unpinned.title, exact: true })).toBeVisible();

  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: pinned.title, exact: true }) });
  await card.getByRole('button', { name: 'Edit information' }).click();
  await expect(page.getByRole('heading', { name: 'Edit community information' })).toBeVisible();
  await expect(longitude).toHaveValue(pinned.longitude);
  await expect(latitude).toHaveValue(pinned.latitude);
  await expect(form.getByLabel('Calendar date (optional)')).toHaveValue(calendarDate);
  await expect(form.getByRole('button', { name: 'View or change on map' })).toBeVisible();
  await form.getByRole('button', { name: 'Cancel editing' }).click();
  await expect(longitude).toHaveValue('');
  await expect(latitude).toHaveValue('');
});

test('staff archive public information out of the workspace while it stays public', async ({ page }) => {
  await signInWithMagicLink(page, 'staff', slug, admin);
  await page.getByRole('button', { name: 'Public information', exact: true }).click();
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save information' }) });
  await form.getByRole('combobox', { name: 'Type' }).selectOption('announcement');
  await form.getByLabel('Title', { exact: true }).fill(archivedTitle);
  await form.getByLabel('Information', { exact: true }).fill('Main Street reopened.');
  await form.getByLabel('Publish immediately').check();
  await form.getByRole('button', { name: 'Save information' }).click();
  const heading = page.getByRole('heading', { name: archivedTitle, exact: true });
  await expect(heading).toBeVisible();

  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: `Archive ${archivedTitle}` }).click();
  await expect(heading).toBeVisible();

  page.once('dialog', dialog => { expect(dialog.message()).toContain('stays visible on the public portal'); void dialog.accept(); });
  await page.getByRole('button', { name: `Archive ${archivedTitle}` }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Information archived' })).toBeVisible();
  await expect(heading).toHaveCount(0);
  await expect(page.getByRole('heading', { name: pinned.title, exact: true })).toBeVisible();
});

test('residents open pinned public information on the community map', async ({ page }) => {
  await page.goto(`/portal/${slug}`);
  await expect(page.getByRole('heading', { name: organizationName, exact: true })).toBeVisible();
  const viewOnMap = page.getByRole('button', { name: `View ${pinned.title} on the map` });
  const focusStatus = page.getByRole('status').filter({ hasText: 'on the map.' });
  const mapElement = page.locator(MAP_FRAME).first();
  const map = mapElement.contentFrame();

  await expect(page.getByRole('heading', { name: unpinned.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `View ${unpinned.title} on the map` })).toHaveCount(0);

  await viewOnMap.click();
  await expect(page.getByRole('button', { name: 'Explore the map' })).toHaveAttribute('aria-current', 'page');
  await expect(focusStatus).toContainText(`Showing ${pinned.title} on the map.`);
  await waitForMap(mapElement);
  await expect(map.locator('.maplibregl-marker')).toHaveCount(1);
  await expect(page.getByText(/Map is taking too long/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Show the whole community' }).click();
  await expect(focusStatus).toHaveCount(0);
  await expect(map.locator('.maplibregl-marker')).toHaveCount(0);

  await page.getByRole('button', { name: 'Community hub' }).click();
  await page.getByRole('button', { name: /Open details/ }).filter({ hasText: unpinned.title }).click();
  await expect(page.getByRole('dialog')).toContainText('A map location was not provided for this information.');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Open in community map' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: /Open details/ }).filter({ hasText: pinned.title }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Open in community map' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Explore the map' })).toHaveAttribute('aria-current', 'page');
  await expect(focusStatus).toContainText(`Showing ${pinned.title} on the map.`);
  await waitForMap(mapElement);
  await expect(map.locator('.maplibregl-marker')).toHaveCount(1);

  await page.getByRole('button', { name: 'Report a problem' }).first().click();
  await page.getByRole('button', { name: 'Explore the map' }).click();
  await expect(focusStatus).toHaveCount(0);

  await page.getByRole('button', { name: 'Community hub' }).click();
  await expect(page.getByRole('heading', { name: archivedTitle, exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Public requests' }).click();
  const calendar = page.getByRole('grid', { name: 'Public request calendar' });
  await expect(calendar.getByRole('button', { name: `${pinned.title} (service)` })).toHaveCount(1);
  await expect(calendar.getByRole('button', { name: new RegExp(unpinned.title) })).toHaveCount(0);
  await calendar.getByRole('button', { name: `${pinned.title} (service)` }).click();
  await expect(page.getByRole('dialog')).toContainText('Calendar date:');
  await expect(page.getByRole('dialog')).toContainText(`${today.getFullYear()}`);
});

test('residents refresh published information without losing a report draft and can retry failures', async ({ page, request }) => {
  const title = 'Fresh community update';
  await page.goto(`/portal/${slug}`);
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);

  const login = await request.post(`${api}/login`, {
    data: { slug, access_token: magicLinkToken(admin) },
  });
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  const created = await request.post(`${api}/staff/content`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      kind: 'announcement', title, description: 'Published after this page opened.',
      location: '', longitude: null, latitude: null, url: null,
      published: true, calendar_date: calendarDate,
    },
  });
  expect(created.status()).toBe(201);
  await refresh.click();
  await expect(page.getByRole('status')).toHaveText('Portal refreshed.');
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Public requests', exact: true }).click();
  await expect(page.getByRole('grid').getByRole('button', { name: `${title} (announcement)` })).toBeVisible();

  await page.getByRole('navigation', { name: 'Portal sections' }).getByRole('button', { name: 'Report a problem', exact: true }).click();
  await page.getByLabel('What happened?', { exact: true }).fill('Unfinished resident report');
  await page.getByLabel('Location', { exact: true }).fill('Library entrance');
  const contentUrl = `**/public/${slug}/content`;
  await page.route(contentUrl, route => route.fulfill({
    status: 503, json: { message: 'Refresh temporarily unavailable' },
  }));
  await refresh.click();
  const refreshError = page.getByRole('alert').filter({ hasText: 'Refresh temporarily unavailable' });
  await expect(refreshError).toBeVisible();
  await expect(page.getByLabel('What happened?', { exact: true })).toHaveValue('Unfinished resident report');
  await expect(refresh).toBeEnabled();
  await page.unroute(contentUrl);
  await refresh.click();
  await expect(page.getByRole('status')).toHaveText('Portal refreshed.');
  await expect(refreshError).toHaveCount(0);
  await expect(page.getByLabel('What happened?', { exact: true })).toHaveValue('Unfinished resident report');
  await expect(page.getByLabel('Location', { exact: true })).toHaveValue('Library entrance');
});
