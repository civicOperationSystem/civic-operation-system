import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFieldUpdate, fieldScope, projectFieldDetail } from '../src/lib/field-offline.ts';

const fixture = () => ({
  session: { user: { id: 'worker' } }, savedAt: '2026-01-01', queue: [],
  details: [{
    id: 'ticket', assigned_to: 'worker', sync_version: '2026-01-01T00:00:00.123456Z',
    status: 'assigned', longitude: null, latitude: null, field_photos: [], history: [],
  }],
});

test('queued status, photo and coordinates project locally without changing the saved server version', () => {
  const original = fixture();
  let saved = appendFieldUpdate(original, 'ticket', { kind: 'transition', body: { status: 'in_progress', notes: '', note_visibility: 'down_chain' } });
  saved = appendFieldUpdate(saved, 'ticket', { kind: 'field-photo', body: { photo: 'photo', longitude: 0, latitude: 0 } });
  saved = appendFieldUpdate(saved, 'ticket', { kind: 'location', body: { longitude: 3, latitude: 5 } });
  const projected = projectFieldDetail(saved.details[0], saved.queue);
  assert.equal(projected.status, 'in_progress');
  assert.deepEqual(projected.field_photos, ['photo']);
  assert.equal(projected.longitude, 3);
  assert.equal(projected.latitude, 5);
  assert.equal(projected.sync_version, original.details[0].sync_version);
  assert.equal(original.queue.length, 0);
  assert.deepEqual(original.details[0].field_photos, []);
  assert.equal(new Set(saved.queue.map(item => item.id)).size, 3);
});

test('offline updates require an assigned, versioned ticket and retain all pending photo limits', () => {
  const update = { kind: 'field-photo', body: { photo: 'photo' } };
  assert.throws(() => appendFieldUpdate(fixture(), 'unknown', update), /Refresh/);
  const otherWorker = fixture();
  otherWorker.details[0].assigned_to = 'another-worker';
  assert.throws(() => appendFieldUpdate(otherWorker, 'ticket', update), /Only your assigned/);
  let saved = fixture();
  for (let count = 0; count < 3; count++) saved = appendFieldUpdate(saved, 'ticket', update);
  assert.throws(() => appendFieldUpdate(saved, 'ticket', update), /three field photos/);
  assert.equal(saved.queue.length, 3);
  saved.queue[0].error = 'Conflict';
  assert.throws(() => appendFieldUpdate(saved, 'ticket', { kind: 'notes', body: { notes: 'Note', note_visibility: 'down_chain' } }), /Resolve the blocked/);
});

test('offline workspace keys isolate both the verified identity and organization', () => {
  assert.notEqual(fieldScope('one', 'town'), fieldScope('two', 'town'));
  assert.notEqual(fieldScope('one', 'town'), fieldScope('one', 'other-town'));
});
