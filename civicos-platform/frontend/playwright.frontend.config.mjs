import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://frontend-only.test';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'frontend-only-anon-key';
process.env.NEXT_PUBLIC_CIVIC_MAP_URL = 'http://127.0.0.1:3311/civic';
process.env.NEXT_PUBLIC_CIVIC_PARENT_ORIGINS = 'http://127.0.0.1:3310';
process.env.NEXT_TELEMETRY_DISABLED = '1';

export default defineConfig({
  testDir: './tests/frontend',
  testMatch: '*.spec.mjs',
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 20000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3310',
    headless: true,
    serviceWorkers: 'block',
    actionTimeout: 15000,
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'npm run dev -- -p 3310', url: 'http://127.0.0.1:3310', timeout: 120000, reuseExistingServer: false },
    { command: 'npm run dev -- -p 3311', cwd: resolve('../../civicos-map'), url: 'http://127.0.0.1:3311/civic', timeout: 120000, reuseExistingServer: false },
  ],
});
