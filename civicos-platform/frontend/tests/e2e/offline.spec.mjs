import { test, expect } from '@playwright/test';
import { magicLinkToken, signInWithMagicLink } from './helpers.mjs';

const api = `${process.env.CIVIC_API_URL}/api/civic`;
const slug = `offline-${process.env.E2E_SLUG}`;
const workerEmail = 'offline-worker@example.org';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=', 'base64');
let adminToken;
let workerToken;
let requestId;
test.describe.configure({ mode: 'serial' });

async function waitForOfflineShell(page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve =>
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await caches.match(location.href)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The offline application shell was not cached');
  });
}

test.beforeAll(async ({ request }) => {
  const ownerLogin = await request.post(`${api}/platform/login`, { data: { access_token: magicLinkToken('owner@example.org') } });
  expect(ownerLogin.status()).toBe(200);
  const owner = await ownerLogin.json();
  const created = await request.post(`${api}/platform/organizations`, {
    headers: { Authorization: `Bearer ${owner.token}` },
    data: { name: 'Offline Test Town', slug, admin_email: 'offline-admin@example.org' },
  });
  expect(created.status()).toBe(201);
  const login = async email => {
    const response = await request.post(`${api}/login`, { data: { slug, access_token: magicLinkToken(email) } });
    expect(response.status()).toBe(200);
    return (await response.json()).token;
  };
  adminToken = await login('offline-admin@example.org');
  const headers = { Authorization: `Bearer ${adminToken}` };
  const worker = await request.post(`${api}/staff/members`, {
    headers, data: { email: workerEmail, display_name: 'Offline Worker', role: 'field' },
  });
  expect(worker.status()).toBe(201);
  workerToken = await login(workerEmail);
  const submitted = await request.post(`${api}/public/${slug}/requests`, {
    data: { category: 'Pothole', description: 'Offline repair assignment', location: 'Remote road', anonymous: true },
  });
  expect(submitted.status()).toBe(201);
  const records = await request.get(`${api}/staff/requests`, { headers });
  requestId = (await records.json())[0].id;
  for (const [action, data] of [
    ['transition', { status: 'reviewed' }],
    ['assign', { assigned_to: (await worker.json()).id }],
    ['transition', { status: 'assigned' }],
  ]) {
    expect((await request.post(`${api}/staff/requests/${requestId}/${action}`, { headers, data })).status()).toBe(200);
  }
});

test('field updates survive offline reload and sync notes, status, photos and coordinates once', async ({ page, context, request }) => {
  await signInWithMagicLink(page, 'field', slug, workerEmail);
  // The field shell must be installed before it can survive a disconnected reload.
  await expect(page.getByText('Online · 0 pending updates')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve =>
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  await context.setOffline(true);
  await expect(page.getByText('Offline — using saved assignments · 0 pending updates')).toBeVisible();
  await page.getByRole('button', { name: /Open to add completion photo and map pin/ }).click();
  await page.getByLabel('Private note', { exact: true }).fill('Repaired during outage');
  await page.getByRole('button', { name: 'Add private note', exact: true }).click();
  await page.getByRole('button', { name: 'Start work', exact: true }).click();
  await page.getByLabel('Longitude', { exact: true }).fill('0');
  await page.getByLabel('Latitude', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Save location', exact: true }).click();
  await page.getByLabel('Upload completion photo (0/3)').setInputFiles({ name: 'repair.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('Offline — using saved assignments · 4 pending updates')).toBeVisible();

  const authStorage = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => /^sb-.*-auth-token$/.test(key));
    if (!key) throw new Error('Supabase session fixture is missing');
    const value = localStorage.getItem(key);
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(value), expires_at: 1 }));
    return { key, value };
  });
  await page.reload();
  await expect(page.getByText('Offline — using saved assignments · 4 pending updates')).toBeVisible();
  await page.getByRole('button', { name: /Open to add completion photo and map pin/ }).click();
  await expect(page.locator('article').getByText('Work in progress', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Field work photo 1', exact: true })).toBeVisible();
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), authStorage);

  let droppedAcknowledgement = false;
  let allowReplay = false;
  await page.route(`**/staff/requests/${requestId}/field-photo`, async route => {
    if (droppedAcknowledgement) {
      if (allowReplay) await route.continue(); else await route.abort('failed');
      return;
    }
    const delivered = await route.fetch();
    expect(delivered.status()).toBe(201);
    droppedAcknowledgement = true;
    await route.abort('failed');
  });
  await context.setOffline(false);
  await expect(page.getByRole('alert').filter({ hasText: 'Failed to fetch' })).toBeVisible({ timeout: 60000 });
  expect(droppedAcknowledgement).toBe(true);
  allowReplay = true;
  await page.getByRole('button', { name: 'Sync pending updates', exact: true }).click();
  await expect(page.getByText(/^Online · 0 pending updates/)).toBeVisible({ timeout: 60000 });
  const response = await request.get(`${api}/staff/requests/${requestId}`, { headers: { Authorization: `Bearer ${workerToken}` } });
  expect(response.status()).toBe(200);
  const detail = await response.json();
  expect(detail).toMatchObject({ status: 'in_progress', longitude: 0, latitude: 0 });
  expect(detail.field_photos).toHaveLength(1);
  expect(detail.history.filter(item => item.notes === 'Repaired during outage')).toHaveLength(1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible();
  const stored = await page.evaluate(async () => new Promise((resolve, reject) => {
    const open = indexedDB.open('civicos-field-v1');
    open.onsuccess = () => {
      const read = open.result.transaction('workspaces').objectStore('workspaces').getAll();
      read.onsuccess = () => { resolve(read.result); open.result.close(); };
      read.onerror = () => reject(read.error);
    };
    open.onerror = () => reject(open.error);
  }));
  expect(stored).toEqual([]);
});

