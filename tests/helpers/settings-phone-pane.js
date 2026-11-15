/**
 * On a phone the settings page shows the sidebar or the page, and the other one is off screen and inert. The Back button
 * sits in the page, so it is only pressed while the page is showing. `isVisible()` is true for the off-screen one too, so the
 * class that the shell sets on the page is the test.
 * @param {import('@playwright/test').Page} page
 */
export async function showSettingsSidebar(page) {
    if (await page.locator('#sb-settings-page.sb-settings-page--content').count() === 0) return;
    await page.locator('#sb-settings-back').click();
    await page.waitForFunction(() => !document.getElementById('sb-settings-page').classList.contains('sb-settings-page--content'));
}
