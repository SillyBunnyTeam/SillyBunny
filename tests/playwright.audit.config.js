import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config.js';

// Opt-in: the audit specs that iterate over the surface registry. They live in `audit/`, which the default, Firefox,
// WebKit and foundation configs do not run.
// The global setup seeds only servers that the run started: the N servers that this config starts with
// `SILLYBUNNY_TEST_SERVERS=N`, or the server that the test runner starts for a shard (`E2E_BASE_URL`). A server that you started
// by hand needs `SILLYBUNNY_AUDIT_SEED=1`, and port 4444 is always refused.
export default defineConfig({
    ...baseConfig,
    testDir: './audit',
    testMatch: '*.e2e.js',
    testIgnore: [],
    // The default config orders its specs by projects that name spec files of the default suite.
    projects: undefined,
    // The servers' first boot (when the config starts them), then the registry's fixtures.
    globalSetup: [...[baseConfig.globalSetup ?? []].flat(), './audit/seed-fixtures.global-setup.js'],
    // Every surface boots the app once, and a settings page expands every drawer.
    timeout: 120_000,
    expect: { timeout: 15_000 },
    use: {
        ...baseConfig.use,
        serviceWorkers: 'block',
        // Dates on a surface are formatted in the browser's zone and locale, and a capture must not depend on the machine's.
        timezoneId: 'UTC',
        locale: 'en-US',
    },
});
