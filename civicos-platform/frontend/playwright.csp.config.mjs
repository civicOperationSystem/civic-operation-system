import { defineConfig } from '@playwright/test';
import frontendConfig from './playwright.frontend.config.mjs';

process.env.NEXT_DIST_DIR = '.next-csp-test';

export default defineConfig({
  ...frontendConfig,
  testDir: './tests/csp',
  use: { ...frontendConfig.use, baseURL: 'http://127.0.0.1:3320' },
  webServer: {
    command: 'npm run build && npm run start -- -p 3320',
    url: 'http://127.0.0.1:3320',
    timeout: 240000,
    reuseExistingServer: false,
  },
});
