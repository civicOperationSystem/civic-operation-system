import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterFeatures, isMapContext, searchMapOrganizations } from '../lib/civic-map.ts';
import { readMapApiResponse } from '../lib/map-api.ts';

test('map context rejects tokens in URLs and malformed coordinates or messages', () => {
  const valid = { type: 'civic-map-context', slug: 'town-a', center: [-73, 40], token: null, selectable: false };
  assert.equal(isMapContext(valid), true);
  assert.equal(isMapContext({ ...valid, center: [181, 0] }), false);
  assert.equal(isMapContext({ ...valid, marker: [-73, 40] }), true);
  assert.equal(isMapContext({ ...valid, marker: null }), true);
  assert.equal(isMapContext({ ...valid, marker: [0, 91] }), false);
  assert.equal(isMapContext({ ...valid, marker: [0, NaN] }), false);
  assert.equal(isMapContext({ ...valid, marker: [0] }), false);
  assert.equal(isMapContext({ ...valid, marker: [-73, 40], focused: true }), true);
  assert.equal(isMapContext({ ...valid, focused: true }), false);
  assert.equal(isMapContext({ ...valid, marker: [-73, 40], focused: true, selectable: true }), false);
  assert.equal(isMapContext({ ...valid, focused: 'true' }), false);
  assert.equal(isMapContext({ ...valid, locked: true }), true);
  assert.equal(isMapContext({ ...valid, locked: true, selectable: true }), false);
  assert.equal(isMapContext({ ...valid, viewSelectable: true, zoom: 13.5 }), true);
  assert.equal(isMapContext({ ...valid, viewSelectable: 'true' }), false);
  assert.equal(isMapContext({ ...valid, viewSelectable: true, locked: true }), false);
  assert.equal(isMapContext({ ...valid, viewSelectable: true, selectable: true }), false);
  for (const zoom of [0, 20, NaN, '12']) assert.equal(isMapContext({ ...valid, zoom }), false);
  assert.equal(isMapContext({ ...valid, token: 123 }), false);
  assert.equal(isMapContext({ ...valid, slug: '../staff' }), false);
  assert.equal(isMapContext(null), false);
});
test('map filters preserve only matching authorized features and never add data', () => {
  const features = [
    { id: 'a', properties: { kind: 'request', status: 'Crew assigned', title: 'Pothole', location: null } },
    { id: 'b', properties: { kind: 'facility', status: null, title: 'Library', location: 'Main Street' } },
  ];
  const data = { type: 'FeatureCollection', features };
  assert.deepEqual(filterFeatures(data, 'request', '', '').features, [features[0]]);
  assert.deepEqual(filterFeatures(data, 'all', 'Crew assigned', '').features, [features[0]]);
  assert.deepEqual(filterFeatures(data, 'all', '', 'MAIN').features, [features[1]]);
  assert.deepEqual(filterFeatures(data, 'facility', '', 'pothole').features, []);
});
test('organization suggestions filter by typed community name or slug', () => {
  const organizations = [
    { name: 'Frontend Test Town', slug: 'frontend-town' },
    { name: 'Riverside Community', slug: 'riverside-community' },
  ];
  assert.deepEqual(searchMapOrganizations(organizations, 'river'), [organizations[1]]);
  assert.deepEqual(searchMapOrganizations(organizations, 'FRONTEND-TOWN'), [organizations[0]]);
  assert.deepEqual(searchMapOrganizations(organizations, 'missing'), []);
});
test('plain-text proxy errors produce a service message instead of a JSON parser exception', async () => {
  await assert.rejects(
    readMapApiResponse(new Response('Internal Server Error', { status: 500 }), 'Could not load map data'),
    /Could not load map data \(HTTP 500\)/,
  );
});
