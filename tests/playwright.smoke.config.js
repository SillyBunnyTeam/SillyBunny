import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config.js';
import { SMOKE_SPECS } from './e2e-smoke-specs.js';

// Chromium PR smoke suite (`npm run test:e2e:smoke`).
// Sized to finish well inside the 10-minute pull-request check budget.
export default defineConfig({
    ...baseConfig,
    testMatch: SMOKE_SPECS.map(name => `**/${name}.e2e.js`),
    // Replace the default sequential/parallel projects so `SILLYBUNNY_TEST_SERVERS` does not pull in non-smoke specs.
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
