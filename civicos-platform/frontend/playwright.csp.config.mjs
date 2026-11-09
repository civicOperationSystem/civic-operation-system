import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import frontendConfig from './playwright.frontend.config.mjs';

process.env.NEXT_DIST_DIR = '.next-csp-test';
process.env.NEXT_PUBLIC_CIVIC_MAP_URL = 'http://127.0.0.1:3321/civic';
process.env.NEXT_PUBLIC_CIVIC_PARENT_ORIGINS = 'http://127.0.0.1:3320';

export default defineConfig({
  ...frontendConfig,
  testDir: './tests/csp',
  use: { ...frontendConfig.use, baseURL: 'http://127.0.0.1:3320' },
  webServer: [
    {
      command: 'npm run build && npm run start -- -p 3320',
      url: 'http://127.0.0.1:3320',
      timeout: 240000,
      reuseExistingServer: false,
    },
    {
      command: 'npm run build && npm run start -- -p 3321',
      cwd: resolve('../../civicos-map'),
      url: 'http://127.0.0.1:3321/civic',
      timeout: 240000,
      reuseExistingServer: false,
    },
  ],
});
