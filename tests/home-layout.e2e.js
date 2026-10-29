import { expect, test } from '@playwright/test';
import { dismissOpenDialogIfPresent, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { testSetup } from './frontend/frontent-test-utils.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const TWO_COLUMN_MIN_WIDTH = 1024;
const MODE_KEY = 'WelcomePage_PanelMode';

const TOUCH = { isMobile: true, hasTouch: true };
const HOME_SHELL_WIDTH = 1120;
const VIEWPORTS = [
    { name: 'desktop 1920x1080', columns: 2, wide: true, options: { viewport: { width: 1920, height: 1080 } } },
    { name: 'desktop 1440x900', columns: 2, wide: true, options: { viewport: { width: 1440, height: 900 } } },
    { name: 'laptop 1024x600', columns: 1, wide: false, options: { viewport: { width: 1024, height: 600 } } },
    { name: 'tablet 768x1024', columns: 1, wide: false, options: { viewport: { width: 768, height: 1024 }, ...TOUCH } },
    { name: 'phone 390x844', columns: 1, wide: false, options: { viewport: { width: 390, height: 844 }, ...TOUCH } },
];
const WIDE_VIEWPORTS = VIEWPORTS.filter(viewport => viewport.wide);

const REGION_VISIBILITY = {
    full: { hero: true, 'bar-logo': false, 'getting-started': true, assistants: true, links: true, 'recent-chats': true },
    compact: { hero: false, 'bar-logo': true, 'getting-started': false, assistants: true, links: true, 'recent-chats': true },
    list: { hero: false, 'bar-logo': true, 'getting-started': false, assistants: false, links: false, 'recent-chats': true },
};
const MODE_LABELS = { full: 'Full', compact: 'Compact', list: 'List Only' };
const BODY_ART_SIZES = { 'hero-duo': [320, 160], 'empty-tewi': [96, 96] };
const LOGO_SIZE = [32, 32];
const ART_VISIBILITY = {
    full: { 'hero-duo': true, 'logo-32': false },
    compact: { 'hero-duo': false, 'logo-32': true },
    list: { 'hero-duo': false, 'logo-32': true },
};
const REGION_DOM_ORDER = ['getting-started', 'assistants', 'recent-chats', 'links'];
const REGION_NAMES = { 'getting-started': 'Getting Started', assistants: 'Assistants', 'recent-chats': 'Recent Chats', links: 'Help and Extras' };
const SECTION_ART_SIZES = { 'gs-reisen': [96, 96], 'row-reisen': [64, 64], 'row-tewi': [64, 64] };
const STEP_TITLES = ['Connect a Model', 'Set Up a Preset', 'Get a Character Card', 'Start Chatting'];
const ASSISTANT_NAMES = ['Reisen', 'Tewi', 'Nahida'];
const EXTRAS_GROUPS = ['First-Party Extensions', 'Third-Party Extensions', 'Themes', 'Presets'];
const EXTRAS_ITEMS = [
    'Alternate Descriptions', 'Bot Searcher', 'CSS Snippets', 'Deep Swipe', 'Macro Enhanced', 'Prompt Tags', 'Prompting Lab',
    'Regex Agent Themes', 'Time Machine', 'World Info Lab',
    'Dialogue Colors', 'Summary Sharder', 'Group Utilities', 'LALib',
    'Moonlit Echoes', 'Terminal UI',
    'Geechan - Universal Roleplay (v5.2)', 'TLD Card Conversion Preset',
];
const NAVIGATION_SPRING_MS = 334;

const menuButton = page => page.locator('#chat > .welcomePanel .sbHomeMenuButton');
const gettingStarted = page => page.locator('#chat > .welcomePanel [data-sb-home-region="getting-started"] details.ds-row-expander');
const gettingStartedSummary = page => gettingStarted(page).locator('> summary');
const stepRows = page => page.locator('#chat > .welcomePanel .sbHomeStepRow');
const bundledExtrasRow = page => page.locator('#chat > .welcomePanel [data-sb-editor-field="links-bundled-extras"]');
const extrasPage = page => page.locator('#chat > .welcomePanel .sbHomePage');
const backButton = page => extrasPage(page).getByRole('button', { name: 'Back', exact: true });
const homeLayout = page => page.locator('#chat > .welcomePanel .sbHomeLayout');
const assistantRow = (page, name) => page.locator('#chat > .welcomePanel .sbHomeAssistantRow').filter({ hasText: name });

async function expectHome(page) {
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
}

async function pickCharacters(page, count) {
    return page.evaluate((limit) => {
        const context = window.SillyTavern.getContext();
        return context.characters
            .filter(character => character?.avatar && character.chat)
            .slice(0, limit)
            .map(character => ({ avatar: character.avatar, chat: character.chat }));
    }, count);
}

function recentChatEntries(characters, count, { distinctFiles = false } = {}) {
    return Array.from({ length: count }, (_, index) => {
        const character = characters[index % characters.length];
        return {
            file_name: `${distinctFiles ? `qa-home-${index}` : character.chat}.jsonl`,
            avatar: character.avatar,
            last_mes: Date.now() - index * 60_000,
            mes: `Preview ${index}`,
            chat_items: 3,
            file_size: '1kb',
        };
    });
}

async function renderHome(page, items) {
    await page.route('**/api/chats/recent', route => route.fulfill({ json: items }));
    await page.evaluate(async () => {
        const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
        await openWelcomeScreen({ force: true });
    });
    await expectHome(page);
}

async function chooseMode(page, mode) {
    await menuButton(page).click();
    await page.getByRole('menuitemradio', { name: MODE_LABELS[mode], exact: true }).click();
    await expect(page.locator('#chat > .welcomePanel')).toHaveAttribute('data-home-panel-mode', mode);
}

async function measure(page, selector) {
    return page.locator(selector).first().evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
}

async function measureConfiguredChatWidth(page) {
    return page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position: absolute; visibility: hidden; width: var(--sheldWidth);';
        document.documentElement.append(probe);
        const { width } = probe.getBoundingClientRect();
        probe.remove();
        return width;
    });
}

async function trackSettingsSaves(page) {
    const saved = { accountStorage: {}, version: 1000 };
    await page.route('**/api/settings/save', (route) => {
        const payload = JSON.parse(route.request().postData() ?? '{}');
        Object.assign(saved.accountStorage, payload.accountStorage);
        return route.fulfill({ json: { result: 'ok', version: ++saved.version } });
    });
    return saved;
}

