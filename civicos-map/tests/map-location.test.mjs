import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMapLocationDetails } from '../lib/map-location.ts';

const feature = (kind = 'request') => ({
  type: 'Feature',
  id: 'record-1',
  geometry: { type: 'Point', coordinates: [2, 48] },
  properties: { id: 'record-1', kind, title: 'Library', status: 'Verified', location: 'Main Street' },
});
const context = { slug: 'sample-town', center: [2, 48], token: null, selectable: false };

test('public request pin details include approved description and photos', async () => {
  const originalFetch = globalThis.fetch;
  let url;
  globalThis.fetch = async (input, options) => {
    url = input;
    assert.equal(options.cache, 'no-store');
    return Response.json({
      description: 'Publicly reviewed report',
      category: 'Roads',
      status: 'Verified',
      location: 'Main Street',
      photos: ['data:image/jpeg;base64,photo'],
      updated_at: '2026-01-01T00:00:00Z',
    });
  };
  try {
    const details = await loadMapLocationDetails(feature(), context, new AbortController().signal);
    assert.equal(url, '/api/civic/public/sample-town/requests/record-1');
    assert.equal(details.description, 'Publicly reviewed report');
    assert.deepEqual(details.photos, ['data:image/jpeg;base64,photo']);
  } finally { globalThis.fetch = originalFetch; }
});

test('public information pin details are selected by record ID', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    assert.equal(input, '/api/civic/public/sample-town/content');
    return Response.json([
      { id: 'other', description: 'Other location' },
      { id: 'record-1', description: 'Library description', photos: ['data:image/png;base64,photo'] },
    ]);
  };
  try {
    const details = await loadMapLocationDetails(feature('facility'), context, new AbortController().signal);
    assert.equal(details.description, 'Library description');
    assert.deepEqual(details.photos, ['data:image/png;base64,photo']);
  } finally { globalThis.fetch = originalFetch; }
});
