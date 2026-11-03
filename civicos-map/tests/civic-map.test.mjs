import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterFeatures, isMapContext } from '../lib/civic-map.ts';

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