for (const { name, columns, options } of VIEWPORTS) {
    test.describe(`Home layout at ${name}`, () => {
        test.use(options);

        test.beforeEach(async ({ page }) => {
            await protectMaintainerServer(page);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await expectHome(page);
        });

        test(`lays out ${columns} column${columns === 1 ? '' : 's'} at this width`, async ({ page }) => {
            await chooseMode(page, 'full');
            const panel = await measure(page, '#chat > .welcomePanel');
            const regions = {};
            for (const id of REGION_DOM_ORDER) {
                regions[id] = await measure(page, `.welcomePanel [data-sb-home-region="${id}"]`);
            }
            const header = await measure(page, '.welcomePanel .sbHomeHeader');
            const { 'getting-started': started, assistants, 'recent-chats': recent, links } = regions;

            expect(panel.width >= TWO_COLUMN_MIN_WIDTH, 'panel width picks the column count').toBe(columns === 2);
            expect(header.left).toBeLessThan(recent.left + 1);
            expect(header.right).toBeGreaterThan(recent.right - 1);
            expect(new Set(Object.values(regions).map(rect => Math.round(rect.left))).size).toBe(columns);
            expect(started.top).toBeGreaterThanOrEqual(header.bottom - 1);
            expect(assistants.top).toBeGreaterThanOrEqual(started.bottom - 1);
            expect(recent.top).toBeGreaterThanOrEqual(columns === 2 ? header.bottom - 1 : assistants.bottom - 1);
            expect(links.top).toBeGreaterThanOrEqual(recent.bottom - 1);
            expect(columns === 2 ? recent.left : assistants.left).toBeGreaterThanOrEqual(assistants.left);
            expect(Math.round(links.left)).toBe(Math.round(recent.left));
        });

        test('Tab visits the regions in the order a reader sees them, with real content in every region', async ({ page }) => {
            const characters = await pickCharacters(page, 2);
            expect(characters.length).toBeGreaterThan(0);
            await renderHome(page, recentChatEntries(characters, 3, { distinctFiles: true }));
            await chooseMode(page, 'full');
            const regionRects = await page.evaluate(ids => ids.map((id) => {
                const rect = document.querySelector(`.welcomePanel [data-sb-home-region="${id}"]`).getBoundingClientRect();
                return { id, left: Math.round(rect.left), top: Math.round(rect.top) };
            }), REGION_DOM_ORDER);
            const readingOrder = [...regionRects]
                .sort((first, second) => (first.left === second.left ? first.top - second.top : first.left - second.left))
                .map(region => region.id);

            await menuButton(page).focus();
            const stops = [];
            for (let press = 0; press < 60; press++) {
                await page.keyboard.press('Tab');
                stops.push(await page.evaluate(() => document.activeElement?.closest('[data-sb-home-region]')?.dataset.sbHomeRegion ?? null));
            }
            const inRegions = stops.filter(id => REGION_DOM_ORDER.includes(id));
            const allBlocks = inRegions.filter((id, index) => id !== inRegions[index - 1]);
            // Past the last region, focus leaves Home and wraps around to the start, so only the first lap counts.
            const blocks = allBlocks.slice(0, allBlocks.indexOf('links') + 1);

            expect(readingOrder, 'reading order, left column then right column').toEqual(REGION_DOM_ORDER);
            expect(blocks, 'each region is entered once, in reading order').toEqual(REGION_DOM_ORDER);
        });

        test('every region is a landmark named by its visible heading', async ({ page }) => {
            await chooseMode(page, 'full');

            for (const [id, name] of Object.entries(REGION_NAMES)) {
                await expect(page.locator(`.welcomePanel [data-sb-home-region="${id}"]`), id).toHaveAccessibleName(name);
            }
            for (const id of ['getting-started', 'assistants', 'recent-chats']) {
                const section = page.locator(`.welcomePanel [data-sb-home-region="${id}"]`);
                await expect(section.getByRole('heading', { level: 2, name: REGION_NAMES[id] })).toBeVisible();
            }
        });

        test('keeps the DOM order of the regions', async ({ page }) => {
            const order = await page.evaluate((ids) => {
                const nodes = ['.sbHomeHeader', ...ids.map(id => `[data-sb-home-region="${id}"]`)]
                    .map(selector => document.querySelector(`.welcomePanel ${selector}`));
                return nodes.slice(1).every((node, index) => Boolean(nodes[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
            }, REGION_DOM_ORDER);

            expect(order).toBe(true);
        });

        test('keeps content in a centred column of limited width', async ({ page }) => {
            const layout = await measure(page, '.welcomePanel .sbHomeLayout');
            const panel = await measure(page, '#chat > .welcomePanel');

            expect(layout.width).toBeLessThanOrEqual(1280);
            expect(Math.abs((layout.left - panel.left) - (panel.right - layout.right))).toBeLessThanOrEqual(1);
        });

        for (const mode of ['full', 'compact', 'list']) {
            test(`${MODE_LABELS[mode]} shows the right regions and art`, async ({ page }) => {
                await chooseMode(page, mode);

                for (const [id, visible] of Object.entries(REGION_VISIBILITY[mode])) {
                    const rendered = await page.locator(`.welcomePanel [data-sb-home-region="${id}"]`)
                        .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).display !== 'none' && !node.closest('[hidden]')));
                    expect(rendered.length, `${id} is in the template`).toBeGreaterThan(0);
                    expect(rendered.every(value => value === visible), `${id} in ${mode}`).toBe(true);
                }
                for (const [artId, visible] of Object.entries(ART_VISIBILITY[mode])) {
                    const art = page.locator(`.welcomePanel [data-sb-art-placeholder="${artId}"]`);
                    await expect(art).toHaveCount(1);
                    await expect(art, `${artId} in ${mode}`).toBeVisible({ visible });
                }
                await expect(page.getByRole('heading', { level: 1, name: 'SillyBunny' })).toBeVisible();
                await expect(menuButton(page)).toBeVisible();
            });
        }

        test('List Only fills the shell with Recent Chats', async ({ page }) => {
            await chooseMode(page, 'list');

            const fill = await page.evaluate(() => {
                const chat = document.getElementById('chat').getBoundingClientRect();
                const panel = document.querySelector('#chat > .welcomePanel').getBoundingClientRect();
                return { chatHeight: chat.height, panelHeight: panel.height };
            });
            expect(fill.panelHeight).toBeGreaterThanOrEqual(Math.min(fill.chatHeight, 400) - 2);
        });

        test('the display mode is saved and survives a reload', async ({ page }) => {
            const saved = await trackSettingsSaves(page);

            await chooseMode(page, 'compact');
            await expect.poll(() => saved.accountStorage[MODE_KEY], { timeout: STARTUP_TIMEOUT }).toBe('compact');

            await page.route('**/api/settings/get', async (route) => {
                const data = await fetchJsonOrSkip(route);
                if (!data) return;
                const settings = JSON.parse(data.settings);
                settings.accountStorage = { ...settings.accountStorage, ...saved.accountStorage };
                return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
            });
            await page.evaluate(key => localStorage.removeItem(key), MODE_KEY);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction('document.getElementById("preloader") === null', undefined, { timeout: STARTUP_TIMEOUT });
            await testSetup.waitForAppReady({ page });

            await expectHome(page);
            await expect(page.locator('#chat > .welcomePanel')).toHaveAttribute('data-home-panel-mode', 'compact');
            await expect(page.locator('.welcomePanel [data-sb-art-placeholder="logo-32"]')).toBeVisible();
        });

        test('switching the display mode does not fetch Recent Chats again', async ({ page }) => {
            let requests = 0;
            await page.route('**/api/chats/recent', (route) => {
                requests++;
                return route.fallback();
            });

            await chooseMode(page, 'compact');
            await chooseMode(page, 'list');
            await chooseMode(page, 'full');

            expect(requests).toBe(0);
        });

        test('the main menu button is named, announced and reachable by keyboard', async ({ page }) => {
            await chooseMode(page, 'full');
            const button = menuButton(page);
            await expect(button).toHaveAttribute('aria-label', 'Main Menu');
            await expect(button).toHaveAttribute('title', 'Main Menu');
            await expect(button).toHaveAttribute('aria-haspopup', 'menu');
            await expect(button).toHaveAttribute('aria-expanded', 'false');
            await expect(button.locator('i.fa-bars')).toHaveCount(1);

            await page.locator('.welcomePanel .sbHomeTitle').click();
            await page.keyboard.press('Tab');
            await expect(button).toBeFocused();

            await page.keyboard.press('Enter');
            await expect(button).toHaveAttribute('aria-expanded', 'true');
            const first = page.getByRole('menuitemradio', { name: 'Full', exact: true });
            await expect(first).toBeFocused();
            await expect(first).toHaveAttribute('aria-checked', 'true');

            await page.keyboard.press('ArrowDown');
            await expect(page.getByRole('menuitemradio', { name: 'Compact', exact: true })).toBeFocused();

            await page.keyboard.press('Escape');
            await expect(page.getByRole('menuitemradio', { name: 'Compact', exact: true })).toHaveCount(0);
            await expect(button).toHaveAttribute('aria-expanded', 'false');
            await expect(button).toBeFocused();
        });

        test('the main menu checks the current display mode', async ({ page }) => {
            await chooseMode(page, 'list');

            await menuButton(page).click();

            await expect(page.getByRole('menuitemradio', { name: 'List Only', exact: true })).toHaveAttribute('aria-checked', 'true');
            await expect(page.getByRole('menuitemradio', { name: 'Full', exact: true })).toHaveAttribute('aria-checked', 'false');
            await page.keyboard.press('Escape');
        });

        test('Recent Chats Settings opens from the main menu', async ({ page }) => {
            await menuButton(page).click();
            await page.getByRole('menuitem', { name: 'Recent Chats Settings', exact: true }).click();

            await expect(page.locator('#maxRecentChats')).toBeVisible();
            await expect(page.locator('#collapsedRecentChats')).toBeVisible();

            await page.keyboard.press('Escape');
            await expect(page.locator('#maxRecentChats')).toHaveCount(0);
        });

        test('every copy placeholder carries both copy attributes and no other element does', async ({ page }) => {
            await chooseMode(page, 'full');

            const report = await page.evaluate(() => {
                const root = document.querySelector('#chat > .welcomePanel');
                const marked = [...root.querySelectorAll('[data-sb-copy-placeholder]')];
                const unmarked = [...root.querySelectorAll('*')].filter(node => node.children.length === 0
                    && node.textContent.includes('TODO(copy)')
                    && !node.hasAttribute('data-sb-copy-placeholder'));
                return {
                    slots: marked.map(node => node.getAttribute('data-sb-copy-slot')),
                    flags: marked.map(node => node.getAttribute('data-sb-copy-placeholder')),
                    texts: marked.map(node => node.textContent.trim()),
                    unmarked: unmarked.length,
                };
            });

            expect(report.unmarked).toBe(0);
            expect(report.flags.every(flag => flag === 'true')).toBe(true);
            expect(report.slots.every(slot => /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(slot ?? ''))).toBe(true);
            expect(report.texts.every(text => text === 'TODO(copy)')).toBe(true);
            expect(report.slots).toEqual(expect.arrayContaining([
                'HOME-HERO-DESC',
                'HOME-HERO-FORK',
                'HOME-HERO-GREETING-01',
                'RC-FILTER-EMPTY-HEAD',
                'RC-FILTER-EMPTY-BODY',
                'GS-INTRO',
                'GS-1-BODY',
                'GS-2-BODY',
                'GS-3-BODY',
                'GS-4-BODY',
                'AS-REISEN-SUB',
                'AS-TEWI-SUB',
                'AS-NAHIDA-SUB',
                'HOME-ROW-HELP',
                'HOME-ROW-EXTRAS',
            ]));
        });

        test('Getting Started is collapsed, shows its progress in one string and opens in place', async ({ page }) => {
            await chooseMode(page, 'full');
            const details = gettingStarted(page);
            const summary = gettingStartedSummary(page);

            await expect(summary).toBeVisible();
            await expect(details).not.toHaveAttribute('open', /.*/);
            await expect(summary.locator('.ds-row-label')).toHaveText('Getting Started');
            await expect(summary.locator('.ds-row-subtitle')).toHaveText('0 of 4');
            await expect(stepRows(page).first()).toBeHidden();

            await summary.click();
            await expect(details).toHaveAttribute('open', '');
            await expect(stepRows(page).locator('.ds-row-label')).toHaveText(STEP_TITLES.map(title => new RegExp(`^${title}`)));
            await expect(page.locator('.welcomePanel [data-sb-art-placeholder="gs-reisen"]')).toBeVisible();
            await expect(page.locator('.welcomePanel [data-sb-copy-slot="GS-INTRO"]')).toBeVisible();
            await expect(stepRows(page).locator('.sbHomeTag:visible')).toHaveText(['Optional']);

            await summary.focus();
            await page.keyboard.press('Enter');
            await expect(details).not.toHaveAttribute('open', /.*/);
        });

        test('Getting Started never opens on its own, even after Home renders again', async ({ page }) => {
            await chooseMode(page, 'full');
            await gettingStartedSummary(page).click();
            await expect(gettingStarted(page)).toHaveAttribute('open', '');

            await renderHome(page, []);

            await expect(gettingStarted(page)).not.toHaveAttribute('open', /.*/);
        });

        test('each Getting Started step has Show Me and Skip, and the Optional label is only on the preset step', async ({ page }) => {
            await chooseMode(page, 'full');
            await gettingStartedSummary(page).click();

            await expect(stepRows(page)).toHaveCount(4);
            for (const index of [0, 1, 2, 3]) {
                const row = stepRows(page).nth(index);
                await expect(row.locator('button')).toHaveText(['Show Me', 'Skip']);
                await expect(row.locator('.ds-row-subtitle')).toHaveAttribute('data-sb-copy-slot', `GS-${index + 1}-BODY`);
            }
            await expect(stepRows(page).locator('.sbHomeTag:visible')).toHaveText(['Optional']);
        });

        test('Skip marks a step as skipped, updates the count, and a second press restores it', async ({ page }) => {
            await chooseMode(page, 'full');
            await gettingStartedSummary(page).click();
            const row = stepRows(page).nth(1);
            const skip = row.getByRole('button', { name: 'Skip' });
            const count = gettingStartedSummary(page).locator('.ds-row-subtitle');

            await expect(skip).toHaveAttribute('aria-pressed', 'false');
            await skip.click();
            await expect(skip).toHaveAttribute('aria-pressed', 'true');
            await expect(row).toHaveAttribute('data-sb-step-state', 'skipped');
            await expect(row.locator('.sbHomeTag:visible')).toHaveText(['Optional', 'Skipped']);
            await expect(count).toHaveText('1 of 4');
            await expect(skip).toBeFocused();

            await skip.click();
            await expect(skip).toHaveAttribute('aria-pressed', 'false');
            await expect(row).toHaveAttribute('data-sb-step-state', 'open');
            await expect(count).toHaveText('0 of 4');
        });

        test('a skipped step stays skipped when Home renders again', async ({ page }) => {
            await chooseMode(page, 'full');
            await gettingStartedSummary(page).click();
            await stepRows(page).nth(0).getByRole('button', { name: 'Skip' }).click();
            await expect(gettingStartedSummary(page).locator('.ds-row-subtitle')).toHaveText('1 of 4');

            await renderHome(page, []);
            await gettingStartedSummary(page).click();

            await expect(gettingStartedSummary(page).locator('.ds-row-subtitle')).toHaveText('1 of 4');
            await expect(stepRows(page).nth(0).getByRole('button', { name: 'Skip' })).toHaveAttribute('aria-pressed', 'true');
        });

        test('Show Me on the last step opens the mode switcher menu', async ({ page }) => {
            await chooseMode(page, 'full');
            await gettingStartedSummary(page).click();

            await stepRows(page).nth(3).getByRole('button', { name: 'Show Me' }).click();

            await expect(page.locator('#sb-mode-menu')).toBeVisible();
        });

        test('Show Me on the first two steps opens Connections and Presets in Backend', async ({ page }) => {
            await chooseMode(page, 'full');
            await gettingStartedSummary(page).click();

            await stepRows(page).nth(0).getByRole('button', { name: 'Show Me' }).click();
            await expect(page.getByRole('tab', { name: 'Connections', selected: true })).toBeVisible();

            await page.keyboard.press('Escape');
            await stepRows(page).nth(1).getByRole('button', { name: 'Show Me' }).click();
            await expect(page.getByRole('tab', { name: 'Presets', selected: true })).toBeVisible();
        });

        test('Getting Started is hidden in Compact and List Only', async ({ page }) => {
            for (const mode of ['compact', 'list']) {
                await chooseMode(page, mode);
                await expect(gettingStartedSummary(page), mode).toBeHidden();
            }
            await chooseMode(page, 'full');
            await expect(gettingStartedSummary(page)).toBeVisible();
        });

        test('Show Me on Get a Character Card opens the character list, not the last Characters tab, and stays open when pressed again', async ({ page }) => {
            await chooseMode(page, 'full');
            await page.evaluate(async () => {
                await window.SillyBunnyShell.openTab('characters', 'persona');
                window.SillyBunnyShell.closeCharacters();
            });
            await expect(page.locator('#sb-settings-page')).toBeHidden();
            await gettingStartedSummary(page).click();
            const showMe = stepRows(page).nth(2).locator('button').first();
            const characterTab = page.getByRole('tab', { name: 'Characters', exact: true, selected: true });

            await showMe.click();
            await expect(characterTab).toBeVisible();
            await expect(page.getByRole('tab', { name: 'Persona', selected: true })).toHaveCount(0);

            await showMe.dispatchEvent('click');
            await expect(page.locator('#sb-settings-page')).toBeVisible();
            await expect(characterTab).toBeVisible();
            await expect(page.getByRole('tab', { name: 'Persona', selected: true })).toHaveCount(0);
        });

        test('Show Me stays on its place when pressed twice: Connections, Presets and the mode menu', async ({ page }) => {
            await chooseMode(page, 'full');
            await gettingStartedSummary(page).click();
            const showMe = index => stepRows(page).nth(index).locator('button').first();

            for (const [index, tab] of [[0, 'Connections'], [1, 'Presets']]) {
                await showMe(index).dispatchEvent('click');
                await expect(page.getByRole('tab', { name: tab, selected: true })).toBeVisible();
                await showMe(index).dispatchEvent('click');
                await expect(page.getByRole('tab', { name: tab, selected: true })).toBeVisible();
            }

            await showMe(3).dispatchEvent('click');
            await expect(page.locator('#sb-mode-menu')).toBeVisible();
            await showMe(3).dispatchEvent('click');
            await expect(page.locator('#sb-mode-menu')).toBeVisible();
        });

        test('Show Me and Skip are neutral flat buttons in the row text colour', async ({ page }) => {
            await chooseMode(page, 'full');
            await gettingStartedSummary(page).click();
            const row = stepRows(page).first();

            const colours = await row.evaluate(node => ({
                title: getComputedStyle(node.querySelector('.ds-row-label')).color,
                buttons: [...node.querySelectorAll('button')].map(button => getComputedStyle(button).color),
            }));

            expect(colours.buttons).toEqual([colours.title, colours.title]);
        });

        test('the Getting Started title is a heading and its progress is not a live region', async ({ page }) => {
            await chooseMode(page, 'full');

            await expect(page.getByRole('heading', { level: 2, name: 'Getting Started' })).toBeVisible();
            await expect(gettingStartedSummary(page).locator('.ds-row-subtitle')).not.toHaveAttribute('aria-live', /.*/);
        });

        test('an Assistant Menu button is named after its assistant, and the row button is named once and described by its subtitle', async ({ page }) => {
            await chooseMode(page, 'full');
            const row = assistantRow(page, 'Reisen');

            await expect(row.locator('.sbHomeRowMenu')).toHaveAccessibleName('Assistant Menu Reisen');
            await expect(row.locator('.sbHomeRowOpen')).toHaveAccessibleName('Reisen');
            await expect(row.locator('.sbHomeRowOpen')).toHaveAccessibleDescription('TODO(copy)');
            await expect(assistantRow(page, 'Tewi').locator('.sbHomeRowMenu')).toHaveAccessibleName('Assistant Menu Tewi');
        });

        test('pressing an assistant row fills the row, and pressing its menu button does not', async ({ page }) => {
            await chooseMode(page, 'full');
            const row = assistantRow(page, 'Reisen');
            const background = () => row.evaluate(node => getComputedStyle(node).backgroundColor);
            const centre = async (selector) => {
                const box = await row.locator(selector).boundingBox();
                return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            };

            const menuPoint = await centre('.sbHomeRowMenu');
            await page.mouse.move(menuPoint.x, menuPoint.y);
            const resting = await background();
            await page.mouse.down();
            const pressedMenu = await background();
            await page.mouse.up();
            await page.keyboard.press('Escape');

            const rowPoint = await centre('.ds-row-text');
            await page.mouse.move(rowPoint.x, rowPoint.y);
            await page.mouse.down();
            const pressedRow = await background();
            await page.mouse.up();

            expect(pressedMenu).toBe(resting);
            expect(pressedRow).not.toBe(resting);
        });

        test('the Nahida portrait is not requested until More Assistants is expanded', async ({ page }) => {
            const requests = [];
            page.on('request', (request) => {
                if (request.url().includes('assistant-nahida-portrait.png')) requests.push(request.url());
            });
            await renderHome(page, []);
            await chooseMode(page, 'full');
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));

            expect(requests).toHaveLength(0);

            await page.locator('.welcomePanel summary', { hasText: 'More Assistants' }).click();

            await expect.poll(() => requests.length).toBeGreaterThan(0);
        });

        test('the Assistants rows have art, a name, a placeholder and one menu button each', async ({ page }) => {
            await chooseMode(page, 'full');
            await page.locator('.welcomePanel summary', { hasText: 'More Assistants' }).click();
            const rows = page.locator('#chat > .welcomePanel .sbHomeAssistantRow');

            await expect(rows.locator('.ds-row-label')).toHaveText(ASSISTANT_NAMES);
            await expect(rows.locator('.ds-row-subtitle')).toHaveText(['TODO(copy)', 'TODO(copy)', 'TODO(copy)']);
            for (const index of [0, 1, 2]) {
                const row = rows.nth(index);
                await expect(row).toHaveAttribute('data-sb-stub', 'true');
                await expect(row.locator('button')).toHaveCount(2);
                const menu = row.getByRole('button', { name: 'Assistant Menu' });
                await expect(menu).toHaveAttribute('aria-haspopup', 'menu');
                await expect(menu).toHaveAttribute('aria-expanded', 'false');
                await expect(menu.locator('i.fa-ellipsis-vertical')).toHaveCount(1);
            }
            await expect(page.locator('.welcomePanel [data-sb-art-placeholder="row-reisen"]')).toBeVisible();
            await expect(page.locator('.welcomePanel [data-sb-art-placeholder="row-tewi"]')).toBeVisible();
        });

        test('More Assistants holds Nahida with a 64px cropped portrait', async ({ page }) => {
            await chooseMode(page, 'full');
            const nahida = assistantRow(page, 'Nahida');
            await expect(nahida).toBeHidden();

            await page.locator('.welcomePanel summary', { hasText: 'More Assistants' }).click();

            await expect(nahida).toBeVisible();
            const portrait = nahida.locator('img');
            await expect(portrait).toHaveAttribute('src', /assistant-nahida-portrait\.png$/);
            await expect.poll(() => portrait.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
            const look = await portrait.evaluate((image) => {
                const rect = image.getBoundingClientRect();
                const style = getComputedStyle(image);
                return { width: Math.round(rect.width), height: Math.round(rect.height), fit: style.objectFit, radius: parseFloat(style.borderTopLeftRadius) };
            });
            expect(look).toMatchObject({ width: 64, height: 64, fit: 'cover' });
            expect(look.radius).toBeGreaterThan(0);
        });

        test('the new art placeholders keep their native sizes', async ({ page }) => {
            await chooseMode(page, 'full');
            await gettingStartedSummary(page).click();

            for (const [id, [width, height]] of Object.entries(SECTION_ART_SIZES)) {
                const box = page.locator(`.welcomePanel [data-sb-art-placeholder="${id}"]`);
                await expect(box).toBeVisible();
                await expect(box).toHaveAttribute('aria-hidden', 'true');
                await expect(box).toHaveText(id);
                const rect = await measure(page, `.welcomePanel [data-sb-art-placeholder="${id}"]`);
                expect([id, Math.round(rect.width), Math.round(rect.height)]).toEqual([id, width, height]);
            }
        });

        test('the Assistant Menu offers New Chat, Temporary Chat and the other mode, then closes without acting', async ({ page }) => {
            await chooseMode(page, 'full');
            const row = assistantRow(page, 'Reisen');
            const trigger = row.getByRole('button', { name: 'Assistant Menu' });

            await trigger.click();
            const menu = page.getByRole('menu', { name: 'Assistant Menu' });
            await expect(menu).toBeVisible();
            await expect(trigger).toHaveAttribute('aria-expanded', 'true');
            await expect(menu.getByRole('menuitem')).toHaveText(['New Chat', 'Temporary Chat', 'Open in Conversation']);
            await expect(menu.getByRole('menuitem').locator('i')).toHaveCount(3);
            const stubs = await menu.getByRole('menuitem').evaluateAll(items => items.map(item => item.getAttribute('data-sb-stub')));
            expect(stubs).toEqual(['true', 'true', 'true']);
            const menuBox = await menu.boundingBox();
            const panelBox = await measure(page, '#chat > .welcomePanel');
            expect(menuBox.x).toBeGreaterThanOrEqual(Math.max(0, panelBox.left) - 1);
            expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(Math.min(page.viewportSize().width, panelBox.right) + 1);

            await menu.getByRole('menuitem', { name: 'New Chat' }).click();
            await expect(menu).toHaveCount(0);
            await expect(trigger).toBeFocused();
            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
            await expect(page.locator('dialog[open]')).toHaveCount(0);
        });

        test('the Assistant Menu opens from the keyboard and offers Roleplay after Conversation', async ({ page }) => {
            await page.evaluate(async () => {
                const { recordChatMode } = await import('/scripts/sillybunny-chat-mode-memory.js');
                recordChatMode('conversation');
            });
            await renderHome(page, []);
            await chooseMode(page, 'full');
            const trigger = assistantRow(page, 'Tewi').getByRole('button', { name: 'Assistant Menu' });

            await trigger.focus();
            await page.keyboard.press('Enter');

            const menu = page.getByRole('menu', { name: 'Assistant Menu' });
            await expect(menu.getByRole('menuitem')).toHaveText(['New Chat', 'Temporary Chat', 'Open in Roleplay']);
            await expect(menu.getByRole('menuitem').first()).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(trigger).toBeFocused();
        });

        test('activating an Assistants row or the Help row does nothing yet', async ({ page }) => {
            await chooseMode(page, 'full');
            const mode = await page.locator('#chat > .welcomePanel').getAttribute('data-home-panel-mode');

            await assistantRow(page, 'Reisen').getByRole('button', { name: 'Reisen', exact: true }).click();
            await page.locator('#chat > .welcomePanel [data-sb-editor-field="links-help"]').click();

            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
            await expect(page.locator('dialog[open]')).toHaveCount(0);
            await expect(extrasPage(page)).toHaveCount(0);
            await expect(page.locator('#chat > .welcomePanel')).toHaveAttribute('data-home-panel-mode', mode);
            await expect(page.locator('#chat > .welcomePanel [data-sb-editor-field="links-help"]')).toHaveAttribute('data-sb-stub', 'true');
        });

        test('Help and Bundled Extras are two boxed rows with a trailing arrow', async ({ page }) => {
            await chooseMode(page, 'full');
            const links = page.locator('.welcomePanel [data-sb-home-region="links"]');

            await expect(links.locator('.ds-row-label')).toHaveText(['Help', 'Bundled Extras']);
            await expect(links.locator('[data-sb-copy-slot="HOME-ROW-HELP"]')).toHaveText('TODO(copy)');
            await expect(links.locator('.ds-row__chevron')).toHaveCount(2);
            await expect(links.locator('[data-sb-copy-slot="HOME-ROW-EXTRAS"]')).toHaveText('TODO(copy)');
        });

        test('the Bundled Extras row pushes the page in place of the sections', async ({ page }) => {
            await chooseMode(page, 'full');
            const mode = await page.locator('#chat > .welcomePanel').getAttribute('data-home-panel-mode');

            await bundledExtrasRow(page).click();

            await expect(extrasPage(page)).toBeVisible();
            await expect(extrasPage(page)).toHaveAccessibleName('Bundled Extras');
            await expect(homeLayout(page)).toBeHidden();
            await expect(extrasPage(page).getByRole('heading', { level: 2, name: 'Bundled Extras' })).toBeVisible();
            await expect(backButton(page)).toBeFocused();
            await expect(backButton(page).locator('i.fa-chevron-left')).toHaveCount(1);
            await expect(page.locator('#chat > .welcomePanel')).toHaveAttribute('data-home-panel-mode', mode);
            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
            expect(new URL(page.url()).hash).toBe('');
        });

        test('the Bundled Extras page lists its groups and items, then UI Themes', async ({ page }) => {
            await chooseMode(page, 'full');
            await bundledExtrasRow(page).click();
            const content = extrasPage(page);

            await expect(content.getByRole('heading', { level: 3 })).toHaveText(EXTRAS_GROUPS);
            await expect(content.locator('.ds-row-label')).toHaveText([...EXTRAS_ITEMS, 'UI Themes']);
            await expect(content.locator('[data-sb-copy-slot="BE-INTRO"]')).toHaveText('TODO(copy)');
            const slots = await content.locator('.ds-row-subtitle[data-sb-copy-slot]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sb-copy-slot')));
            expect(slots).toHaveLength(EXTRAS_ITEMS.length);
            expect(slots.every(slot => /^BE-ITEM-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(slot))).toBe(true);
            expect(new Set(slots).size).toBe(slots.length);
            await expect(content.getByRole('button'), 'only Back and UI Themes act').toHaveCount(2);
            await expect(content.locator('a')).toHaveCount(0);
        });

        test('the Bundled Extras art placeholder keeps its native size', async ({ page }) => {
            await chooseMode(page, 'full');
            await bundledExtrasRow(page).click();
            const art = extrasPage(page).locator('[data-sb-art-placeholder="extras-tewi"]');

            await expect(art).toBeVisible();
            await expect(art).toHaveAttribute('aria-hidden', 'true');
            const rect = await measure(page, '.welcomePanel [data-sb-art-placeholder="extras-tewi"]');
            expect([Math.round(rect.width), Math.round(rect.height)]).toEqual([96, 96]);
        });

        test('Back returns to the sections and focus to the Bundled Extras row', async ({ page }) => {
            await chooseMode(page, 'full');
            await bundledExtrasRow(page).click();
            await expect(backButton(page)).toBeFocused();

            await backButton(page).click();

            await expect(extrasPage(page)).toHaveCount(0);
            await expect(homeLayout(page)).toBeVisible();
            await expect(bundledExtrasRow(page)).toBeFocused();
            await expect(page.locator('#chat > .welcomePanel')).not.toHaveAttribute('data-sb-home-page', /.*/);
        });

        test('Escape returns to the sections and focus to the Bundled Extras row', async ({ page }) => {
            await chooseMode(page, 'full');
            await bundledExtrasRow(page).click();
            await expect(backButton(page)).toBeFocused();

            await page.keyboard.press('Escape');

            await expect(extrasPage(page)).toHaveCount(0);
            await expect(homeLayout(page)).toBeVisible();
            await expect(bundledExtrasRow(page)).toBeFocused();
        });

        test('Escape also returns after a click on the page itself, and the page can be opened again', async ({ page }) => {
            await chooseMode(page, 'full');
            await bundledExtrasRow(page).click();
            await extrasPage(page).locator('.sbHomePageTitle').click();
            await expect(backButton(page)).not.toBeFocused();

            await page.keyboard.press('Escape');
            await expect(extrasPage(page)).toHaveCount(0);

            await bundledExtrasRow(page).click();
            await expect(extrasPage(page)).toBeVisible();
            await expect(backButton(page)).toBeFocused();
        });

        test('Escape returns after focus was dropped outside the page content', async ({ page }) => {
            await chooseMode(page, 'full');
            await bundledExtrasRow(page).click();
            await expect(backButton(page)).toBeFocused();

            await page.locator('#chat').click({ position: { x: 2, y: 300 } });
            await expect(backButton(page)).not.toBeFocused();
            await page.keyboard.press('Escape');

            await expect(extrasPage(page)).toHaveCount(0);
            await expect(bundledExtrasRow(page)).toBeFocused();
        });

        test('a refresh while the page is open waits, and Home shows the refreshed content once the page closes', async ({ page }) => {
            const characters = await pickCharacters(page, 1);
            expect(characters.length).toBeGreaterThan(0);
            await renderHome(page, recentChatEntries(characters, 1, { distinctFiles: true }));
            await chooseMode(page, 'full');
            await bundledExtrasRow(page).click();
            await expect(backButton(page)).toBeFocused();
            await page.evaluate(() => {
                window.qaPanel = document.querySelector('#chat > .welcomePanel');
                window.qaPage = document.querySelector('.sbHomePage');
            });
            await page.route('**/api/chats/recent', route => route.fulfill({ json: recentChatEntries(characters, 3, { distinctFiles: true }) }));

            await page.evaluate(async () => {
                const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
                await openWelcomeScreen({ force: true });
            });
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));

            const whileOpen = await page.evaluate(() => ({
                samePanel: window.qaPanel === document.querySelector('#chat > .welcomePanel'),
                samePage: window.qaPage === document.querySelector('.sbHomePage'),
                rows: document.querySelectorAll('.welcomePanel .recentChat').length,
            }));
            expect(whileOpen).toEqual({ samePanel: true, samePage: true, rows: 1 });
            await expect(backButton(page)).toBeFocused();

            await backButton(page).click();

            await expect(page.locator('.welcomePanel .recentChat')).toHaveCount(3);
            await expect(extrasPage(page)).toHaveCount(0);
            await expect(bundledExtrasRow(page)).toBeFocused();
            expect(await page.evaluate(() => document.querySelectorAll('#chat > .welcomePanel').length)).toBe(1);
        });

        test('while the page is open, Tab stays on the page and never reaches the hidden sections', async ({ page }) => {
            await chooseMode(page, 'full');
            await bundledExtrasRow(page).click();
            await expect(backButton(page)).toBeFocused();

            const stops = [];
            for (let press = 0; press < 6; press++) {
                await page.keyboard.press('Tab');
                stops.push(await page.evaluate(() => ({
                    inPage: Boolean(document.activeElement?.closest('.sbHomePage')),
                    inLayout: Boolean(document.activeElement?.closest('.sbHomeLayout')),
                })));
            }

            expect(stops.some(stop => stop.inLayout)).toBe(false);
            expect(stops.filter(stop => stop.inPage).length).toBeGreaterThan(0);
        });

        test('UI Themes opens Customize, Appearance with the theme select shown', async ({ page }) => {
            await chooseMode(page, 'full');
            await bundledExtrasRow(page).click();

            await extrasPage(page).getByRole('button', { name: 'UI Themes' }).click();

            await expect(page.getByRole('tab', { name: 'Appearance', selected: true })).toBeVisible();
            await expect(page.locator('#themes')).toBeVisible();

            await extrasPage(page).getByRole('button', { name: 'UI Themes' }).dispatchEvent('click');
            await expect(page.getByRole('tab', { name: 'Appearance', selected: true })).toBeVisible();
            await expect(page.locator('#themes')).toBeVisible();
        });

        test('Escape closes Customize first and leaves the Bundled Extras page open', async ({ page }) => {
            await chooseMode(page, 'full');
            await bundledExtrasRow(page).click();
            await extrasPage(page).getByRole('button', { name: 'UI Themes' }).click();
            await expect(page.locator('#themes')).toBeVisible();

            await page.keyboard.press('Escape');

            await expect(page.locator('#themes')).toBeHidden();
            await expect(extrasPage(page)).toBeVisible();
            await expect(extrasPage(page)).toHaveCount(1);
        });

        test('the page slides with the navigation spring, and instantly when motion is reduced', async ({ page }) => {
            const durations = () => page.evaluate(() => {
                const row = document.querySelector('[data-sb-editor-field="links-bundled-extras"]');
                row.click();
                const pageNode = document.querySelector('.sbHomePage');
                return pageNode.getAnimations().map(animation => animation.effect.getComputedTiming().duration);
            });
            await chooseMode(page, 'full');

            expect(await durations(), 'reduced motion').toEqual([]);
            await expect(homeLayout(page)).toBeHidden();
            await backButton(page).click();
            await expect(extrasPage(page)).toHaveCount(0);

            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await page.evaluate(() => document.body.classList.remove('reduced-motion'));
            expect(await durations(), 'with motion').toEqual([NAVIGATION_SPRING_MS]);
            await expect(homeLayout(page)).toBeHidden();
            await backButton(page).click();
            await expect(extrasPage(page)).toHaveCount(0);
            await expect(homeLayout(page)).toBeVisible();
            await expect(bundledExtrasRow(page)).toBeFocused();
        });

        test('Home keeps its scroll position across the page', async ({ page }) => {
            await chooseMode(page, 'full');
            await page.evaluate(() => {
                document.querySelector('.sbHomeLayout').style.paddingBlockEnd = '1500px';
                document.querySelector('[data-sb-editor-field="links-bundled-extras"]').scrollIntoView({ block: 'start' });
            });
            const before = await page.evaluate(() => document.getElementById('chat').scrollTop);
            expect(before, 'Home is scrolled before the page opens').toBeGreaterThan(0);

            await bundledExtrasRow(page).click();
            await expect(extrasPage(page)).toBeVisible();
            expect(await page.evaluate(() => document.getElementById('chat').scrollTop)).toBe(0);
            await backButton(page).click();
            await expect(homeLayout(page)).toBeVisible();

            expect(await page.evaluate(() => document.getElementById('chat').scrollTop)).toBe(before);
        });

        test('the fork notice link is separate from its placeholder and opens SillyTavern safely', async ({ page }) => {
            const link = page.locator('.welcomePanel a[href="https://github.com/SillyTavern/SillyTavern"]');

            await expect(link).toHaveText('SillyTavern');
            await expect(link).toHaveAttribute('target', '_blank');
            await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
            await expect(page.locator('.welcomePanel [data-sb-copy-slot="HOME-HERO-FORK"] a')).toHaveCount(0);
        });

        test('art placeholders keep their native size and are hidden from assistive technology', async ({ page }) => {
            await chooseMode(page, 'full');
            await renderHome(page, []);

            for (const [id, [width, height]] of Object.entries(BODY_ART_SIZES)) {
                const box = page.locator(`.welcomePanel [data-sb-art-placeholder="${id}"]`);
                await expect(box).toBeVisible();
                await expect(box).toHaveAttribute('aria-hidden', 'true');
                await expect(box).toHaveText(id);
                const rect = await measure(page, `.welcomePanel [data-sb-art-placeholder="${id}"]`);
                expect([Math.round(rect.width), Math.round(rect.height)]).toEqual([width, height]);
            }

            await chooseMode(page, 'compact');
            const logo = page.locator('.welcomePanel [data-sb-art-placeholder="logo-32"]');
            await expect(logo).toBeVisible();
            await expect(logo).toHaveAttribute('aria-hidden', 'true');
            const logoRect = await measure(page, '.welcomePanel [data-sb-art-placeholder="logo-32"]');
            expect([Math.round(logoRect.width), Math.round(logoRect.height)]).toEqual(LOGO_SIZE);
            await expect(page.locator('.welcomePanel [data-sb-art-placeholder="empty-tewi"]')).toBeHidden();
        });

        test('an empty Recent Chats list shows the placeholder copy and no filtered state', async ({ page }) => {
            await chooseMode(page, 'full');
            await renderHome(page, []);

            const slots = await page.locator('.welcomePanel [data-sb-home-empty="all"] [data-sb-copy-placeholder]')
                .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sb-copy-slot')));
            expect(slots).toEqual(['RC-EMPTY-HEAD', 'RC-EMPTY-BODY']);
            await expect(page.locator('.welcomePanel [data-recent-chat-empty-state="filtered"]')).toBeHidden();
        });

        test('Recent Chats lists, filters and expands', async ({ page }) => {
            const characters = await pickCharacters(page, 2);
            expect(characters.length).toBeGreaterThan(0);
            await renderHome(page, recentChatEntries(characters, 5));
            await chooseMode(page, 'full');
            const rows = page.locator('.welcomePanel .recentChatList .recentChat:visible');
            const filtered = page.locator('.welcomePanel [data-recent-chat-empty-state="filtered"]');

            await expect(rows).toHaveCount(3);
            await expect(filtered).toBeHidden();

            const showMore = page.locator('.welcomePanel button.showMoreChats');
            await expect(showMore).toBeVisible();
            await showMore.click();
            await expect(rows).toHaveCount(5);
            await showMore.click();
            await expect(rows).toHaveCount(3);

            await page.locator('.welcomePanel [data-recent-chat-filter="group"]').click();
            await expect(rows).toHaveCount(0);
            await expect(filtered).toBeVisible();
            await expect(filtered.locator('[data-sb-copy-slot="RC-FILTER-EMPTY-HEAD"]')).toHaveText('TODO(copy)');
            await expect(filtered.locator('[data-sb-copy-slot="RC-FILTER-EMPTY-BODY"]')).toHaveText('TODO(copy)');

            await page.locator('.welcomePanel [data-recent-chat-filter="individual"]').click();
            await expect(filtered).toBeHidden();
            await expect(rows).toHaveCount(3);
        });

        test('a Recent Chats entry opens its chat', async ({ page }) => {
            const characters = await pickCharacters(page, 1);
            expect(characters).toHaveLength(1);
            await renderHome(page, recentChatEntries(characters, 1));

            await page.locator('.welcomePanel .recentChat button.recentChatOpen').first().click();
            await dismissOpenDialogIfPresent(page);

            await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/, { timeout: STARTUP_TIMEOUT });
            // Selecting the character first loads its default chat; the requested file opens after that.
            await expect.poll(() => page.evaluate(() => {
                const context = window.SillyTavern.getContext();
                return { chatId: context.getCurrentChatId(), avatar: context.characters[context.characterId]?.avatar ?? null };
            }), { timeout: STARTUP_TIMEOUT }).toEqual({ chatId: characters[0].chat, avatar: characters[0].avatar });
        });

        test('pinning a chat re-renders Home in place without announcing a Home state change', async ({ page }) => {
            const characters = await pickCharacters(page, 2);
            expect(characters.length).toBeGreaterThan(0);
            await renderHome(page, recentChatEntries(characters, characters.length));
            await page.evaluate(() => {
                window.qaHomeStateChanges = 0;
                document.addEventListener('sb:home-state-changed', () => { window.qaHomeStateChanges++; });
                window.qaOldPanel = document.querySelector('#chat > .welcomePanel');
            });

            await page.locator('.welcomePanel .recentChat .pinChat').first().click();
            await expect(page.locator('.welcomePanel .recentChat .pinChat[aria-pressed="true"]')).toHaveCount(1);
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));

            const result = await page.evaluate(() => ({
                changes: window.qaHomeStateChanges,
                replaced: window.qaOldPanel !== document.querySelector('#chat > .welcomePanel'),
                panels: document.querySelectorAll('#chat > .welcomePanel').length,
            }));
            expect(result).toEqual({ changes: 0, replaced: true, panels: 1 });
            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
        });

        test('a pinned chat keeps keyboard focus on its pin control after Home renders again', async ({ page }) => {
            const characters = await pickCharacters(page, 1);
            expect(characters.length).toBeGreaterThan(0);
            await renderHome(page, recentChatEntries(characters, 3, { distinctFiles: true }));
            const row = page.locator('.welcomePanel .recentChat[data-file="qa-home-2"]');

            await row.locator('.pinChat').focus();
            await page.keyboard.press('Enter');

            await expect(row.locator('.pinChat')).toHaveAttribute('aria-pressed', 'true');
            await expect(row.locator('.pinChat')).toBeFocused();
        });

        test('a pin activated by a pointer that does not focus buttons still keeps focus on the pin control', async ({ page }) => {
            const characters = await pickCharacters(page, 1);
            expect(characters.length).toBeGreaterThan(0);
            await renderHome(page, recentChatEntries(characters, 3, { distinctFiles: true }));
            const row = page.locator('.welcomePanel .recentChat[data-file="qa-home-1"]');

            await row.locator('.pinChat').evaluate((button) => {
                document.activeElement?.blur();
                button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });

            await expect(row.locator('.pinChat')).toHaveAttribute('aria-pressed', 'true');
            await expect(row.locator('.pinChat')).toBeFocused();
        });

        test('Recent Chats Settings returns focus to the main menu button after it saves', async ({ page }) => {
            await menuButton(page).click();
            await page.getByRole('menuitem', { name: 'Recent Chats Settings', exact: true }).click();
            await expect(page.locator('#maxRecentChats')).toBeVisible();

            await page.locator('dialog[open] .popup-button-ok').click();

            await expect(page.locator('#maxRecentChats')).toHaveCount(0);
            await expect(menuButton(page)).toBeFocused();
        });

        test('each Recent Chats row holds two controls and a Chat Menu with Rename and Delete', async ({ page }) => {
            const characters = await pickCharacters(page, 1);
            expect(characters.length).toBeGreaterThan(0);
            await renderHome(page, recentChatEntries(characters, 2, { distinctFiles: true }));
            const row = page.locator('.welcomePanel .recentChat[data-file="qa-home-0"]');
            const trigger = row.locator('.chatMenu');

            await expect(row.locator('button:not(.recentChatOpen)')).toHaveCount(2);
            await expect(trigger).toHaveAttribute('aria-label', 'Chat Menu');
            await expect(trigger).toHaveAttribute('title', 'Chat Menu');
            await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
            await expect(trigger.locator('i.fa-ellipsis-vertical')).toHaveCount(1);
            await expect(row.locator('.renameChat, .deleteChat')).toHaveCount(0);

            await trigger.click();
            const menu = page.getByRole('menu', { name: 'Chat Menu' });
            await expect(menu).toBeVisible();
            await expect(trigger).toHaveAttribute('aria-expanded', 'true');
            await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Delete']);
            await expect(menu.getByRole('menuitem', { name: 'Delete' }).locator('i.fa-trash')).toHaveCount(1);
            await expect(menu.getByRole('menuitem', { name: 'Delete' })).toHaveClass(/is-danger/);
            const menuBox = await menu.boundingBox();
            const panelBox = await measure(page, '#chat > .welcomePanel');
            expect(menuBox.x).toBeGreaterThanOrEqual(Math.max(0, panelBox.left) - 1);
            expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(Math.min(page.viewportSize().width, panelBox.right) + 1);

            await page.keyboard.press('Escape');
            await expect(menu).toHaveCount(0);
            await expect(trigger).toBeFocused();
        });

        test('Delete from the Chat Menu confirms, and focus lands on the row that took its place', async ({ page }) => {
            const characters = await pickCharacters(page, 1);
            expect(characters.length).toBeGreaterThan(0);
            const entries = recentChatEntries(characters, 3, { distinctFiles: true });
            let served = entries;
            await page.route('**/api/chats/delete', route => {
                served = entries.filter(entry => entry.file_name !== 'qa-home-1.jsonl');
                return route.fulfill({ json: {} });
            });
            await page.route('**/api/chats/recent', route => route.fulfill({ json: served }));
            await page.evaluate(async () => {
                const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
                await openWelcomeScreen({ force: true });
            });
            await expectHome(page);
            const rows = page.locator('.welcomePanel .recentChat');
            await expect(rows).toHaveCount(3);

            await page.locator('.welcomePanel .recentChat[data-file="qa-home-1"] .chatMenu').click();
            await page.getByRole('menuitem', { name: 'Delete' }).click();
            const confirm = page.locator('dialog[open] .popup-button-ok');
            await expect(confirm).toBeVisible();
            await confirm.click();

            await expect(rows).toHaveCount(2);
            await expect(page.locator('.welcomePanel .recentChat[data-file="qa-home-2"] .recentChatOpen')).toBeFocused();
        });

        test('cancelling Delete leaves focus on the Chat Menu button', async ({ page }) => {
            const characters = await pickCharacters(page, 1);
            expect(characters.length).toBeGreaterThan(0);
            await renderHome(page, recentChatEntries(characters, 2, { distinctFiles: true }));
            const trigger = page.locator('.welcomePanel .recentChat[data-file="qa-home-0"] .chatMenu');

            await trigger.click();
            await page.getByRole('menuitem', { name: 'Delete' }).click();
            await page.locator('dialog[open] .popup-button-cancel').click();

            await expect(page.locator('dialog[open]')).toHaveCount(0);
            await expect(trigger).toBeFocused();
        });
    });
}

