import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

process.env.E2E_SLUG ||= `browser-${randomBytes(6).toString('hex')}`;
process.env.E2E_PASSWORD ||= randomBytes(20).toString('hex');
process.env.CIVIC_DB_PASSWORD = process.env.E2E_PASSWORD;
process.env.JWT_SECRET = process.env.E2E_PASSWORD;
process.env.CIVIC_ADMIN_DATABASE_URL = '';
process.env.CIVIC_DATABASE_URL = '';
process.env.DATABASE_URL = '';
process.env.CIVIC_MIGRATE_ONLY = 'false';
process.env.CIVIC_DATABASE = 'civicos_test';
process.env.CIVIC_DB_HOST = '127.0.0.1';
process.env.CIVIC_DB_PORT = process.env.CIVIC_TEST_PORT || '15433';
process.env.CIVIC_API_URL = 'http://127.0.0.1:3330';
process.env.SUPABASE_URL = 'http://127.0.0.1:3331';
process.env.SUPABASE_ANON_KEY = 'civicos-e2e-anon-key';
process.env.CIVIC_PLATFORM_ADMIN_EMAIL = 'owner@example.org';
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
process.env.NEXT_PUBLIC_CIVIC_MAP_URL = 'http://127.0.0.1:3311/civic';
process.env.NEXT_PUBLIC_CIVIC_PARENT_ORIGINS = 'http://127.0.0.1:3310';
process.env.NEXT_TELEMETRY_DISABLED = '1';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.spec.mjs',
  testIgnore: 'offline.spec.mjs',
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 20000 },
  reporter: 'list',
  globalTeardown: './tests/e2e/cleanup.mjs',
  use: { baseURL: 'http://127.0.0.1:3310', headless: true, actionTimeout: 15000, trace: 'retain-on-failure' },
  webServer: [
    { command: 'node tests/e2e/supabase.mjs', url: 'http://127.0.0.1:3331/health', timeout: 60000, reuseExistingServer: false },
    { command: 'node tests/e2e/backend.mjs', url: 'http://127.0.0.1:3330/health', timeout: 60000, reuseExistingServer: false },
    { command: 'npm run dev -- -p 3310', url: 'http://127.0.0.1:3310', timeout: 120000, reuseExistingServer: false },
    { command: 'npm run dev -- -p 3311', cwd: resolve('../../civicos-map'), url: 'http://127.0.0.1:3311/civic', timeout: 120000, reuseExistingServer: false },
  ],
});
