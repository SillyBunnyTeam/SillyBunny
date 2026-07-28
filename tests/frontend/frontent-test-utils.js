export const testSetup = {
    /**
     * Navigates to the home page without waiting for SillyTavern to load.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    goST: async ({ page }) => {
        await page.goto('/');
    },

    /**
     * Waits for SillyTavern to fully load by navigating to the home page and waiting for the preloader to disappear.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    awaitST: async ({ page }) => {
        await page.goto('/');
        if (new URL(page.url()).pathname === '/login') {
            await page.locator('#userList .userSelect').last().click();
            await page.waitForURL(url => url.pathname === '/');
        }
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    },
};
