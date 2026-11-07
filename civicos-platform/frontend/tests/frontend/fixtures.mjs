import { test as base, expect } from '@playwright/test';

export { expect };
export const portal = {
  id: 'frontend-town', name: 'Frontend Test Town', slug: 'frontend-town', domain: null,
  settings: {
    logo: '', color: '#0d9488', timezone: 'UTC', language: 'en', contact: '',
    locations: [], departments: [], services: [], categories: ['Pothole'],
    anonymous: true, center: [0, 0], zoom: 12,
    states: [{ key: 'submitted', label: 'Submitted', next: [] }],
  },
};

export const test = base.extend({
  mockApi: [async ({ context }, use) => {
    const handlers = new Map();
    const unexpected = [];
    const handle = (method, path, handler) => handlers.set(`${method} ${path}`, handler);
    handle('GET', '/api/civic/public/organizations/list', () => ({ json: [{ name: portal.name, slug: portal.slug }] }));
    handle('GET', '/api/civic/public/portal', () => ({ status: 404, json: { message: 'No portal is configured for this domain' } }));
    handle('GET', `/api/civic/public/${portal.slug}`, () => ({ json: portal }));
    handle('GET', `/api/civic/public/${portal.slug}/content`, () => ({ json: [] }));
    handle('GET', `/api/civic/public/${portal.slug}/requests/calendar`, () => ({ json: [] }));
    handle('GET', `/api/civic/public/${portal.slug}/map`, () => ({
      json: { type: 'FeatureCollection', features: [] },
    }));
    await context.route('**/api/civic/**', async route => {
      const request = route.request();
      const key = `${request.method()} ${new URL(request.url()).pathname}`;
      const handler = handlers.get(key);
      if (!handler) {
        unexpected.push(key);
        await route.fulfill({ status: 501, json: { message: `Missing frontend mock: ${key}` } });
        return;
      }
      await route.fulfill(await handler(request));
    });
    await context.route('https://frontend-only.test/**', route => route.fulfill({
      status: 401, json: { message: 'Sign-in is unavailable in this test' },
    }));
    await use({ handle });
    expect(unexpected, 'Every CivicOS API request must have an explicit frontend mock').toEqual([]);
  }, { auto: true }],
});
