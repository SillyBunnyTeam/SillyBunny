/**
 * Prepares a test to check what the app copies. Chromium accepts clipboard permissions, so the test
 * reads the real clipboard. Playwright cannot grant them in WebKit or Firefox, so there the page
 * records every `navigator.clipboard.writeText` call instead.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} browserName
 */
export async function trackClipboard(page, browserName) {
    if (browserName === 'chromium') {
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        return;
    }
    await page.evaluate(() => {
        const original = navigator.clipboard.writeText.bind(navigator.clipboard);
        window.qaCopied = [];
        navigator.clipboard.writeText = text => {
            window.qaCopied.push(text);
            return original(text).catch(() => {});
        };
    });
}

/** The last text the app copied, as set up by `trackClipboard`. */
export function copiedText(page, browserName) {
    if (browserName === 'chromium') return page.evaluate(() => navigator.clipboard.readText());
    return page.evaluate(() => window.qaCopied.at(-1));
}

/**
 * The file name a download suggests. WebKit turns spaces into underscores, so the name is compared
 * with those put back; Chromium keeps the exact name.
 */
export function suggestedName(download, browserName) {
    const name = download.suggestedFilename();
    return browserName === 'webkit' ? name.replaceAll('_', ' ') : name;
}

/**
 * The keys that move from the last radio of a native group to its first one. ArrowRight wraps around
 * in Chromium and Firefox. WebKit stays on the last radio, so there it walks back one radio at a time.
 *
 * @param {string} browserName
 * @param {number} radioCount How many radios the group has.
 */
export function keysFromLastRadioToFirst(browserName, radioCount) {
    return browserName === 'webkit' ? Array(radioCount - 1).fill('ArrowLeft') : ['ArrowRight'];
}

/**
 * Activates a button the way a user's pointer does. Safari does not focus a button on mouse click, so a
 * dialog it opens has no opener to return focus to. In WebKit the button is focused and Enter is pressed
 * instead, which is how a keyboard user opens it; other engines get the real click.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} button
 * @param {string} browserName
 */
export async function activateButton(page, button, browserName) {
    if (browserName !== 'webkit') {
        await button.click();
        return;
    }
    await button.focus();
    await page.keyboard.press('Enter');
}
