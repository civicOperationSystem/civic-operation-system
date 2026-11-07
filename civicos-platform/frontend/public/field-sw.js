const fieldScope = new URL(self.registration.scope).pathname.replace(/\/$/, '') === '/field';
const CACHE = fieldScope ? 'civicos-field-shell-v2' : 'civicos-app-shell-v1';

function isAppNavigation(url) {
  return url.pathname === '/' || url.pathname === '/field' || url.pathname === '/staff' ||
    url.pathname === '/portal' || url.pathname.startsWith('/portal/');
}

async function cacheShell(url) {
  const cache = await caches.open(CACHE);
  const shell = await fetch(url, { cache: 'no-store' });
  if (!shell.ok) throw new Error('Could not cache the application page');
  const html = await shell.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => new URL(match[1].replace(/&amp;/g, '&'), self.location.origin))
    .filter(url => url.origin === self.location.origin && url.pathname.startsWith('/_next/static/'));
  await cache.addAll([...new Set(assets.map(url => url.href))]);
  await cache.put(url, shell);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      const oldCache = fieldScope
        ? key.startsWith('civicos-field-shell-')
        : key.startsWith('civicos-app-shell-') || key.startsWith('civicos-shell-');
      if (oldCache && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_APP_SHELL' || typeof event.data.url !== 'string') return;
  const url = new URL(event.data.url, self.location.origin);
  if (url.origin !== self.location.origin || !isAppNavigation(url)) return;
  event.waitUntil(cacheShell(url.href).catch(failure => console.error('CivicOS offline shell caching failed', failure)));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const navigation = event.request.mode === 'navigate' && isAppNavigation(url);
  const asset = url.pathname.startsWith('/_next/static/');
  if (!navigation && !asset) return;
  if (navigation) event.waitUntil(cacheShell(event.request.url).catch(failure => console.error('CivicOS offline shell refresh failed', failure)));
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (asset && response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch (failure) {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      throw failure;
    }
  })());
});
