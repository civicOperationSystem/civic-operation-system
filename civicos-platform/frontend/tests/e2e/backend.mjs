import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';

if (process.env.CIVIC_DATABASE !== 'civicos_test' || !process.env.E2E_SLUG?.startsWith('browser-')) {
  throw new Error('Browser fixtures may run only in civicos_test with a generated browser slug');
}
if (process.env.CIVIC_ADMIN_DATABASE_URL !== '' || process.env.CIVIC_DATABASE_URL !== '' || process.env.DATABASE_URL !== '' ||
    process.env.CIVIC_DB_HOST !== '127.0.0.1' || process.env.CIVIC_MIGRATE_ONLY !== 'false') {
  throw new Error('Browser fixtures require the isolated local test database and must not use database URLs');
}
const directory = resolve('../../civicos-backend');
execFileSync(process.execPath, ['dist/scripts/civic-init.js'], {
  cwd: directory,
  env: {
    ...process.env,
    POSTGRES_PASSWORD: process.env.CIVIC_TEST_PASSWORD || 'civicos-test-local-only',
    CIVIC_ADMIN_EMAIL: 'admin@example.org',
    CIVIC_SLUG: process.env.E2E_SLUG, CIVIC_NAME: 'Browser Test Community', CIVIC_DOMAIN: '',
  },
  stdio: 'pipe',
});
const server = spawn(process.execPath, ['dist/index.js', '--port', '3330'], {
  cwd: directory, env: process.env, stdio: 'inherit',
});
server.on('error', error => { console.error('Browser fixture backend failed', error); process.exitCode = 1; });
server.on('exit', code => { process.exitCode = code || 0; });
