import { defineConfig } from '@playwright/test';

const baseURL = process.env.SILLYBUNNY_TEST_BASE_URL || process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4444';

export default defineConfig({
    testMatch: '*.e2e.js',
    use: {
        baseURL,
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },
    workers: 4,
    fullyParallel: true,
});
