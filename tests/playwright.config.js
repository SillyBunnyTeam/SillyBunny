import { defineConfig } from '@playwright/test';

export default defineConfig({
    testMatch: '*.e2e.js',
    use: {
        baseURL: process.env.SILLYBUNNY_TEST_BASE_URL || 'http://127.0.0.1:4444',
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },
    workers: 4,
    fullyParallel: true,
});
