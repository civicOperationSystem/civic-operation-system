const CACHE = 'civicos-field-shell-v1';

async function cacheShell() {
  const cache = await caches.open(CACHE);
  const shell = await fetch('/field', { cache: 'no-store' });
  if (!shell.ok) throw new Error('Could not cache the field workspace');
  const html = await shell.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(match => new URL(match[1].replace(/&amp;/g, '&'), self.location.origin))
    .filter(url => url.origin === self.location.origin && url.pathname.startsWith('/_next/static/'));
  await cache.addAll([...new Set(assets.map(url => url.href))]);
  await cache.put('/field', shell);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await cacheShell();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('civicos-field-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const navigation = event.request.mode === 'navigate' && url.pathname === '/field';
  const asset = url.pathname.startsWith('/_next/static/');
  if (!navigation && !asset) return;
  if (navigation) event.waitUntil(cacheShell().catch(failure => console.error('CivicOS offline shell refresh failed', failure)));
  // Only the unauthenticated shell and static assets are cached, never API responses or auth callbacks.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (asset && response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch (failure) {
      const cached = await cache.match(navigation ? '/field' : event.request);
      if (cached) return cached;
      throw failure;
    }
  })());
});