for (const { name, options } of WIDE_VIEWPORTS) {
    test.describe(`Home shell width at ${name}`, () => {
        test.use(options);

        test.beforeEach(async ({ page }) => {
            await protectMaintainerServer(page);
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await expectHome(page);
        });

        test('the shell is wider than the chat width, centred, and never wider than the window minus its margins', async ({ page }) => {
            const chatWidth = await measureConfiguredChatWidth(page);
            const shell = await measure(page, '#sheld');
            const windowWidth = page.viewportSize().width;

            expect(chatWidth).toBeLessThan(HOME_SHELL_WIDTH);
            expect(Math.round(shell.width)).toBe(Math.min(HOME_SHELL_WIDTH, windowWidth - 32));
            expect(Math.abs(shell.left - (windowWidth - shell.right))).toBeLessThanOrEqual(1);
        });

        test('opening a chat returns the shell to the chat width', async ({ page }) => {
            const characters = await pickCharacters(page, 1);
            expect(characters).toHaveLength(1);
            const chatWidth = await measureConfiguredChatWidth(page);
            await renderHome(page, recentChatEntries(characters, 1));

            await page.locator('.welcomePanel .recentChat button.recentChatOpen').first().click();
            await dismissOpenDialogIfPresent(page);

            await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/, { timeout: STARTUP_TIMEOUT });
            await expect.poll(async () => Math.round((await measure(page, '#sheld')).width)).toBe(Math.round(chatWidth));
        });

        test('the way back to the chat width animates unless motion is reduced', async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            const durationWith = async ({ bodyClass }) => page.evaluate((reducedClass) => {
                const shell = document.getElementById('sheld');
                shell.removeAttribute('data-sb-home');
                document.body.classList.toggle('reduced-motion', reducedClass);
                const style = getComputedStyle(shell);
                const result = { property: style.transitionProperty, duration: style.transitionDuration };
                shell.setAttribute('data-sb-home', 'on');
                return result;
            }, bodyClass);

            const animated = await durationWith({ bodyClass: false });
            const withBodyClass = await durationWith({ bodyClass: true });
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const withMediaQuery = await durationWith({ bodyClass: false });

            expect(animated.property).toBe('width');
            expect(animated.duration).not.toBe('0s');
            expect(withBodyClass.duration).toBe('0s');
            expect(withMediaQuery.duration).toBe('0s');
        });

        test('opening a chat starts a width transition of the shared duration', async ({ page }) => {
            const characters = await pickCharacters(page, 1);
            expect(characters).toHaveLength(1);
            await renderHome(page, recentChatEntries(characters, 1));
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await page.evaluate(() => {
                document.body.classList.remove('reduced-motion');
                const shell = document.getElementById('sheld');
                const observer = new MutationObserver(() => {
                    if (shell.hasAttribute('data-sb-home')) return;
                    observer.disconnect();
                    window.qaTransitions = shell.getAnimations()
                        .filter(animation => animation.transitionProperty === 'width')
                        .map(animation => animation.effect.getComputedTiming().duration);
                });
                observer.observe(shell, { attributes: true, attributeFilter: ['data-sb-home'] });
            });

            await page.locator('.welcomePanel .recentChat button.recentChatOpen').first().click();
            await dismissOpenDialogIfPresent(page);
            await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/, { timeout: STARTUP_TIMEOUT });

            expect(await page.evaluate(() => window.qaTransitions)).toEqual([250]);
        });

        test('a MovingUI shell that the user moved or resized keeps its own width on Home', async ({ page }) => {
            const chatWidth = await measureConfiguredChatWidth(page);
            const widths = await page.evaluate(() => {
                const shell = document.getElementById('sheld');
                const read = () => ({
                    width: Math.round(shell.getBoundingClientRect().width),
                    widened: getComputedStyle(shell).getPropertyValue('--sb-home-widened').trim(),
                });
                document.body.classList.add('movingUI');
                const withoutSavedGeometry = read();
                shell.style.setProperty('margin', 'unset', 'important');
                shell.style.setProperty('width', '700px', 'important');
                const withSavedGeometry = read();
                shell.style.removeProperty('margin');
                shell.style.removeProperty('width');
                document.body.classList.remove('movingUI');
                return { withoutSavedGeometry, withSavedGeometry };
            });

            expect(widths.withoutSavedGeometry).toEqual({ width: HOME_SHELL_WIDTH, widened: '1' });
            expect(widths.withSavedGeometry).toEqual({ width: 700, widened: '' });
            expect(chatWidth).toBeLessThan(HOME_SHELL_WIDTH);
        });

        test('a docked side panel stays beside the wider shell, and again after Home ends', async ({ page }) => {
            const characters = await pickCharacters(page, 1);
            expect(characters).toHaveLength(1);
            await page.evaluate(async () => {
                const source = document.createElement('section');
                source.id = 'qa-home-side-panel';
                const control = document.createElement('button');
                control.textContent = 'Panel control';
                source.append(control);
                document.getElementById('movingDivs').append(source);
                const sidePanels = await import('/scripts/sillybunny-editor/side-panel.js');
                window.qaSidePanel = sidePanels.registerSidePanel({ id: 'qa-home-side-panel', element: source, title: 'Test Panel', defaultSide: 'left' });
                await window.qaSidePanel.open({ opener: document.body });
            });
            const panelSelector = '.sb-side-panel[data-sb-side-panel-id="qa-home-side-panel"]';
            const gaps = async () => {
                const panel = await measure(page, panelSelector);
                const shell = await measure(page, '#sheld');
                return { panelRight: panel.right, shellLeft: shell.left, shellRight: shell.right, shellWidth: shell.width, windowWidth: page.viewportSize().width };
            };

            await expect.poll(async () => (await gaps()).shellWidth, { timeout: 5000 }).toBeGreaterThan(0);
            await expect.poll(async () => {
                const { panelRight, shellLeft } = await gaps();
                return shellLeft - panelRight;
            }, { timeout: 5000 }).toBeGreaterThanOrEqual(-1);
            const onHome = await gaps();
            expect(onHome.shellRight).toBeLessThanOrEqual(onHome.windowWidth + 1);
            expect(Math.round(onHome.shellWidth)).toBeLessThanOrEqual(HOME_SHELL_WIDTH);
            expect(onHome.shellWidth, 'the docked shell uses the Home width while the window has room').toBeGreaterThan(await measureConfiguredChatWidth(page) + 2);

            await renderHome(page, recentChatEntries(characters, 1));
            await page.locator('.welcomePanel .recentChat button.recentChatOpen').first().click();
            await dismissOpenDialogIfPresent(page);
            await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/, { timeout: STARTUP_TIMEOUT });
            const chatWidth = await measureConfiguredChatWidth(page);

            await expect.poll(async () => Math.round((await gaps()).shellWidth), { timeout: 5000 }).toBe(Math.round(chatWidth));
            const afterHome = await gaps();
            expect(afterHome.shellLeft - afterHome.panelRight).toBeGreaterThanOrEqual(-1);
        });

        for (const [target, expectedColumns] of [[1023, 1], [1024, 2]]) {
            test(`a Home content width of exactly ${target}px is ${expectedColumns} column${expectedColumns === 1 ? '' : 's'}`, async ({ page }) => {
                await chooseMode(page, 'full');
                const scrollbar = await page.evaluate(() => {
                    const shell = document.getElementById('sheld');
                    shell.style.setProperty('width', '1100px', 'important');
                    return shell.getBoundingClientRect().width - document.querySelector('#chat > .welcomePanel').getBoundingClientRect().width;
                });

                await page.evaluate((width) => document.getElementById('sheld').style.setProperty('width', `${width}px`, 'important'), target + scrollbar);

                const panel = await measure(page, '#chat > .welcomePanel');
                const lefts = await page.evaluate(ids => ids.map(id => Math.round(document.querySelector(`.welcomePanel [data-sb-home-region="${id}"]`).getBoundingClientRect().left)), REGION_DOM_ORDER);
                expect(panel.width).toBe(target);
                expect(new Set(lefts).size).toBe(expectedColumns);
            });
        }
    });
}

