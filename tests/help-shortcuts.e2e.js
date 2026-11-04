import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { testSetup } from './frontend/frontent-test-utils.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { sizeFreeTestFor } from './helpers/matrix.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 60_000 });

const VIEWPORTS = [
    { name: 'desktop 1440x900', options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];
const STARTUP_TIMEOUT = 20_000;

const OPEN_HOSTS = 'dialog[open]:not([closing])';
const HELP = `${OPEN_HOSTS} .sbHelpDialog`;
const SHORTCUTS = `${OPEN_HOSTS} .sbShortcutsDialog`;
const MODE_TOGGLE = '#sb-mode-toggle';

/** The first copy slot of a topic body. */
const topicBody = (page, id) => page.locator(`${HELP} [data-sb-copy-slot="HELP-TOPIC-${id}"]`);

const TOPIC_PAGE = '.sbHelpPage[data-sb-help-view="topic"]';

/** Opens Help and a section of it, which is the way in on a phone as well as on a desktop. */
async function openHelpAtSection(page, sectionTitle) {
    await page.keyboard.press('F1');
    await page.locator(`${HELP} .sbHelpNavRow`, { hasText: sectionTitle }).click();
}

/** Opens the topic of a link row on the page that is shown. */
async function clickTopic(page, topicTitle) {
    await page.locator(`${HELP} .sbHelpPage button`, { hasText: topicTitle }).first().click();
}

async function openConnectTopic(page) {
    await openHelpAtSection(page, 'Models and Connections');
    await clickTopic(page, 'Connect to a Model');
}

/**
 * Records how topic pages enter the document. A page that has its body in place enters once, with the slot inside
 * it. A slot that enters on its own was swapped in after the page.
 */
async function watchTopicPages(page) {
    await page.evaluate(() => {
        const pageSelector = '.sbHelpPage[data-sb-help-view="topic"]';
        const slotSelector = '[data-sb-copy-slot^="HELP-TOPIC-"]:not([data-sb-copy-slot$="-DESC"])';
        window.__topicPageEvents = [];
        new MutationObserver((records) => {
            for (const node of records.flatMap(record => [...record.addedNodes])) {
                if (!(node instanceof Element)) continue;
                const topicPage = node.matches(pageSelector) ? node : node.querySelector(pageSelector);
                if (topicPage) {
                    window.__topicPageEvents.push({ event: 'page', id: topicPage.dataset.sbHelpId, slot: topicPage.querySelector(slotSelector) !== null });
                } else if (node.matches(slotSelector) || node.querySelector(slotSelector)) {
                    window.__topicPageEvents.push({ event: 'slot-after-page' });
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    });
}

/**
 * Starts the app on Home, with Welcome closed and no write reaching the data root.
 * @param {import('@playwright/test').Page} page
 * @param {{ platform?: string }} [options] `platform` is what `navigator.platform` says, for a spec of the Apple modifier.
 */
async function boot(page, { platform = null } = {}) {
    await protectMaintainerServer(page);
    if (platform) {
        await page.addInitScript((value) => {
            Object.defineProperty(Navigator.prototype, 'platform', { get: () => value, configurable: true });
        }, platform);
    }
    await testSetup.awaitST({ page });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await recordKeydowns(page);
}

/** Starts the app with a chat open, so `#send_textarea` is on the page. */
async function bootWithChat(page) {
    await protectMaintainerServer(page);
    await openQuietChatForSmoke(page);
    await expect(page.locator('#send_textarea')).toBeVisible();
    await recordKeydowns(page);
}

/**
 * Records, for every keydown, whether it was cancelled by the time it bubbled to the window. A handler that held the
 * key back from the browser (F1 would otherwise open the browser's own help) has called `preventDefault` by then.
 */
async function recordKeydowns(page) {
    await page.evaluate(() => {
        window.__keydowns = [];
        window.addEventListener('keydown', event => window.__keydowns.push({ key: event.key, prevented: event.defaultPrevented }));
    });
}

const lastKeydown = page => page.evaluate(() => window.__keydowns.at(-1));

/** Waits out the frames in which a window that was wrongly opened would show up. */
async function settle(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))));
}

async function closeTopDialog(page) {
    await page.keyboard.press('Escape');
    await expect(page.locator(OPEN_HOSTS)).toHaveCount(0);
}

/** Escape goes back one pushed page at a time, so a window that stacks pages needs more than one. */
async function closeEveryDialog(page) {
    for (let attempt = 0; attempt < 4 && await page.locator(OPEN_HOSTS).count() > 0; attempt++) {
        await page.keyboard.press('Escape');
        await settle(page);
    }
    await expect(page.locator(OPEN_HOSTS)).toHaveCount(0);
}

/** A dialog of the editor family that is not Help or Keyboard Shortcuts. */
async function openOtherDialog(page) {
    await page.evaluate(async () => {
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        openDialog({ tier: 'dialog', title: 'Other dialog', content: document.createElement('p') });
    });
    await expect(page.locator(`${OPEN_HOSTS} .sb-dialog`)).toBeVisible();
}

/** The general shortcuts of the registry, as Playwright presses them. */
const GENERAL_KEYS = {
    'Mod+?': 'Control+?',
    'F1': 'F1',
    'Mod+O': 'Control+o',
    'Mod+U': 'Control+u',
    'Mod+I': 'Control+i',
    'Mod+P': 'Control+p',
    'Mod+F': 'Control+f',
    'Mod+M': 'Control+m',
};

/** The Markdown hotkeys of the registry, with what each makes of the selected word. */
const FORMATTING = {
    'Ctrl+B': { press: 'Control+b', result: '**word**' },
    'Ctrl+I': { press: 'Control+i', result: '*word*' },
    'Ctrl+U': { press: 'Control+u', result: '__word__' },
    'Ctrl+K': { press: 'Control+k', result: '`word`' },
    'Ctrl+Shift+~': { press: 'Control+Shift+Backquote', result: '~~word~~' },
};

const registryOf = (page, scope) => page.evaluate(async (wanted) => {
    const { getShortcuts } = await import('/scripts/sillybunny-shortcuts.js');
    return getShortcuts().filter(entry => entry.scope === wanted).map(entry => entry.keys.join('+'));
}, scope);

/** The selected tab of the settings page, which says which section its content shows. */
const settingsTab = page => page.locator('#sb-settings-page .sb-settings-tab[aria-selected="true"]');

for (const { name, options } of VIEWPORTS) {
    test.describe(`Help and Keyboard Shortcuts keys, ${name}`, () => {
        test.use(options);
        // Only the tests that lay out Learn More or open a topic page use `test`; the rest do not depend on the size.
        const sizeFreeTest = sizeFreeTestFor(test, options.viewport);

        test.describe('on Home', () => {
            test.beforeEach(async ({ page }) => {
                await boot(page);
            });

            sizeFreeTest('F1 opens Help and holds the key back from the browser', async ({ page }) => {
                await page.keyboard.press('F1');

                await expect(page.locator(HELP)).toBeVisible();
                await expect(page.locator(SHORTCUTS)).toHaveCount(0);
                expect(await lastKeydown(page)).toEqual({ key: 'F1', prevented: true });
            });

            sizeFreeTest('Ctrl+? opens Keyboard Shortcuts and holds the key back', async ({ page }) => {
                await page.keyboard.press('Control+?');

                await expect(page.locator(SHORTCUTS)).toBeVisible();
                await expect(page.locator(HELP)).toHaveCount(0);
                expect(await lastKeydown(page)).toEqual({ key: '?', prevented: true });
            });

            sizeFreeTest('Super+? opens nothing and is left to the system, because the modifier of the app here is Ctrl', async ({ page }) => {
                await page.keyboard.press('Meta+?');
                await settle(page);

                await expect(page.locator(OPEN_HOSTS)).toHaveCount(0);
                expect(await lastKeydown(page)).toEqual({ key: '?', prevented: false });
            });

            sizeFreeTest('a plain question mark and Ctrl with another key open nothing', async ({ page }) => {
                await page.keyboard.press('?');
                await page.keyboard.press('Control+/');
                await page.keyboard.press('Control+F1');
                await page.keyboard.press('Shift+F1');
                await settle(page);

                await expect(page.locator(OPEN_HOSTS)).toHaveCount(0);
            });

            sizeFreeTest('the AltGr question mark opens nothing and is left to the layout', async ({ page }) => {
                await page.keyboard.press('Control+Alt+?');
                await settle(page);

                await expect(page.locator(OPEN_HOSTS)).toHaveCount(0);
                expect(await lastKeydown(page)).toEqual({ key: '?', prevented: false });
            });

            sizeFreeTest('a window that is open is not opened again: the key does nothing', async ({ page }) => {
                await page.keyboard.press('F1');
                await expect(page.locator(HELP)).toBeVisible();

                await page.keyboard.press('F1');
                await settle(page);

                await expect(page.locator(OPEN_HOSTS)).toHaveCount(1);
                await expect(page.locator(HELP)).toHaveCount(1);
                expect(await lastKeydown(page)).toEqual({ key: 'F1', prevented: true });
            });

            sizeFreeTest('Ctrl+? over Help shows Keyboard Shortcuts as a page of the same window, and Back returns to Help', async ({ page }) => {
                await page.keyboard.press('F1');
                await expect(page.locator(HELP)).toBeVisible();

                await page.keyboard.press('Control+?');

                await expect(page.locator(SHORTCUTS)).toBeVisible();
                await expect(page.locator(OPEN_HOSTS)).toHaveCount(1);

                await page.keyboard.press('Control+?');
                await settle(page);
                await expect(page.locator(SHORTCUTS)).toHaveCount(1);

                await page.locator(`${OPEN_HOSTS} .sb-dialog__back:visible`).click();
                await expect(page.locator(SHORTCUTS)).toBeHidden();
                await expect(page.locator(HELP)).toBeVisible();
                await expect(page.locator(OPEN_HOSTS)).toHaveCount(1);
            });

            sizeFreeTest('another modal blocks both keys, and the browser still does not get F1', async ({ page }) => {
                await openOtherDialog(page);

                await page.keyboard.press('F1');
                expect(await lastKeydown(page)).toEqual({ key: 'F1', prevented: true });
                await page.keyboard.press('Control+?');
                expect(await lastKeydown(page)).toEqual({ key: '?', prevented: true });
                await settle(page);

                await expect(page.locator(HELP)).toHaveCount(0);
                await expect(page.locator(SHORTCUTS)).toHaveCount(0);
                await expect(page.locator(OPEN_HOSTS)).toHaveCount(1);

                await closeTopDialog(page);
                await page.keyboard.press('F1');
                await expect(page.locator(HELP)).toBeVisible();
            });

            sizeFreeTest('a legacy popup blocks both keys as well', async ({ page }) => {
                await page.evaluate(async () => {
                    const { callGenericPopup, POPUP_TYPE } = await import('/scripts/popup.js');
                    void callGenericPopup('A popup', POPUP_TYPE.TEXT);
                });
                await expect(page.locator('dialog.popup[open]:not([closing])')).toBeVisible();

                await page.keyboard.press('F1');
                await page.keyboard.press('Control+?');
                await settle(page);

                await expect(page.locator(HELP)).toHaveCount(0);
                await expect(page.locator(SHORTCUTS)).toHaveCount(0);
            });

            sizeFreeTest('Keyboard Shortcuts lists F1 and Ctrl+?, and notes the Formatting group as copy that is still missing', async ({ page }) => {
                await page.keyboard.press('Control+?');
                const window = page.locator(SHORTCUTS);
                await expect(window).toBeVisible();

                const keysOf = label => window.locator('.ds-row', { has: page.getByText(label, { exact: true }) }).locator('kbd.sbKeys');
                await expect(keysOf('Help')).toHaveText('F1');
                await expect(keysOf('Keyboard Shortcuts')).toHaveText('Ctrl+?');

                const note = window.locator('[data-sb-copy-slot="SHORTCUTS-FORMATTING-NOTE"]');
                await expect(note).toHaveCount(1);
                await expect(note).toHaveText('TODO(copy)');
                await expect(note).toHaveAttribute('data-sb-copy-placeholder', 'true');
            });

            sizeFreeTest('every general shortcut of the registry has its key pinned here, and does what its row says', async ({ page }) => {
                expect(await registryOf(page, 'general')).toEqual(Object.keys(GENERAL_KEYS));

                await test.step('Ctrl+U opens Backend settings on Connections', async () => {
                    await page.keyboard.press(GENERAL_KEYS['Mod+U']);
                    await expect(page.locator('#sb-settings-page')).toBeVisible();
                    await expect(page.locator('#sb-settings-page [data-sb-shell-key="left"]')).toBeAttached();
                    await expect(settingsTab(page)).toHaveAttribute('data-sb-settings-tab', 'connections');
                });

                await test.step('Ctrl+I opens Customize on Appearance', async () => {
                    await page.keyboard.press(GENERAL_KEYS['Mod+I']);
                    await expect(settingsTab(page)).toHaveText(/Appearance/);
                });

                await test.step('Ctrl+P opens Characters', async () => {
                    await page.keyboard.press(GENERAL_KEYS['Mod+P']);
                    await expect(settingsTab(page)).toHaveText(/Characters/);
                });

                await test.step('Ctrl+O returns to Home', async () => {
                    await page.keyboard.press(GENERAL_KEYS['Mod+O']);
                    await expect(page.locator('#sb-settings-page')).toBeHidden();
                    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
                });

                await test.step('Ctrl+F opens search', async () => {
                    await expect(page.locator('#sb-universal-search')).not.toHaveClass(/is-open/);
                    await page.keyboard.press(GENERAL_KEYS['Mod+F']);
                    await expect(page.locator('#sb-universal-search')).toHaveClass(/is-open/);
                });

                await test.step('Ctrl+M switches the mode', async () => {
                    const before = await page.locator(MODE_TOGGLE).getAttribute('aria-label');
                    await page.keyboard.press(GENERAL_KEYS['Mod+M']);
                    await expect(page.locator(MODE_TOGGLE)).not.toHaveAttribute('aria-label', before);
                });

                await test.step('F1 and Ctrl+? open their windows', async () => {
                    await page.keyboard.press(GENERAL_KEYS.F1);
                    await expect(page.locator(HELP)).toBeVisible();
                    await closeTopDialog(page);
                    await page.keyboard.press(GENERAL_KEYS['Mod+?']);
                    await expect(page.locator(SHORTCUTS)).toBeVisible();
                });
            });
        });

        test.describe('in the message box', () => {
            test.beforeEach(async ({ page }) => {
                await bootWithChat(page);
                await page.locator('#send_textarea').fill('draft');
                await page.locator('#send_textarea').focus();
            });

            sizeFreeTest('F1 and Ctrl+? open their windows from #send_textarea and leave the draft alone', async ({ page }) => {
                await page.keyboard.press('F1');
                await expect(page.locator(HELP)).toBeVisible();
                await closeTopDialog(page);
                await expect(page.locator('#send_textarea')).toHaveValue('draft');

                await page.locator('#send_textarea').focus();
                await page.keyboard.press('Control+?');
                await expect(page.locator(SHORTCUTS)).toBeVisible();
                await closeTopDialog(page);
                await expect(page.locator('#send_textarea')).toHaveValue('draft');
            });

            sizeFreeTest('the AltGr question mark in #send_textarea opens no window and leaves the draft alone', async ({ page }) => {
                await page.keyboard.press('Control+Alt+?');
                await settle(page);

                await expect(page.locator(OPEN_HOSTS)).toHaveCount(0);
                await expect(page.locator('#send_textarea')).toHaveValue('draft');
                expect(await lastKeydown(page)).toEqual({ key: '?', prevented: false });
            });

            sizeFreeTest('the Markdown hotkeys of the registry format the selected word, once the setting is on', async ({ page }) => {
                await page.evaluate(async () => {
                    const { power_user } = await import('/scripts/power-user.js');
                    power_user.enable_md_hotkeys = true;
                });
                expect(await registryOf(page, 'formatting')).toEqual(Object.keys(FORMATTING));

                for (const [label, { press, result }] of Object.entries(FORMATTING)) {
                    await test.step(label, async () => {
                        await page.locator('#send_textarea').fill('word');
                        await page.keyboard.press('Control+a');
                        await page.keyboard.press(press);
                        await expect(page.locator('#send_textarea')).toHaveValue(result);
                        await expect(page.locator(OPEN_HOSTS)).toHaveCount(0);
                    });
                }
            });

            sizeFreeTest('the Markdown hotkeys do nothing while the setting is off', async ({ page }) => {
                await page.evaluate(async () => {
                    const { power_user } = await import('/scripts/power-user.js');
                    power_user.enable_md_hotkeys = false;
                });
                await page.locator('#send_textarea').fill('word');
                await page.keyboard.press('Control+a');

                await page.keyboard.press('Control+b');

                await expect(page.locator('#send_textarea')).toHaveValue('word');
            });
        });

        test.describe('on an Apple platform', () => {
            test.beforeEach(async ({ page }) => {
                await boot(page, { platform: 'MacIntel' });
            });

            sizeFreeTest('Cmd+? opens Keyboard Shortcuts and holds the key back, and Ctrl+? does nothing', async ({ page }) => {
                await page.keyboard.press('Control+?');
                await settle(page);
                await expect(page.locator(OPEN_HOSTS)).toHaveCount(0);
                expect(await lastKeydown(page)).toEqual({ key: '?', prevented: false });

                await page.keyboard.press('Meta+?');

                await expect(page.locator(SHORTCUTS)).toBeVisible();
                expect(await lastKeydown(page)).toEqual({ key: '?', prevented: true });
            });

            sizeFreeTest('lists the Keyboard Shortcuts key as Command and a question mark', async ({ page }) => {
                await page.keyboard.press('F1');
                await expect(page.locator(HELP)).toBeVisible();
                await closeTopDialog(page);
                await page.keyboard.press('Meta+?');
                const row = page.locator(SHORTCUTS).locator('.ds-row', { has: page.getByText('Keyboard Shortcuts', { exact: true }) });

                await expect(row.locator('kbd kbd')).toHaveText(['⌘', '?']);
            });
        });

        test.describe('Learn More in Getting Started', () => {
            test.beforeEach(async ({ page }) => {
                await boot(page);
            });

            const STEPS = [
                { title: 'Connect a Model', topic: 'connect-to-a-model' },
                { title: 'Set Up a Preset', topic: 'choose-a-preset' },
                { title: 'Get a Character Card', topic: 'add-a-character' },
                { title: 'Start Chatting', topic: 'start-a-chat' },
            ];
            const GETTING_STARTED = `${OPEN_HOSTS} .sbGettingStartedDialog`;
            const stepRow = (page, title) => page.locator(`${GETTING_STARTED} .sbHomeStepRow`, { has: page.locator('.ds-row-label', { hasText: title }) });

            async function openGettingStarted(page) {
                await page.evaluate(async () => (await import('/scripts/sillybunny-home/windows.js')).openGettingStarted());
                await expect(stepRow(page, 'Connect a Model')).toBeVisible();
            }

            test('each step keeps Show Me and Skip beside its text and has Learn More under the text, all inside the row', async ({ page }) => {
                await openGettingStarted(page);

                for (const { title } of STEPS) {
                    const row = stepRow(page, title);
                    await expect(row.locator('.ds-row-text button')).toHaveText('Learn More');
                    const beside = await row.locator('.ds-row-suffix button:visible').allTextContents();
                    // Skip goes once a step is done, so it may be absent.
                    expect(beside.filter(text => text !== 'Skip'), title).toEqual(['Show Me']);
                    expect(beside.at(0), title).toBe('Show Me');
                    const fit = await row.evaluate((node) => {
                        const box = node.getBoundingClientRect();
                        return [...node.querySelectorAll('button.sbHomeFlatButton')]
                            .filter(button => button.offsetParent !== null)
                            .every((button) => {
                                const rect = button.getBoundingClientRect();
                                return rect.left >= box.left - 1 && rect.right <= box.right + 1;
                            }) && node.scrollWidth <= node.clientWidth + 1;
                    });
                    expect(fit, title).toBe(true);
                }
            });

            for (const direction of ['ltr', 'rtl']) {
                test(`the text of Learn More starts where the title of its step starts, in ${direction}`, async ({ page }) => {
                    await openGettingStarted(page);
                    await page.evaluate(dir => document.documentElement.setAttribute('dir', dir), direction);

                    for (const { title } of STEPS) {
                        const offset = await stepRow(page, title).evaluate((row, dir) => {
                            const label = row.querySelector('.ds-row-label').getBoundingClientRect();
                            const range = document.createRange();
                            range.selectNodeContents(row.querySelector('.ds-row-text button'));
                            const text = range.getBoundingClientRect();
                            return dir === 'rtl' ? label.right - text.right : text.left - label.left;
                        }, direction);
                        expect(Math.abs(offset), title).toBeLessThanOrEqual(1);
                    }
                });
            }

            test('Learn More on each step closes the window and opens Help at the topic of that step', async ({ page }) => {
                for (const { title, topic } of STEPS) {
                    await openGettingStarted(page);

                    await stepRow(page, title).getByRole('button', { name: 'Learn More' }).click();

                    await expect(page.locator(GETTING_STARTED)).toHaveCount(0);
                    await expect(page.locator(HELP)).toBeVisible();
                    const topicPage = page.locator(`${HELP} .sbHelpPage[data-sb-help-view="topic"]`);
                    await expect(topicPage).toHaveCount(1);
                    await expect(topicPage).toBeVisible();
                    await expect(topicPage).toHaveAttribute('data-sb-help-id', topic);
                    await expect(topicBody(page, topic)).toHaveCount(1);
                    await closeEveryDialog(page);
                }
            });
        });

        test.describe('Help topic pages', () => {
            test.beforeEach(async ({ page }) => {
                await boot(page);
            });

            test('a topic page shows the body of its template, which is still copy that is missing', async ({ page }) => {
                const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/scripts/templates/help/connect-to-a-model.html');
                await openConnectTopic(page);

                await requested;
                const body = topicBody(page, 'connect-to-a-model');
                await expect(body).toHaveCount(1);
                await expect(body).toHaveText('TODO(copy)');
                await expect(body).toHaveAttribute('data-sb-copy-placeholder', 'true');
            });

            test('the text of a topic page comes from the file of its template', async ({ page }) => {
                await page.route('**/scripts/templates/help/connect-to-a-model.html', route => route.fulfill({
                    contentType: 'text/html',
                    body: '<p data-from-template="yes">Text of the template</p><p>A second paragraph</p>',
                }));
                await openConnectTopic(page);

                await expect(page.locator(`${HELP} [data-from-template="yes"]`)).toHaveText('Text of the template');
                await expect(page.locator(HELP).getByText('A second paragraph')).toBeVisible();
                await expect(topicBody(page, 'connect-to-a-model')).toHaveCount(0);
            });

            test('the page appears with its body in place: nothing is swapped in after it, and it waits for a slow template', async ({ page }) => {
                let release;
                const held = new Promise((resolve) => { release = resolve; });
                await page.route('**/scripts/templates/help/connect-to-a-model.html', async (route) => {
                    await held;
                    await route.continue();
                });
                await watchTopicPages(page);
                await openHelpAtSection(page, 'Models and Connections');

                await clickTopic(page, 'Connect to a Model');
                await settle(page);
                await expect(page.locator(TOPIC_PAGE)).toHaveCount(0);
                release();

                await expect(topicBody(page, 'connect-to-a-model')).toHaveText('TODO(copy)');
                await settle(page);
                expect(await page.evaluate(() => window.__topicPageEvents)).toEqual([{ event: 'page', id: 'connect-to-a-model', slot: true }]);
            });

            test('a template that does not load leaves the placeholder of the topic, and the failure is logged', async ({ page }) => {
                const errors = [];
                page.on('console', (message) => {
                    if (message.type() === 'error') errors.push(message.text());
                });
                await page.route('**/scripts/templates/help/connect-to-a-model.html', route => route.abort());
                await watchTopicPages(page);

                await openConnectTopic(page);

                const body = topicBody(page, 'connect-to-a-model');
                await expect(body).toHaveText('TODO(copy)');
                await expect(body).toHaveAttribute('data-sb-copy-placeholder', 'true');
                await settle(page);
                expect(errors.some(text => text.includes('"connect-to-a-model"') && text.includes('help/connect-to-a-model'))).toBe(true);
                expect(await page.evaluate(() => window.__topicPageEvents)).toEqual([{ event: 'page', id: 'connect-to-a-model', slot: true }]);
            });

            test('two quick clicks on two topics show the body of the second, even when the first template answers last', async ({ page }) => {
                let releaseFirst;
                const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
                await page.route('**/scripts/templates/help/choose-a-preset.html', async (route) => {
                    await firstHeld;
                    await route.fulfill({ contentType: 'text/html', body: '<p data-from-template="first">Body of the first</p>' });
                });
                await page.route('**/scripts/templates/help/fix-a-connection-problem.html', route => route.fulfill({
                    contentType: 'text/html',
                    body: '<p data-from-template="second">Body of the second</p>',
                }));
                await openConnectTopic(page);
                await expect(topicBody(page, 'connect-to-a-model')).toHaveCount(1);

                await clickTopic(page, 'Choose a Preset');
                await clickTopic(page, 'Fix a Connection Problem');
                await expect(page.locator(`${HELP} [data-from-template="second"]`)).toHaveText('Body of the second');
                releaseFirst();
                await settle(page);

                await expect(page.locator(`${HELP} [data-from-template="first"]`)).toHaveCount(0);
                await expect(page.locator(`${HELP} [data-from-template="second"]`)).toHaveCount(1);
                await expect(page.locator(`${HELP} ${TOPIC_PAGE}`)).toHaveCount(1);
                await expect(page.locator(`${HELP} ${TOPIC_PAGE}`)).toHaveAttribute('data-sb-help-id', 'fix-a-connection-problem');
            });

            sizeFreeTest('every topic of the model has a template file that the server serves', async ({ page }) => {
                const results = await page.evaluate(async () => {
                    const { getHelpSections } = await import('/scripts/sillybunny-help/topics.js');
                    const topics = getHelpSections().flatMap(section => section.topics);
                    return Promise.all(topics.map(async (topic) => {
                        const response = await fetch(`/scripts/templates/${topic.template}.html`);
                        return { id: topic.id, status: response.status, text: await response.text() };
                    }));
                });

                expect(results).toHaveLength(12);
                for (const { id, status, text } of results) {
                    expect(status, id).toBe(200);
                    expect(text, id).toContain(`data-sb-copy-slot="HELP-TOPIC-${id}"`);
                }
            });
        });
    });
}