test('stale queued work is retained for review instead of overwriting dispatch changes', async ({ page, context, request }) => {
  await signInWithMagicLink(page, 'field', slug, workerEmail);
  await expect(page.getByText('Online · 0 pending updates')).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: /Open to add completion photo and map pin/ }).click();
  await page.getByLabel('Private note', { exact: true }).fill('Conflicting queued note');
  await page.getByRole('button', { name: 'Add private note', exact: true }).click();
  await page.getByLabel('Private note', { exact: true }).fill('Dependent queued note');
  await page.getByRole('button', { name: 'Add private note', exact: true }).click();
  await expect(page.getByText('Offline — using saved assignments · 2 pending updates')).toBeVisible();
  const changed = await request.post(`${api}/staff/requests/${requestId}/notes`, {
    headers: { Authorization: `Bearer ${adminToken}` }, data: { notes: 'Dispatch updated the job' },
  });
  expect(changed.status()).toBe(201);
  await context.setOffline(false);
  await expect(page.getByText(/This ticket changed while offline/)).toBeVisible({ timeout: 60000 });
  await expect(page.getByText('Conflicting queued note', { exact: true })).toBeVisible();
  const response = await request.get(`${api}/staff/requests/${requestId}`, { headers: { Authorization: `Bearer ${workerToken}` } });
  expect((await response.json()).history.some(item => ['Conflicting queued note', 'Dependent queued note'].includes(item.notes))).toBe(false);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard pending updates for this ticket' }).click();
  await expect(page.getByText(/^Online · 0 pending updates/)).toBeVisible();
});

test('public portal opens offline and submits a queued report once reconnected', async ({ page, context }) => {
  await page.goto(`http://127.0.0.1:3310/portal/${slug}`);
  await expect(page.getByRole('heading', { name: 'Offline Test Town' })).toBeVisible();
  await waitForOfflineShell(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(/Offline — showing saved public information/)).toBeVisible();
  await page.getByRole('button', { name: 'Report a problem' }).first().click();
  await page.getByLabel('Category').selectOption('Pothole');
  await page.getByLabel('What happened?').fill('Report saved while offline');
  await page.getByLabel('Location').fill('Community garden');
  await page.getByRole('button', { name: 'Submit request' }).click();
  await expect(page.getByRole('region', { name: 'Saved public reports' }).getByText(/Waiting to send/)).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText(/Submitted · Tracking reference/)).toBeVisible({ timeout: 60000 });
});

test('returning staff can reopen a read-only cached workspace offline and sign out locally', async ({ page, context }) => {
  await signInWithMagicLink(page, 'staff', slug, 'offline-admin@example.org');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await waitForOfflineShell(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(/Offline — read-only snapshot for offline-admin@example.org/)).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Email me a sign-in link', exact: true })).toBeVisible();
});
