import { defineConfig } from '@playwright/test';

const port = Number(process.env.SB_UI_TEST_PORT || 4459);
const baseURL = `http://127.0.0.1:${port}`;
const sizes = [
    ['desktop', 1440, 900],
    ['tablet', 768, 1024],
    ['phone', 390, 844],
    ['narrow', 320, 740],
];

export default defineConfig({
    testDir: './foundation',
    testMatch: '*.e2e.js',
    timeout: 60000,
    workers: 1,
    outputDir: process.env.SB_UI_ARTIFACTS || 'test-results/foundation',
    use: { baseURL, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    projects: ['chromium', 'webkit'].flatMap(browserName => sizes.map(([size, width, height]) => ({
        name: `${browserName}-${size}`,
        use: { browserName, viewport: { width, height }, isMobile: width <= 768, hasTouch: width <= 768 },
    }))),
    webServer: {
        command: 'node foundation/server.js',
        url: baseURL,
        reuseExistingServer: false,
        timeout: 60000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
    },
});
