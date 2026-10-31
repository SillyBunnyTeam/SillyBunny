import { answerFirstRunWelcome, keepWelcomeClosed } from '../helpers/welcome-dialog.js';

const baseURL = process.env.SILLYBUNNY_TEST_BASE_URL || process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4444';

export const testSetup = {
    /**
     * Navigates to the home page without waiting for SillyTavern to load.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    goST: async ({ page }) => {
        await keepWelcomeClosed(page.context());
        await page.goto('/');
    },

    /**
     * Waits for SillyTavern to fully load by navigating to the home page and waiting for the preloader to disappear.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    awaitST: async ({ page }) => {
        await keepWelcomeClosed(page.context());
        await page.goto('/');
        if (await testSetup.isLoginPage({ page })) {
            // eslint-disable-next-line playwright/no-networkidle
            await page.waitForLoadState('networkidle');
            // Try accounts from last to first: clicking a password-protected account stays on the login page
            const userSelects = page.locator('#userList .userSelect');
            const userCount = await userSelects.count();
            for (let i = userCount - 1; i >= 0; i--) {
                await userSelects.nth(i).click();
                const loggedIn = await page
                    .waitForURL(url => url.toString().startsWith(baseURL) && url.pathname !== '/login', { timeout: 3000 })
                    .then(() => true, () => false);
                if (loggedIn) {
                    break;
                }
            }
            if (await testSetup.isLoginPage({ page })) {
                throw new Error('Could not log into any account without a password.');
            }
        }
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
        await testSetup.waitForAppReady({ page });
    },

    /**
     * Waits for APP_READY on any profile, including a fresh one. A fresh data root holds
     * startup on the first-run Welcome dialog until the persona has a name, and the helper names it.
     * SB also releases the preloader before its async startup work finishes.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    waitForAppReady: async ({ page }) => {
        const appEvents = await page.evaluateHandle(() => import('/scripts/events.js'));
        const startupState = await page.waitForFunction(({ eventSource, event_types }) => {
            if (eventSource.autoFireLastArgs.has(event_types.APP_READY)) return 'ready';
            if (document.querySelector('dialog[open] .sbWelcomeDialog')) return 'welcome';
            return document.querySelector('dialog[open] .onboarding') ? 'popup' : false;
        }, appEvents);
        const state = await startupState.jsonValue();
        if (state === 'popup') {
            // Answering the popup of upstream would hide a Welcome dialog that failed to load.
            throw new Error('The first run showed the onboarding popup of upstream, so the Welcome dialog did not load.');
        }
        if (state === 'welcome') {
            await answerFirstRunWelcome(page);
            await page.waitForFunction(({ eventSource, event_types }) => {
                return eventSource.autoFireLastArgs.has(event_types.APP_READY);
            }, appEvents);
        }
        await startupState.dispose();
        await appEvents.dispose();
    },

    /**
     * Checks if the current page is the login page by looking for a body element with the class 'login'.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    isLoginPage: async ({ page }) => {
        return await page.locator('body.login').count() > 0;
    },
};
