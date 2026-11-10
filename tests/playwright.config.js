import { defineConfig } from '@playwright/test';
// SillyBunny: the fork can start several test servers and spread the workers over them.
import { getServerConfig } from './e2e-servers.js';

const baseURL = process.env.SILLYBUNNY_TEST_BASE_URL || process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4444';
// SillyBunny: Playwright imports this config again in each worker, and a worker reads its server here.
const sillyBunny = await getServerConfig();

export default defineConfig({
    testMatch: '*.e2e.js',
    use: {
        baseURL,
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
        // SillyBunny: the server of this worker and the request headers.
        ...sillyBunny.use,
    },
    // SillyBunny: '50%' of a large machine is more workers than one server can serve before tests time out.
    workers: sillyBunny.workers,
    fullyParallel: true,
    // SillyBunny: the servers and their first boot, when the config starts them.
    ...sillyBunny.config,
});
