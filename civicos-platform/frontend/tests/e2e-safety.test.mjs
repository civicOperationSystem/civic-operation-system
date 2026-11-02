import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('browser fixtures reject unsafe database settings before provisioning', () => {
  const cases = [
    { CIVIC_ADMIN_DATABASE_URL: 'postgresql://example.invalid/test' },
    { CIVIC_DATABASE_URL: 'postgresql://example.invalid/test' },
    { DATABASE_URL: 'postgresql://example.invalid/test' },
    { CIVIC_ADMIN_DATABASE_URL: undefined },
    { CIVIC_DB_HOST: 'example.invalid' },
    { CIVIC_MIGRATE_ONLY: 'true' },
  ];
  for (const overrides of cases) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./e2e/backend.mjs', import.meta.url))], {
      env: {
        ...process.env,
        CIVIC_DATABASE: 'civicos_test',
        E2E_SLUG: 'browser-safety-test',
        CIVIC_DB_HOST: '127.0.0.1',
        CIVIC_MIGRATE_ONLY: 'false',
        CIVIC_ADMIN_DATABASE_URL: '',
        CIVIC_DATABASE_URL: '',
        DATABASE_URL: '',
        ...overrides,
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /require the isolated local test database/);
  }
});
