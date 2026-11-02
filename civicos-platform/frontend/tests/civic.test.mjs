import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { civicApi, displayDate, readPhoto, readPublicPhoto, readFieldPhoto, fieldCanEnter } from '../src/lib/civic.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test('shared API sends tenant-aware bearer sessions in headers, never URLs', async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ status: 'completed' }), { status: 200 });
  };
  const result = await civicApi('/staff/requests/example/transition', {
    token: 'private-session', method: 'POST', body: { status: 'completed', notes: 'private note' },
  });
  assert.equal(result.status, 'completed');
  assert.equal(call.url, '/api/civic/staff/requests/example/transition');
  assert.equal(call.options.headers.Authorization, 'Bearer private-session');
  assert.equal(call.options.cache, 'no-store');
});
test('public tracking sends capability in a POST body and surfaces errors', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/civic/public/town-a/track');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.parse(options.body).reference, 'private-reference');
    return new Response(JSON.stringify({ message: 'Request not found' }), { status: 404 });
  };
  await assert.rejects(civicApi('/public/town-a/track', { method: 'POST', body: { reference: 'private-reference' } }), /Request not found/);
});
test('dates respect organization locale and timezone', () => {
  const settings = { language: 'en-US', timezone: 'America/New_York' };
  const date = displayDate('2026-10-08T01:00:00Z', settings);
  assert.match(date, /Oct 7, 2026/);
});
test('unsupported and oversized photos fail explicitly before upload', async () => {
  await assert.rejects(readPhoto(new File(['svg'], 'photo.svg', { type: 'image/svg+xml' })), /PNG, JPEG or WebP/);
  await assert.rejects(readPhoto(new File([new Uint8Array(2097153)], 'large.png', { type: 'image/png' })), /2 MB/);
  await assert.rejects(readFieldPhoto(new File(['pdf'], 'photo.pdf', { type: 'application/pdf' })), /PNG, JPEG or WebP/);
  await assert.rejects(readFieldPhoto(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })), /5 MB/);
  await assert.rejects(readPublicPhoto(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })), /2 MB/);
});
test('configured field access overrides the legacy in-progress/completed convention', () => {
  assert.equal(fieldCanEnter({ key: 'repairing', label: 'Repairing', next: [], field: true }), true);
  assert.equal(fieldCanEnter({ key: 'in_progress', label: 'Working', next: [], field: false }), false);
  assert.equal(fieldCanEnter({ key: 'completed', label: 'Completed', next: [] }), true);
});