test.describe('Home while its template loads', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('Home waits for the shared row styles and shows once they arrive', async ({ page }) => {
        await protectMaintainerServer(page);
        let releaseSheet = () => {};
        const sheetGate = new Promise((resolve) => { releaseSheet = resolve; });
        let sheetRequested = false;
        await page.route('**/sillybunny-editor-shell.css*', async (route) => {
            sheetRequested = true;
            await sheetGate;
            await route.continue();
        });
        const templateRequest = page.waitForRequest('**/scripts/templates/sillybunnyHome.html*', { timeout: STARTUP_TIMEOUT });

        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await templateRequest;
        await expect.poll(() => sheetRequested, { timeout: STARTUP_TIMEOUT }).toBe(true);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));

        await expect(page.locator('#chat > .welcomePanel')).toHaveCount(0);

        releaseSheet();
        await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
        await expect(page.locator('#chat > .welcomePanel .ds-row--activatable').first()).toBeVisible();
    });

    test('Home still appears when the shared row styles fail to load', async ({ page }) => {
        await protectMaintainerServer(page);
        await page.route('**/sillybunny-editor-shell.css*', route => route.abort());
        const warnings = [];
        page.on('console', (message) => {
            if (message.type() === 'warning') warnings.push(message.text());
        });

        await page.goto('/', { waitUntil: 'domcontentloaded' });

        await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
        await expect(page.locator('#chat > .welcomePanel [data-sb-home-region="recent-chats"]')).toBeVisible();
        await expect.poll(() => warnings.some(text => text.includes('shared row styles for Home'))).toBe(true);
    });

    test('a chat that opens during the first template request is not covered by the Home panel', async ({ page }) => {
        await protectMaintainerServer(page);
        await page.route('**/api/chats/save', route => route.fulfill({ status: 200, json: {} }));
        let releaseTemplate = () => {};
        const templateGate = new Promise((resolve) => { releaseTemplate = resolve; });
        let templateRequested = false;
        await page.route('**/scripts/templates/sillybunnyHome.html*', async (route) => {
            templateRequested = true;
            await templateGate;
            await route.continue();
        });

        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.SillyTavern?.getContext?.().characters?.some(character => character?.avatar && character.chat), undefined, { timeout: STARTUP_TIMEOUT });
        await expect.poll(() => templateRequested, { message: 'the Home template request is held while the chat opens', timeout: STARTUP_TIMEOUT }).toBe(true);
        await page.evaluate(async () => {
            const { characters, selectCharacterById } = await import('/script.js');
            await selectCharacterById(characters.findIndex(character => character?.avatar && character.chat));
        });
        await dismissOpenDialogIfPresent(page);
        await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId() !== undefined)).toBe(true);

        releaseTemplate();
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));

        await expect(page.locator('#chat > .welcomePanel')).toHaveCount(0);
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/);
    });
});
