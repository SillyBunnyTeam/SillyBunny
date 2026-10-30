import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { visiblePageClose } from './helpers/dialog-pages.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { fetchBodyOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const COPY_PLACEHOLDER = 'TODO(copy)';
const WEBSITE_URL = 'https://github.com/SillyBunnyTeam/SillyBunny';
const ISSUES_URL = 'https://github.com/SillyBunnyTeam/SillyBunny/issues';

const VIEWPORTS = [
    { name: 'desktop 1440x900', sheet: false, options: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone 390x844', sheet: true, options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

const WINDOWS = [
    { menuItem: 'Show Welcome', title: 'Welcome', tier: 'dialog' },
    { menuItem: 'Keyboard Shortcuts', title: 'Keyboard Shortcuts', tier: 'dialog' },
    { menuItem: 'Help', title: 'Help', tier: 'window' },
    { menuItem: 'About SillyBunny', title: 'About SillyBunny', tier: 'dialog' },
];

const SECTION_TITLES = [
    'Getting Around', 'Models and Connections', 'Presets and Prompts', 'Characters and Personas', 'World Info', 'Chatting',
    'Modes', 'Agents', 'Extensions and Themes', 'Search', 'Data and Importing', 'Troubleshooting',
];
const STEP_TITLES = ['Connect a Model', 'Set Up a Preset', 'Get a Character Card', 'Start Chatting'];
const CREDIT_GROUPS = ['Developers', 'Designers', 'Artists', 'Documenters', 'Translators', 'Acknowledgements'];
const LEGAL_GROUPS = ['Fan Work', 'Art Licence', 'Nahida', 'Third-Party Software'];

const menuButton = page => page.locator('#chat > .welcomePanel .sbHomeMenuButton');
const helpTile = page => page.locator('#chat > .welcomePanel .sbHomeTile[data-sb-home-key="help"]');
const hosts = page => page.locator('dialog.sb-dialog-host:not([closing])');
const surface = host => host.locator('section.sb-dialog');
// A push marks the covered page and a pop marks the leaving page at once, so exactly one page is left while pages slide.
const shownPage = host => host.locator('.sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving)');

async function expectHome(page) {
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
}

async function openFromMenu(page, menuItem) {
    await menuButton(page).click();
    await page.getByRole('menuitem', { name: menuItem, exact: true }).click();
    const host = hosts(page);
    await expect(host).toBeVisible();
    return host;
}

async function expectClosed(page) {
    await expect(page.locator('dialog.sb-dialog-host')).toHaveCount(0);
}

async function readCopyPlaceholders(scope) {
    return scope.locator('[data-sb-copy-placeholder="true"]').evaluateAll(nodes => nodes.map(node => ({
        slot: node.dataset.sbCopySlot,
        text: node.textContent.trim(),
    })));
}

async function expectSlots(scope, slots) {
    const found = await readCopyPlaceholders(scope);
    expect(found.map(entry => entry.slot)).toEqual(expect.arrayContaining(slots));
    expect(found.filter(entry => entry.text !== COPY_PLACEHOLDER)).toEqual([]);
}

/** Copy that is missing must say so in the one agreed way, on an element that carries both attributes. */
async function expectNoUnmarkedPlaceholder(host) {
    const unmarked = await host.evaluate((root, placeholder) => Array.from(root.querySelectorAll('*'))
        .filter(node => Array.from(node.childNodes).some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim() === placeholder))
        .filter(node => node.dataset.sbCopyPlaceholder !== 'true' || !node.dataset.sbCopySlot)
        .map(node => node.outerHTML.slice(0, 120)), COPY_PLACEHOLDER);
    expect(unmarked).toEqual([]);
}

async function expectArt(scope, id, size) {
    const art = scope.locator(`[data-sb-art-placeholder="${id}"]`);
    await expect(art).toBeVisible();
    await expect(art).toHaveAttribute('aria-hidden', 'true');
    await expect(art).toHaveText(id);
    // The layout size ignores the scale of an opening window.
    expect(await art.evaluate(node => [node.offsetWidth, node.offsetHeight])).toEqual(size);
}

async function readVersion(page) {
    return page.evaluate(() => fetch('/version').then(response => response.json()));
}

const aboutRow = (host, field) => host.locator(`[data-sb-editor-field="${field}"]`);

/** The test data turns the reduced-motion setting on, which would skip every spring. */
async function useMotion(page) {
    await page.route('**/api/settings/get', async route => {
        const fetched = await fetchBodyOrSkip(route, response => response.json());
        if (!fetched) return;
        const { response, body: data } = fetched;
        const settings = JSON.parse(data.settings);
        settings.power_user.reduced_motion = false;
        return route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
}

const runningAnimations = host => surface(host).evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length);

/** Waits on the surface's own animations: they start, then end. */
async function expectSurfaceAnimates(host) {
    await expect.poll(() => runningAnimations(host)).toBeGreaterThan(0);
    await expect.poll(() => runningAnimations(host)).toBe(0);
}

for (const { name, sheet, options } of VIEWPORTS) {
    // A phone shows the topic as a pushed page, and a desktop beside the sections.
    const topicViewOf = host => (sheet ? shownPage(host) : host.locator('.sb-list-editor__detail'));

    test.describe(`Home windows at ${name}`, () => {
        test.use(options);

        test.beforeEach(async ({ page }) => {
            await protectMaintainerServer(page);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await expectHome(page);
        });

        for (const { menuItem, title, tier } of WINDOWS) {
            test(`${menuItem} opens from the main menu as a ${tier}${sheet ? ' sheet' : ''}`, async ({ page }) => {
                const host = await openFromMenu(page, menuItem);

                await expect(surface(host)).toHaveClass(new RegExp(`\\bsb-dialog--${tier}\\b`));
                await expect(host).toHaveAttribute('data-presentation', sheet ? 'sheet' : 'floating');
                await expect(host).toHaveAccessibleName(title);
            });

            test(`${menuItem} closes with Escape and gives focus back to the main menu button`, async ({ page }) => {
                await openFromMenu(page, menuItem);

                await page.keyboard.press('Escape');

                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });
        }

        for (const { menuItem } of WINDOWS.filter(entry => entry.menuItem !== 'Show Welcome')) {
            test(`${menuItem} closes with its Close button and gives focus back to the main menu button`, async ({ page }) => {
                const host = await openFromMenu(page, menuItem);

                await (await visiblePageClose(host)).click();

                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });
        }

        test.describe('Welcome', () => {
            test('page one greets with the duo art, copy placeholders, and the adopted language select', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');

                await expectArt(host, 'welcome-both', [192, 128]);
                await expectSlots(host, ['WD-1-GREETING', 'WD-1-ABOUT', 'WD-1-FORK', 'WD-1-FANWORK']);
                await expectNoUnmarkedPlaceholder(host);
                await expect(shownPage(host).getByText('Step 1 of 3')).toBeAttached();
                await expect(host.locator('.sbWelcomeDots')).toHaveAttribute('aria-hidden', 'true');
                await expect(host.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
                await expect(host.getByRole('button', { name: 'Import From SillyTavern' })).toBeVisible();

                const adopted = await page.evaluate(() => {
                    const select = document.getElementById('onboarding_ui_language_select');
                    return { count: document.querySelectorAll('#onboarding_ui_language_select').length, inDialog: Boolean(select?.closest('dialog.sb-dialog-host')) };
                });
                expect(adopted).toEqual({ count: 1, inDialog: true });
            });

            test('Close on page one closes the dialog and gives focus back to the main menu button', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');

                await shownPage(host).getByRole('button', { name: 'Close', exact: true }).click();

                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });

            test('shows no Language row, and says why in the console, when the first-run select is gone', async ({ page }) => {
                const debugLines = [];
                page.on('console', message => message.type() === 'debug' && debugLines.push(message.text()));
                await page.evaluate(() => document.getElementById('onboarding_ui_language_select').remove());

                const host = await openFromMenu(page, 'Show Welcome');

                await expect(host.getByRole('button', { name: 'Import From SillyTavern' })).toBeVisible();
                await expect(host.getByText('Language', { exact: true })).toHaveCount(0);
                expect(debugLines.some(line => line.includes('onboarding_ui_language_select'))).toBe(true);
            });

            test('the current position dot is told apart by an outline in forced colours', async ({ page }) => {
                await page.emulateMedia({ forcedColors: 'active' });
                const host = await openFromMenu(page, 'Show Welcome');

                const dots = await host.locator('.sbWelcomeDots > i').evaluateAll(nodes => nodes.map(node => ({
                    current: node.classList.contains('is-current'),
                    outline: getComputedStyle(node).outlineStyle,
                })));

                expect(dots).toEqual([
                    { current: true, outline: 'solid' },
                    { current: false, outline: 'none' },
                    { current: false, outline: 'none' },
                ]);
            });

            test('gives the language select back to its template when the dialog closes', async ({ page }) => {
                await openFromMenu(page, 'Show Welcome');
                await page.keyboard.press('Escape');
                await expectClosed(page);

                const home = await page.evaluate(() => {
                    const select = document.getElementById('onboarding_ui_language_select');
                    return { count: document.querySelectorAll('#onboarding_ui_language_select').length, inTemplate: Boolean(select?.closest('#onboarding_template')) };
                });
                expect(home).toEqual({ count: 1, inTemplate: true });
            });

            test('Next and Back walk the three pages and the position text follows', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                const current = shownPage(host);

                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('Your Persona');
                await expect(current.getByText('Step 2 of 3')).toBeAttached();
                await expect(current.getByRole('textbox', { name: 'Your Name' })).toBeVisible();
                await expectSlots(current, ['WD-2-PROMPT']);

                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('What’s Next');
                await expect(current.getByText('Step 3 of 3')).toBeAttached();
                await expect(current.getByRole('button', { name: 'Start', exact: true })).toBeVisible();

                await current.getByRole('button', { name: 'Back', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('Your Persona');
                await expect(current.getByText('Step 2 of 3')).toBeAttached();
                await expect(host.getByText('Step 3 of 3')).toHaveCount(0);
                await current.getByRole('button', { name: 'Back', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('Welcome');
                await expect(current.getByText('Step 1 of 3')).toBeAttached();
                await expect(host.getByText('Step 2 of 3')).toHaveCount(0);
            });

            test('page three lists the four steps, keeps Show at Startup unchecked, and Start closes', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                const current = shownPage(host);

                await expectSlots(current, ['WD-3-INTRO', 'WD-3-STEP-1', 'WD-3-STEP-2', 'WD-3-STEP-3', 'WD-3-STEP-4']);
                await expectNoUnmarkedPlaceholder(current);
                for (const stepTitle of STEP_TITLES) {
                    await expect(current.locator('.ds-row', { hasText: stepTitle }).getByRole('button', { name: 'Show Me', exact: true })).toBeVisible();
                }
                await expect(current.getByRole('switch', { name: 'Show at Startup' })).not.toBeChecked();
                for (const stepTitle of STEP_TITLES) {
                    await expect(current.locator('.ds-row', { hasText: stepTitle }).getByRole('button', { name: 'Show Me', exact: true })).toHaveAccessibleDescription(stepTitle);
                }

                await current.getByRole('button', { name: 'Start', exact: true }).click();

                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });

            test('Show Me closes the dialog and opens the same place as Getting Started', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();

                await shownPage(host).locator('.ds-row', { hasText: 'Connect a Model' }).getByRole('button', { name: 'Show Me', exact: true }).click();

                await expectClosed(page);
                await expect(page.getByRole('tab', { name: 'Connections', selected: true })).toBeVisible();
            });

            test('Import From SillyTavern pushes a skeleton page whose buttons send nothing', async ({ page }) => {
                const imports = [];
                page.on('request', request => {
                    if (/import|restore|backup/i.test(new URL(request.url()).pathname) && request.method() !== 'GET') {
                        imports.push(request.url());
                    }
                });
                const host = await openFromMenu(page, 'Show Welcome');
                const current = shownPage(host);

                await host.getByRole('button', { name: 'Import From SillyTavern' }).click();

                await expect(current.locator('.sb-dialog__title')).toHaveText('Import From SillyTavern');
                await expectSlots(current, ['WD-IMPORT-EXPLANATION']);
                await expectNoUnmarkedPlaceholder(current);
                await expect(current.getByRole('textbox', { name: 'Folder Path' })).toBeVisible();
                const importFolder = current.getByRole('button', { name: 'Import Folder', exact: true });
                const importZip = current.getByRole('button', { name: 'Import Backup ZIP', exact: true });
                await expect(importFolder).toHaveAttribute('data-sb-stub', 'true');
                await expect(importZip).toHaveAttribute('data-sb-stub', 'true');
                await importFolder.click();
                await importZip.click();
                expect(imports).toEqual([]);

                await current.getByRole('button', { name: 'Back', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('Welcome');
            });

            test('Escape pops the Import page first, then closes the dialog', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                await host.getByRole('button', { name: 'Import From SillyTavern' }).click();
                await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Import From SillyTavern');

                await page.keyboard.press('Escape');
                await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Welcome');
                await expect(hosts(page)).toHaveCount(1);

                await page.keyboard.press('Escape');
                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });

            test('Escape on the Persona and What’s Next pages goes back one page each', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                const title = shownPage(host).locator('.sb-dialog__title');
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await expect(title).toHaveText('What’s Next');

                await page.keyboard.press('Escape');
                await expect(title).toHaveText('Your Persona');
                await expect(hosts(page)).toHaveCount(1);

                await page.keyboard.press('Escape');
                await expect(title).toHaveText('Welcome');
                await expect(hosts(page)).toHaveCount(1);
            });
        });

        test.describe('Keyboard Shortcuts', () => {
            test('lists General, Editors and Lists, Chat and Formatting, and leaves out the shortcuts that have no handler yet', async ({ page }) => {
                const host = await openFromMenu(page, 'Keyboard Shortcuts');

                for (const group of ['General', 'Editors and Lists', 'Chat', 'Formatting']) {
                    await expect(host.getByRole('group', { name: group })).toBeVisible();
                }
                const general = host.getByRole('group', { name: 'General' });
                await expect(general.locator('.ds-row')).toHaveCount(6);
                await expect(general.locator('.ds-row', { hasText: 'Home' }).locator('kbd kbd')).toHaveText(['Ctrl', 'O']);
                await expect(host.locator('.ds-row', { hasText: 'Keyboard Shortcuts' })).toHaveCount(0);
                await expect(host.locator('.ds-row', { has: page.locator('kbd', { hasText: 'F1' }) })).toHaveCount(0);
                await expect(host.getByRole('group', { name: 'Chat' }).locator('.ds-row')).toHaveCount(10);
                await expect(host.getByRole('group', { name: 'Formatting' }).locator('.ds-row')).toHaveCount(5);
            });

            test('lists the save and find shortcuts of the editors and lists', async ({ page }) => {
                const host = await openFromMenu(page, 'Keyboard Shortcuts');
                const editors = host.getByRole('group', { name: 'Editors and Lists' });

                await expect(editors.locator('.ds-row')).toHaveCount(2);
                await expect(editors.locator('.ds-row', { hasText: 'Save' }).locator('kbd kbd')).toHaveText(['Ctrl', 'S']);
                await expect(editors.locator('.ds-row', { hasText: 'Find in List' }).locator('kbd kbd')).toHaveText(['Ctrl', 'F']);
            });
        });

        test.describe('Help', () => {
            test('lists the twelve sections with the Reisen art and the intro placeholder', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                const sidebar = host.locator('.sb-list-editor__sidebar');

                await expectArt(sidebar, 'help-reisen', [96, 96]);
                await expectSlots(sidebar, ['HELP-INTRO']);
                await expect(sidebar.getByRole('heading', { level: 3 })).toHaveText(SECTION_TITLES);
                await expectNoUnmarkedPlaceholder(host);
            });

            test('shows a topic with a See Also list and follows a See Also link', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                const sidebar = host.locator('.sb-list-editor__sidebar');
                const topicPage = topicViewOf(host);

                await sidebar.getByRole('button', { name: 'Connect to a Model' }).click();

                await expect(topicPage.getByRole('heading', { name: 'Connect to a Model' })).toBeVisible();
                await expectSlots(topicPage, ['HELP-TOPIC-connect-to-a-model']);
                const seeAlso = topicPage.getByRole('group', { name: 'See Also' });
                await expect(seeAlso.getByRole('button')).toHaveText(['Choose a Preset', 'Fix a Connection Problem']);

                await seeAlso.getByRole('button', { name: 'Choose a Preset' }).click();

                await expect(topicPage.getByRole('heading', { name: 'Choose a Preset' })).toBeVisible();
                await expectSlots(topicPage, ['HELP-TOPIC-choose-a-preset']);
            });

            if (sheet) {
                test('a topic opens as a pushed page and Back returns to the sections', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    const current = shownPage(host);
                    await expect(host.locator('.sb-list-editor__detail')).toBeHidden();

                    await host.locator('.sb-list-editor__sidebar').getByRole('button', { name: 'Fix a Connection Problem' }).click();
                    await expect(current.locator('.sb-dialog__title')).toHaveText('Fix a Connection Problem');

                    await current.getByRole('button', { name: 'Back', exact: true }).click();
                    await expect(current.locator('.sb-dialog__title')).toHaveText('Help');
                    await expect(host.locator('.sb-list-editor__sidebar').getByRole('button', { name: 'Fix a Connection Problem' })).toBeFocused();
                });
            } else {
                test('keeps the open topic while the window narrows to a page and widens again', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await host.locator('.sb-list-editor__sidebar').getByRole('button', { name: 'Connect to a Model' }).click();
                    const detail = host.locator('.sb-list-editor__detail');
                    await expect(detail.getByRole('heading', { name: 'Connect to a Model' })).toBeVisible();

                    await page.setViewportSize({ width: 390, height: 844 });
                    await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Connect to a Model');
                    await expect(host.locator('.sb-list-editor')).toHaveAttribute('data-open', 'false');

                    await page.setViewportSize({ width: 1440, height: 900 });
                    await expect(detail.getByRole('heading', { name: 'Connect to a Model' })).toBeVisible();
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
                    await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Help');
                });

                test('shows the first topic beside the sections at once', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');

                    await expect(host.locator('.sb-list-editor')).toHaveAttribute('data-collapsed', 'false');
                    await expect(host.locator('.sb-list-editor__detail').getByRole('heading', { name: 'Find Your Way Around' })).toBeVisible();
                    await expect(host.locator('.sb-list-editor__sidebar').getByRole('button', { name: 'Find Your Way Around' })).toHaveAttribute('aria-current', 'true');
                });
            }

            test('search filters topics by title and by section, and a status page answers no match', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                const sidebar = host.locator('.sb-list-editor__sidebar');
                const topics = sidebar.locator('[data-sb-help-topic]');
                await expect(topics).toHaveCount(12);

                await host.getByRole('button', { name: 'Search', exact: true }).click();
                const field = host.getByRole('searchbox');
                const intro = sidebar.locator('.sbHelpIntro');
                await expect(intro).toBeVisible();

                await field.fill('preset');
                await expect(topics).toHaveText(['Choose a Preset']);
                await expect(intro).toHaveCount(0);
                await expect(sidebar.locator('[data-sb-art-placeholder]')).toHaveCount(0);

                await field.fill('troubleshooting');
                await expect(topics).toHaveText(['Fix a Connection Problem']);

                await field.fill('zzzz');
                await expect(topics).toHaveCount(0);
                const status = host.locator('.sb-status-page');
                await expect(status).toBeVisible();
                await expectSlots(status, ['HELP-SEARCH-EMPTY-HEAD', 'HELP-SEARCH-EMPTY-BODY']);

                await field.fill('');
                await expect(topics).toHaveCount(12);
                await expect(status).toBeHidden();
                await expectArt(sidebar, 'help-reisen', [96, 96]);
                await expectSlots(sidebar, ['HELP-INTRO']);
            });

            test('the no-match page is not a second live announcement', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await host.getByRole('button', { name: 'Search', exact: true }).click();

                await host.getByRole('searchbox').fill('zzzz');

                const status = host.locator('.sb-status-page');
                await expect(status).toBeVisible();
                await expect(status).not.toHaveAttribute('role', /.+/);
            });

            test('Escape closes an open search first, then the window', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                const topics = host.locator('.sb-list-editor__sidebar [data-sb-help-topic]');
                await host.getByRole('button', { name: 'Search', exact: true }).click();
                await host.getByRole('searchbox').fill('preset');
                await expect(topics).toHaveCount(1);

                await page.keyboard.press('Escape');

                await expect(host.getByRole('searchbox')).toBeHidden();
                await expect(topics).toHaveCount(12);
                await expect(hosts(page)).toHaveCount(1);

                await page.keyboard.press('Escape');

                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });

            test('activating the Help tile twice opens one window, and it opens again after it closes', async ({ page }) => {
                await helpTile(page).evaluate((row) => {
                    row.click();
                    row.click();
                });

                const host = hosts(page);
                await expect(host).toBeVisible();
                await expect(host).toHaveCount(1);
                await expect(host.locator('.sb-dialog__page')).toHaveCount(1);

                await page.keyboard.press('Escape');
                await expectClosed(page);
                await helpTile(page).click();
                await expect(hosts(page)).toHaveCount(1);
            });

            test('a window that fails to load logs the error, toasts, and can be opened again', async ({ page }) => {
                const errors = [];
                page.on('console', message => message.type() === 'error' && errors.push(message.text()));
                await showToasts(page);
                await page.route('**/scripts/sillybunny-about.js*', route => route.abort());

                await menuButton(page).click();
                await page.getByRole('menuitem', { name: 'About SillyBunny', exact: true }).click();

                const toast = page.locator('#toast-container .toast', { hasText: COPY_PLACEHOLDER });
                await expect(toast).toBeVisible();
                await expect(hosts(page)).toHaveCount(0);
                expect(errors.some(line => line.includes('Could not open the About window'))).toBe(true);

                await page.unroute('**/scripts/sillybunny-about.js*');
                const host = await openFromMenu(page, 'About SillyBunny');
                await expect(host).toHaveAccessibleName('About SillyBunny');
            });

            test('the Help tile on Home opens Help, is no longer a stub, and gives focus back to the tile', async ({ page }) => {
                await expect(helpTile(page)).not.toHaveAttribute('data-sb-stub', /.*/);

                await helpTile(page).click();

                const host = hosts(page);
                await expect(surface(host)).toHaveClass(/\bsb-dialog--window\b/);
                await expect(host).toHaveAccessibleName('Help');
                await (await visiblePageClose(host)).click();
                await expectClosed(page);
                await expect(helpTile(page)).toBeFocused();
            });
        });

        test.describe('About SillyBunny', () => {
            test('shows the logo, the name, the developer placeholder and the real version, branch and commit', async ({ page }) => {
                const version = await readVersion(page);
                const host = await openFromMenu(page, 'About SillyBunny');

                await expectArt(host, 'logo-64', [64, 64]);
                await expect(host.locator('[data-sb-art-placeholder]')).toHaveCount(1);
                await expect(host.getByRole('heading', { name: 'SillyBunny', exact: true })).toBeVisible();
                await expectSlots(host, ['AB-DEVELOPER']);
                await expectNoUnmarkedPlaceholder(host);
                await expect(host.getByText(version.pkgVersion, { exact: false }).first()).toBeVisible();
                await expect(host.getByText(version.gitBranch, { exact: true })).toBeVisible();
                await expect(host.getByText(version.gitRevision, { exact: true })).toBeVisible();
            });

            test('opens at once, shows a stand-in for the branch and commit, and fills them when the server answers', async ({ page }) => {
                const version = await readVersion(page);
                let answer;
                const answered = new Promise((resolve) => {
                    answer = resolve;
                });
                await page.route('**/version', async (route) => {
                    await answered;
                    await route.continue();
                });

                try {
                    const host = await openFromMenu(page, 'About SillyBunny');

                    await expect(aboutRow(host, 'about-version')).toContainText(version.pkgVersion);
                    await expect(aboutRow(host, 'about-branch')).toContainText('…');
                    await expect(aboutRow(host, 'about-commit')).toContainText('…');
                    await expect(host.getByRole('button', { name: 'Troubleshooting', exact: true })).toBeVisible();
                } finally {
                    answer();
                }

                const answeredHost = hosts(page);
                await expect(aboutRow(answeredHost, 'about-branch')).toContainText(version.gitBranch);
                await expect(aboutRow(answeredHost, 'about-commit')).toContainText(version.gitRevision);
                await expect(aboutRow(answeredHost, 'about-branch')).not.toContainText('…');
            });

            test('shows Unknown for the branch and commit when the server does not answer', async ({ page }) => {
                await page.route('**/version', route => route.abort());

                const host = await openFromMenu(page, 'About SillyBunny');

                await expect(aboutRow(host, 'about-branch')).toContainText('Unknown');
                await expect(aboutRow(host, 'about-commit')).toContainText('Unknown');
            });

            test('Website and Report an Issue are links that open a new tab safely', async ({ page }) => {
                const host = await openFromMenu(page, 'About SillyBunny');

                for (const [name, href] of [['Website', WEBSITE_URL], ['Report an Issue', ISSUES_URL]]) {
                    const link = host.getByRole('link', { name, exact: true });
                    await expect(link).toHaveAttribute('href', href);
                    await expect(link).toHaveAttribute('target', '_blank');
                    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
                }
            });

            test('What’s New pushes a page with the release notes placeholder', async ({ page }) => {
                const host = await openFromMenu(page, 'About SillyBunny');
                const current = shownPage(host);

                await host.getByRole('button', { name: 'What’s New', exact: true }).click();

                await expect(current.locator('.sb-dialog__title')).toHaveText('What’s New');
                await expectSlots(current, ['AB-RELEASE-NOTES']);
                await current.getByRole('button', { name: 'Back', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('About SillyBunny');
                await expect(host.getByRole('button', { name: 'What’s New', exact: true })).toBeFocused();
            });

            test('Credits and Legal push pages of labelled groups with placeholder bodies', async ({ page }) => {
                const host = await openFromMenu(page, 'About SillyBunny');
                const current = shownPage(host);

                await host.getByRole('button', { name: 'Credits', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('Credits');
                await expect(current.getByRole('heading', { level: 3 })).toHaveText(CREDIT_GROUPS);
                await expectSlots(current, CREDIT_GROUPS.map(group => `AB-CREDITS-${group.toUpperCase()}`));
                await expectNoUnmarkedPlaceholder(current);
                await current.getByRole('button', { name: 'Back', exact: true }).click();

                await host.getByRole('button', { name: 'Legal', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('Legal');
                await expect(current.getByRole('heading', { level: 3 })).toHaveText(LEGAL_GROUPS);
                await expectSlots(current, ['AB-FANWORK', 'AB-ART-LICENCE', 'AB-NAHIDA', 'AB-THIRD-PARTY']);
                await expectNoUnmarkedPlaceholder(current);
            });

            test('Troubleshooting shows real debug info that Copy puts on the clipboard and Save downloads', async ({ page, context }) => {
                await context.grantPermissions(['clipboard-read', 'clipboard-write']);
                const version = await readVersion(page);
                const host = await openFromMenu(page, 'About SillyBunny');
                const current = shownPage(host);

                await host.getByRole('button', { name: 'Troubleshooting', exact: true }).click();

                await expect(current.locator('.sb-dialog__title')).toHaveText('Troubleshooting');
                const info = current.getByRole('textbox', { name: 'Debug Information' });
                await expect(info).toBeVisible();
                await expect(info).toHaveCSS('font-family', /mono|Mono|monospace/i);
                const text = await info.inputValue();
                const userAgent = await page.evaluate(() => navigator.userAgent);
                const viewport = await page.evaluate(() => `${window.innerWidth}×${window.innerHeight}`);
                expect(text).toContain(version.pkgVersion);
                expect(text).toContain(version.gitBranch);
                expect(text).toContain(version.gitRevision);
                expect(text).toContain(userAgent);
                expect(text).toContain(viewport);
                expect(text).toMatch(/Enabled extensions: \d+/);

                await current.getByRole('button', { name: 'Copy', exact: true }).click();
                await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
                await expect(current.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
                await expect(current.locator('.sr-only[aria-live="polite"]')).toHaveText('Copied');
                await expect(current.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
                await expect(current.locator('.sr-only[aria-live="polite"]')).toHaveText('');

                const download = page.waitForEvent('download');
                await current.getByRole('button', { name: 'Save', exact: true }).click();
                const saved = await download;
                expect(saved.suggestedFilename()).toMatch(/\.txt$/);
                const path = await saved.path();
                const { readFile } = await import('node:fs/promises');
                expect(await readFile(path, 'utf8')).toBe(text);
            });
        });

        test('every window leaves no unmarked copy placeholder behind', async ({ page }) => {
            for (const { menuItem } of WINDOWS) {
                const host = await openFromMenu(page, menuItem);
                await expect(host).toBeVisible();
                await expectNoUnmarkedPlaceholder(host);
                await page.keyboard.press('Escape');
                await expectClosed(page);
            }
        });
    });
}

test.describe('Home windows with motion on a phone', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        contextOptions: { reducedMotion: 'no-preference' },
    });

    test.beforeEach(async ({ page }) => {
        await protectMaintainerServer(page);
        await useMotion(page);
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await expectHome(page);
    });

    test('motion is really on', async ({ page }) => {
        const motion = await page.evaluate(() => ({
            mediaReduces: matchMedia('(prefers-reduced-motion: reduce)').matches,
            bodyReduces: document.body.classList.contains('reduced-motion'),
        }));

        expect(motion).toEqual({ mediaReduces: false, bodyReduces: false });
    });

    test('Welcome slides one page in and back out', async ({ page }) => {
        const host = await openFromMenu(page, 'Show Welcome');
        const title = shownPage(host).locator('.sb-dialog__title');
        await expect.poll(() => runningAnimations(host)).toBe(0);

        await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
        await expectSurfaceAnimates(host);
        await expect(title).toHaveText('Your Persona');
        await expect(host.locator('.sb-dialog__page.is-leaving')).toHaveCount(0);

        await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();
        await expectSurfaceAnimates(host);
        await expect(title).toHaveText('Welcome');
        await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
    });

    test('a Help topic slides in as a page and Back returns focus to its button', async ({ page }) => {
        const host = await openFromMenu(page, 'Help');
        const title = shownPage(host).locator('.sb-dialog__title');
        const topic = host.locator('.sb-list-editor__sidebar').getByRole('button', { name: 'Fix a Connection Problem' });
        await expect.poll(() => runningAnimations(host)).toBe(0);

        await topic.click();
        await expectSurfaceAnimates(host);
        await expect(title).toHaveText('Fix a Connection Problem');

        await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();
        await expectSurfaceAnimates(host);
        await expect(title).toHaveText('Help');
        await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
        await expect(topic).toBeFocused();
    });
});

test.describe('Welcome on a landscape phone', () => {
    test.use({ viewport: { width: 740, height: 340 }, isMobile: true, hasTouch: true });

    test('is a bottom sheet whose last row and Next stay reachable', async ({ page }) => {
        await protectMaintainerServer(page);
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await expectHome(page);

        const host = await openFromMenu(page, 'Show Welcome');

        await expect(host).toHaveAttribute('data-presentation', 'sheet');
        const body = shownPage(host).locator('.sb-dialog__body');
        await body.evaluate(node => node.scrollTo(0, node.scrollHeight));
        const lastRow = host.getByRole('button', { name: 'Import From SillyTavern' });
        await expect(lastRow).toBeInViewport();
        await expect(shownPage(host).getByRole('button', { name: 'Next', exact: true })).toBeInViewport();
    });
});
