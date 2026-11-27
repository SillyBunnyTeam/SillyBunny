import { defineConfig } from '@playwright/test';
// SillyBunny: opt-in Chromium JS coverage collection for nightly client reach reporting.
import { installE2eClientCoverage } from './e2e-client-coverage.js';
// SillyBunny: by default the fork starts a managed server on a free port with an isolated account per worker.
import { SUITE_IGNORE, getServerConfig } from './e2e-servers.js';

// SillyBunny: attaches page V8 coverage in worker processes only when SILLYBUNNY_E2E_COVERAGE_DIR is set.
installE2eClientCoverage();

const explicitBaseURL = process.env.SILLYBUNNY_TEST_BASE_URL || process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL;
const baseURL = explicitBaseURL || 'http://127.0.0.1:4444';
// SillyBunny: Playwright imports this config again in each worker, and a worker reads its server and account here.
const sillyBunny = await getServerConfig();

export default defineConfig({
    testMatch: '*.e2e.js',
    // SillyBunny: `foundation/` runs under playwright.foundation.config.js and `audit/` holds the opt-in audit specs, which run under playwright.audit.config.js; this suite runs neither.
    testIgnore: [...SUITE_IGNORE],
    use: {
        baseURL,
        trace: 'retain-on-failure',
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
        // SillyBunny: the server and account storage state of this worker, plus request headers.
        ...sillyBunny.use,
    },
    // SillyBunny: '50%' of a large machine is more workers than one server can serve before tests time out.
    workers: sillyBunny.workers,
    fullyParallel: true,
    // SillyBunny: the servers, first boot priming and cleanup, when the config starts them.
    ...sillyBunny.config,
});
