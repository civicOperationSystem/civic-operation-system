import { test, expect, portal } from '../frontend/fixtures.mjs';

const mapUrl = 'http://127.0.0.1:3321/civic';

async function expectMapNonce(response, root) {
  expect(response.status()).toBe(200);
  const policy = response.headers()['content-security-policy'];
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(policy).toContain("'strict-dynamic'");
  expect(policy.split(';').find(directive => directive.trim().startsWith('script-src')))
    .not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(response.headers()['cache-control']).toMatch(/no-store/);
  await expect.poll(() => root.locator('script').evaluateAll(
    (scripts, expected) => scripts.length > 0 && scripts.every(script => script.nonce === expected), nonce,
  )).toBe(true);
  return nonce;
}

function captureCspErrors(page) {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  return errors;
}

test('standalone production map hydrates with fresh CSP nonces', async ({ page }) => {
  const errors = captureCspErrors(page);
  const response = await page.goto(mapUrl);
  const nonce = await expectMapNonce(response, page);
  await page.getByLabel('Organization', { exact: true }).fill(portal.name);
  await page.getByRole('button', { name: 'Open community map' }).click();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(page).toHaveURL(`${mapUrl}?org=${portal.slug}`);
  const reload = await page.reload();
  expect(await expectMapNonce(reload, page)).not.toBe(nonce);
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('production portal iframe completes the map handshake and loads authorized data', async ({ page }) => {
  const errors = captureCspErrors(page);
  await page.goto(`/portal/${portal.slug}`);
  const mapDocument = page.waitForResponse(response => response.url() === mapUrl &&
    response.request().resourceType() === 'document');
  const mapData = page.waitForResponse(response =>
    response.url() === `http://127.0.0.1:3321/api/civic/public/${portal.slug}/map`);
  await page.getByRole('navigation', { name: 'Portal sections' })
    .getByRole('button', { name: 'Explore the map', exact: true }).click();
  const response = await mapDocument;
  expect(response.headers()['content-security-policy'].split(';')
    .find(directive => directive.trim().startsWith('frame-ancestors')))
    .toContain('http://127.0.0.1:3320');
  const iframe = page.frameLocator('iframe[title="Interactive CivicOS community map"]');
  await expectMapNonce(response, iframe);
  expect((await mapData).status()).toBe(200);
  await page.getByRole('button', { name: 'Enable map interaction' }).click();
  await expect(iframe.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(iframe.getByLabel('Organization', { exact: true })).toHaveCount(0);
  await expect(iframe.getByRole('status').filter({ hasText: 'authorized locations' }))
    .toHaveText('0 authorized locations');
  expect(errors).toEqual([]);
});
