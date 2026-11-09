import { test, expect, portal } from '../frontend/fixtures.mjs';

for (const path of ['/', '/portal', `/portal/${portal.slug}`, '/staff', '/field', '/platform']) {
  test(`production CSP permits hydration and uses fresh nonces on ${path}`, async ({ page }) => {
    const violations = [];
    page.on('console', message => {
      if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
        violations.push(message.text());
      }
    });
    const response = await page.goto(path);
    expect(response.status()).toBe(200);
    const policy = response.headers()['content-security-policy'];
    const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(policy).toContain("'strict-dynamic'");
    expect(policy.split(';').find(directive => directive.trim().startsWith('script-src')))
      .not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(response.headers()['cache-control']).toMatch(/no-store/);
    const nonces = await page.locator('script').evaluateAll(scripts => scripts.map(script => script.nonce));
    expect(nonces.length).toBeGreaterThan(0);
    expect(nonces.every(value => value === nonce)).toBe(true);

    if (path === '/' || path === '/portal') {
      const search = page.getByRole('combobox', { name: 'Organization name or workspace address', exact: true });
      await search.fill('no-matching-organization');
      await expect(page.getByText('No organizations match your search.')).toBeVisible();
    } else if (path.startsWith('/portal/')) {
      await expect(page.getByRole('heading', { name: portal.name, exact: true })).toBeVisible();
    } else if (path === '/staff' || path === '/field') {
      await expect(page.getByLabel('Offline passphrase', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Set passphrase' })).toBeVisible();
    } else {
      await page.getByLabel('Platform owner email').fill('owner@example.org');
      await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeEnabled();
    }

    const reload = await page.reload();
    const nextNonce = reload.headers()['content-security-policy'].match(/'nonce-([^']+)'/)?.[1];
    expect(nextNonce).toBeTruthy();
    expect(nextNonce).not.toBe(nonce);
    await expect.poll(() => page.locator('script').evaluateAll(
      (scripts, expected) => scripts.length > 0 && scripts.every(script => script.nonce === expected),
      nextNonce,
    )).toBe(true);
    expect(violations).toEqual([]);
  });
}
