import { expect, test as base } from '@playwright/test';
import { dismissOnboardingIfPresent } from './chat-scroll-regression-helpers.js';
import { testSetup } from './frontend/frontent-test-utils.js';

const definition = Array.from({ length: 120 }, (_, index) => `Character definition line ${index + 1}.`).join('\n');
const test = base.extend({
    userAgent: async ({ browserName }, use) => {
        await use(browserName === 'firefox'
            ? 'Mozilla/5.0 (Android 14; Mobile; rv:150.0) Gecko/150.0 Firefox/150.0'
            : 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36');
    },
});

test.use({ hasTouch: true, viewport: { width: 412, height: 839 } });

async function touchMoveIsCanceled(textarea, deltaY) {
    return textarea.evaluate((element, movementY) => {
        const bounds = element.getBoundingClientRect();
        const touch = {
            identifier: 1,
            target: element,
            clientX: bounds.x + bounds.width / 2,
            clientY: bounds.y + bounds.height / 2,
        };
        const dispatchTouch = (type, touches) => {
            // Firefox does not expose a Touch constructor; exercise the document's real capture listeners.
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'touches', { value: touches });
            element.dispatchEvent(event);
            return event.defaultPrevented;
        };
        dispatchTouch('touchstart', [touch]);
        const canceled = dispatchTouch('touchmove', [{
            identifier: touch.identifier,
            target: element,
            clientX: touch.clientX,
            clientY: touch.clientY + movementY,
        }]);
        dispatchTouch('touchend', []);
        return canceled;
    }, deltaY);
}

test.describe('expanded editor touch handling', () => {
    test.beforeEach(async ({ page }) => {
        let settingsVersion = Date.now();
        await page.route('**/api/settings/save', route => route.fulfill({ status: 200, json: { version: ++settingsVersion } }));
        await testSetup.awaitST({ page });
        await dismissOnboardingIfPresent(page);
        const setupDialogClose = page.getByRole('button', { name: 'Close dialog', exact: true });
        if (await setupDialogClose.isVisible()) {
            await setupDialogClose.click();
        }
        await page.getByRole('button', { name: 'Open character management', exact: true }).click();
        await page.getByTitle('Create New Character', { exact: true }).click();
        await page.getByRole('tab', { name: 'Definitions', exact: true }).click();
        await page.locator('#description_textarea').fill(definition);
        await page.locator('.editor_maximize[data-for="description_textarea"]').click();
        await expect(page.locator('.maximized_textarea')).toBeVisible();
    });

    for (const focused of [false, true]) {
        test(`allows scrolling inside a ${focused ? 'focused' : 'blurred'} definition and blocks overscroll`, async ({ page }) => {
            const textarea = page.locator('.maximized_textarea');
            const range = await textarea.evaluate((element, shouldFocus) => {
                element.setSelectionRange(0, 0);
                if (shouldFocus) {
                    element.focus({ preventScroll: true });
                } else {
                    element.blur();
                }
                element.scrollTop = 0;
                return element.scrollHeight - element.clientHeight;
            }, focused);
            expect(range).toBeGreaterThan(200);

            expect(await touchMoveIsCanceled(textarea, -40)).toBe(false);
            expect(await touchMoveIsCanceled(textarea, 40)).toBe(true);

            await textarea.evaluate(element => { element.scrollTop = 100; });
            expect(await touchMoveIsCanceled(textarea, -40)).toBe(false);
            expect(await touchMoveIsCanceled(textarea, 40)).toBe(false);

            await textarea.evaluate(element => { element.scrollTop = element.scrollHeight; });
            expect(await touchMoveIsCanceled(textarea, -40)).toBe(true);
            expect(await touchMoveIsCanceled(textarea, 40)).toBe(false);
            await expect(textarea).toHaveValue(definition);
        });
    }

    test('keeps touch scrolling blocked for explicitly clipped editors', async ({ page }) => {
        const textarea = page.locator('.maximized_textarea');
        for (const overflow of ['hidden', 'clip']) {
            await textarea.evaluate((element, value) => {
                element.blur();
                element.style.overflow = value;
                element.scrollTop = 0;
            }, overflow);
            expect(await touchMoveIsCanceled(textarea, -40)).toBe(true);
        }
    });
});
