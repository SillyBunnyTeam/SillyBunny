/**
 * Waits until the app that a page loaded has fired `app_ready`. `getContext()` throws a ReferenceError while the app's
 * modules are still initialising (`Cannot access 'chat' before initialization`), and a `waitForFunction` predicate that
 * throws fails the wait instead of trying again, so a throw here means not ready yet. A page that is slow to start (many
 * workers on one server) meets that window.
 * @param {import('@playwright/test').Page} page
 * @param {{ timeout?: number }} [options]
 */
export async function waitForAppReady(page, { timeout = 60_000 } = {}) {
    await page.waitForFunction(() => {
        try {
            return Boolean(window.SillyTavern?.getContext?.()?.eventSource?.autoFireLastArgs?.has('app_ready'));
        } catch {
            return false;
        }
    }, null, { timeout });
}
