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
