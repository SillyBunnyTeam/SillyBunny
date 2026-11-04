import { expect, test as base } from '@playwright/test';
import { openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { EXTRA_DESCRIPTIONS, HOME_COPY, STEP_BODIES } from './helpers/copy-home.js';
import { ABOUT_COPY, SHORTCUTS_COPY } from './helpers/copy-about.js';
import { WELCOME_COPY } from './helpers/copy-welcome.js';
import { visiblePageClose } from './helpers/dialog-pages.js';
import { PINNED_ASSISTANT_ACCOUNT } from './helpers/assistant-library.js';
import { installFixtureChats } from './helpers/fixture-chats.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer, showToasts } from './helpers/maintainer-server.js';
import { ABOUT_LOGO, expectRealLogo } from './helpers/logo.js';
import { sizeFreeTestFor } from './helpers/matrix.js';
import { fetchBodyOrSkip, fetchJsonOrSkip } from './helpers/route-fetch.js';

// A describe whose tests assert how many Getting Started steps are finished sets this, so the library holds only the cards that ship with SillyBunny.
const test = base.extend({ bundledCardsOnly: [false, { option: true }] });

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
const SECTION_IDS = [
    'getting-around', 'models-and-connections', 'presets-and-prompts', 'characters-and-personas', 'world-info', 'chatting',
    'modes', 'agents', 'extensions-and-themes', 'search', 'data-and-importing', 'troubleshooting',
];
const FEATURED_IDS = ['connect-to-a-model', 'choose-a-preset', 'add-a-character', 'start-a-chat'];
const FEATURED_TITLES = ['Connect to a Model', 'Choose a Preset', 'Add a Character', 'Start a Chat'];
const STEP_TITLES = ['Connect a Model', 'Set Up a Preset', 'Get a Character Card', 'Start Chatting'];
// Artists and Translators have no names, so the page leaves them out.
const CREDIT_GROUPS = ['Developers', 'Designers', 'Documenters', 'Acknowledgements'];
const CREDIT_NAMES = ['Geechan', 'TheLonelyDevil', 'voldomero'];
const ACKNOWLEDGEMENTS = [
    { title: 'purachina', subtitle: 'For initially creating and contributing to the program' },
    { title: 'ZUN', subtitle: 'For Reisen and Tewi from the Touhou Project' },
    { title: 'RivelleDays', subtitle: 'For the usage of Moonlit Echoes\' chat styles' },
    { title: 'Cohee, Wolfsblvt and RossAscends', subtitle: 'For their work on SillyTavern, without which SillyBunny wouldn\'t be possible' },
    { title: 'Other SillyTavern contributors', subtitle: null },
];
const CONTRIBUTORS_URL = 'https://github.com/SillyTavern/SillyTavern/graphs/contributors';
const LEGAL_GROUPS = ['Fan Work', 'Art Licence', 'Third-Party Software'];
const EXTRAS_GROUPS = ['First-Party Extensions', 'Third-Party Extensions', 'Themes', 'Presets'];
const EXTRAS_ITEMS = [
    'Alternate Descriptions', 'Bot Searcher', 'CSS Snippets', 'Deep Swipe', 'Macro Enhanced', 'Prompt Tags', 'Prompting Lab',
    'Regex Agent Themes', 'Time Machine', 'World Info Lab',
    'Dialogue Colors', 'Summary Sharder', 'Group Chat Overhaul', 'LALib',
    'Moonlit Echoes', 'Terminal UI',
    'Geechan - Universal Roleplay (v5.2)', 'TLD Card Conversion Preset',
];
/** What each Getting Started step opens, as a check that holds however often the target is opened. */
const STEP_TARGETS = [
    { title: 'Connect a Model', check: page => expect(page.getByRole('tab', { name: 'Connections', selected: true })).toBeVisible() },
    { title: 'Set Up a Preset', check: page => expect(page.getByRole('tab', { name: 'Presets', selected: true })).toBeVisible() },
    { title: 'Get a Character Card', check: page => expect(page.getByRole('tab', { name: 'Characters', selected: true })).toBeVisible() },
    { title: 'Start Chatting', check: page => expect(page.locator('#sb-mode-menu')).toBeVisible() },
];

const menuButton = page => page.locator('#chat > .welcomePanel .sbHomeMenuButton');
const helpTile = page => page.locator('#chat > .welcomePanel .sbHomeTile[data-sb-home-key="help"]');
const homeTile = (page, key) => page.locator(`#chat > .welcomePanel .sbHomeTile[data-sb-home-key="${key}"]`);
const chooseAssistant = page => page.locator('#chat > .welcomePanel .sbHomeCard--choose .sbHomeCardOpen');
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

async function openFromTile(page, key) {
    await homeTile(page, key).click();
    const host = hosts(page);
    await expect(host).toBeVisible();
    return host;
}

async function renderHomeAgain(page) {
    await page.evaluate(async () => {
        const { openWelcomeScreen } = await import('/scripts/welcome-screen.js');
        await openWelcomeScreen({ force: true });
    });
    await expectHome(page);
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

const MIN_CONTENT = 360;
const ART_GAP = 16;

/**
 * The most rows that a banner shows on a viewport of this height at 1x, written down by hand: 30% of the height, less
 * the 12px above the art, at one CSS pixel per row.
 */
const BANNER_ROW_LIMITS = { 844: 241, 640: 180 };

/**
 * One pixel placement of the art of a window: hidden from assistive technology, with its file loaded, as wide as its
 * art at the fixed step of the screen, and as tall as the whole figure in a panel or as its crop in a banner.
 * @returns {Promise<'panel' | 'banner'>} The mode that the art is shown in.
 */
async function expectArt(scope, id) {
    const figure = scope.locator(`.sbArtPanel > [data-sb-art-placeholder="${id}"]`);
    await expect(figure).toBeVisible();
    await expect(figure.locator('xpath=..')).toHaveAttribute('aria-hidden', 'true');
    await expect(figure.locator('img')).toHaveAttribute('alt', '');
    await expect.poll(() => figure.locator('img').evaluate(image => image.complete && image.naturalWidth), `the file of ${id} loads`).toBeGreaterThan(0);
    const read = await figure.evaluate(async (node, name) => {
        const { getPixelArt } = await import('/scripts/sillybunny-home/art-sources.js');
        const art = getPixelArt(name);
        const image = node.firstElementChild;
        return {
            mode: node.parentElement.dataset.sbArtMode,
            box: [node.offsetWidth, node.offsetHeight],
            file: [image.naturalWidth, image.naturalHeight],
            art: [art.width, art.height],
            ratio: devicePixelRatio,
            viewportHeight: innerHeight,
            rendering: getComputedStyle(image).imageRendering,
        };
    }, id);
    // A banner is the top 62% of the figure, and at most 30% of the viewport height with the 12px above the art.
    const step = Math.max(1, Math.round(read.ratio));
    const bannerLimit = BANNER_ROW_LIMITS[read.viewportHeight];
    if (read.mode === 'banner') {
        expect(bannerLimit, `the table knows the banner of a ${read.viewportHeight}px viewport`).toBeDefined();
    }
    const rows = read.mode === 'banner' ? Math.min(Math.floor(read.art[1] * 0.62), bannerLimit) : read.art[1];
    const expected = [(read.art[0] * step) / read.ratio, (rows * step) / read.ratio];
    expect(read.file, `the file of ${id} is its art size`).toEqual(read.art);
    expect(Math.abs(read.box[0] - expected[0]), `${id} is ${expected[0]}px wide`).toBeLessThanOrEqual(1);
    expect(Math.abs(read.box[1] - expected[1]), `${id} is ${expected[1]}px tall in a ${read.mode}`).toBeLessThanOrEqual(1);
    expect(read.rendering).toBe('pixelated');
    return read.mode;
}

/**
 * An art-and-text intro. The art is a panel at the inline start beside the whole body of the window, or a banner above
 * it. The panel and the line are direct children of the same body, so the rules for the children of a body apply to
 * both. Beside a panel the line starts the content column, which keeps at least 360px; below a banner it is the first
 * line of the body.
 */
async function expectIntro(scope, artName, { slot, text, rtl = false }) {
    const mode = await expectArt(scope, artName);
    const line = text === undefined ? scope.locator(`.sbArtLine[data-sb-copy-slot="${slot}"]`) : scope.locator('.sbArtLine', { hasText: text });
    await expect(line).toHaveCount(1);
    if (text === undefined) {
        await expect(line).toHaveAttribute('data-sb-copy-placeholder', 'true');
        await expect(line).toHaveText(COPY_PLACEHOLDER);
    } else {
        await expect(line).toHaveText(text);
        await expect(line).not.toHaveAttribute('data-sb-copy-placeholder', /.*/);
        await expect(line).not.toHaveAttribute('data-sb-copy-slot', /.*/);
    }
    const layout = await line.evaluate((node) => {
        const box = element => element.getBoundingClientRect();
        const host = node.parentElement;
        const panel = [...host.children].find(child => child.classList.contains('sbArtPanel'));
        const art = box(panel.querySelector('[data-sb-art-placeholder]'));
        const text = box(node);
        return {
            sameParent: Boolean(panel),
            mode: panel.dataset.sbArtMode,
            host: { left: box(host).left, right: box(host).right },
            panel: { left: box(panel).left, right: box(panel).right, top: box(panel).top, bottom: box(panel).bottom },
            art: { left: art.left, right: art.right, top: art.top, bottom: art.bottom },
            text: { left: text.left, right: text.right, top: text.top, bottom: text.bottom, width: text.width },
            em: Number.parseFloat(getComputedStyle(node).fontSize),
            rtl: getComputedStyle(node).direction === 'rtl',
        };
    });
    expect(layout.sameParent, 'the panel and the line are children of one body').toBe(true);
    expect(layout.mode).toBe(mode);
    expect(layout.rtl).toBe(rtl);
    if (layout.mode === 'panel') {
        const gap = rtl ? layout.panel.left - layout.text.right : layout.text.left - layout.panel.right;
        expect(gap, 'the line is beside the panel, a gap away').toBeGreaterThanOrEqual(ART_GAP - 1);
        expect(layout.text.width, 'the content column keeps its width').toBeGreaterThanOrEqual(MIN_CONTENT - 1);
        expect(Math.abs(layout.text.top - layout.panel.top), 'the line starts at the top of the panel').toBeLessThanOrEqual(1);
        const inset = rtl ? layout.host.right - layout.panel.right : layout.panel.left - layout.host.left;
        expect(inset, 'the panel is at the inline start edge').toBeLessThanOrEqual(20);
    } else {
        expect(layout.text.top, 'the line is below the banner').toBeGreaterThanOrEqual(layout.panel.bottom - 1);
        expect(layout.panel.right - layout.panel.left, 'the banner spans the body').toBeGreaterThanOrEqual(layout.text.width - 1);
    }
    return layout;
}

/** How far the line of the intro starts from the first boxed list of the page, which it should share a content edge with. */
async function readIntroOffsetFromList(scope) {
    const [intro, list] = await Promise.all([
        scope.locator('.sbArtLine').evaluate(node => node.getBoundingClientRect().left),
        scope.locator('.ds-pref-group').first().evaluate(node => node.getBoundingClientRect().left),
    ]);
    return Math.abs(intro - list);
}

/**
 * The pair of characters on the About page and what stays in the header: one panel holds both at one step, the logo
 * and the name stay in the content.
 */
async function readAboutArt(host) {
    return host.evaluate(async (root) => {
        const { getPixelArt } = await import('/scripts/sillybunny-home/art-sources.js');
        const rect = (node) => {
            const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
            return { left, right, top, bottom, width, height, centre: (left + right) / 2 };
        };
        const page = root.querySelector('.sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving)');
        const body = page.querySelector('.sb-dialog__body');
        const panel = page.querySelector('.sbArtPanel');
        const figure = name => panel.querySelector(`[data-sb-art-placeholder="${name}"]`);
        return {
            mode: panel.dataset.sbArtMode,
            ariaHidden: panel.getAttribute('aria-hidden'),
            panel: rect(panel),
            reisen: rect(figure('about-reisen')),
            tewi: rect(figure('about-tewi')),
            native: { reisen: getPixelArt('about-reisen'), tewi: getPixelArt('about-tewi') },
            inPanel: [...panel.querySelectorAll('[data-sb-art-placeholder]')].map(node => node.dataset.sbArtPlaceholder),
            logo: rect(page.querySelector('.sbAboutHeader .sbAboutLogo')),
            name: rect(page.querySelector('.sbAboutName')),
            header: rect(page.querySelector('.sbAboutHeader')),
            body: rect(body),
            panelIsChildOfBody: panel.parentElement === body,
            scrollsSideways: body.scrollWidth > body.clientWidth,
            ratio: devicePixelRatio,
        };
    });
}

async function expectAboutPair(host, { rtl = false } = {}) {
    await expectRealLogo(host.locator('.sbAboutLogo'), ABOUT_LOGO);
    const mode = await expectArt(host, 'about-reisen');
    await expectArt(host, 'about-tewi');
    const art = await readAboutArt(host);
    const cssSize = artPixels => (artPixels * Math.max(1, Math.round(art.ratio))) / art.ratio;

    expect(art.inPanel, 'both characters are in one panel, in this order').toEqual(['about-reisen', 'about-tewi']);
    expect(art.panelIsChildOfBody).toBe(true);
    expect(art.ariaHidden).toBe('true');
    expect(art.mode).toBe(mode);
    // Both figures are drawn at one step, so Tewi is shorter than Reisen by the ratio of their pictures.
    expect(art.tewi.width / art.reisen.width).toBeCloseTo(art.native.tewi.width / art.native.reisen.width, 2);
    if (mode === 'panel') {
        expect(art.tewi.height / art.reisen.height).toBeCloseTo(art.native.tewi.height / art.native.reisen.height, 2);
        expect(art.reisen.height).toBeCloseTo(cssSize(art.native.reisen.height), 0);
        expect(Math.abs(art.reisen.bottom - art.tewi.bottom), 'they stand on one edge').toBeLessThanOrEqual(1);
        expect(art.tewi.top, 'Tewi is shorter, so her head is lower').toBeGreaterThan(art.reisen.top + 1);
        expect(art.header.left, 'the header is in the content column, beside the panel').toBeGreaterThanOrEqual(rtl ? art.body.left : art.panel.right);
    } else {
        expect(art.header.top, 'the header is below the banner').toBeGreaterThanOrEqual(art.panel.bottom - 1);
    }
    expect(rtl ? art.tewi.centre < art.reisen.centre : art.reisen.centre < art.tewi.centre, 'Reisen is first, on the start side').toBe(true);
    expect(art.panel.left >= art.body.left - 1 && art.panel.right <= art.body.right + 1, 'the art is inside the body').toBe(true);
    expect(art.logo.top, 'the logo is in the header, above the name').toBeLessThan(art.name.top);
    expect(Math.abs(art.logo.centre - (art.header.left + art.header.right) / 2), 'the logo is centred in the header').toBeLessThanOrEqual(1);
    expect(art.scrollsSideways).toBe(false);
    return art;
}

async function readVersion(page) {
    return page.evaluate(() => fetch('/version').then(response => response.json()));
}

const helpSidebar = host => host.locator('.sb-list-editor__sidebar');
const exactText = text => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
/** The boxed row of a list that carries the label, whatever description or icon sits beside it. */
const rowByLabel = (scope, label) => scope.locator('button.ds-row').filter({ has: scope.page().locator('.ds-row-label', { hasText: exactText(label) }) });

/** The computed value of custom properties, resolved the way an element would see them. */
const readToken = (page, names) => page.evaluate((properties) => {
    const probe = document.createElement('div');
    document.body.append(probe);
    const values = Object.fromEntries(properties.map((name) => {
        probe.style.backgroundColor = '';
        probe.style.color = '';
        probe.style.backgroundColor = `var(${name})`;
        return [name, getComputedStyle(probe).backgroundColor];
    }));
    probe.remove();
    return values;
}, names);

const aboutRow = (host, field) => host.locator(`[data-sb-editor-field="${field}"]`);

/** The test data turns the reduced-motion setting on, which would skip every spring. */
async function useMotion(page) {
    await page.route('**/api/settings/get', async route => {
        const fetched = await fetchBodyOrSkip(route, response => response.json());
        if (!fetched) return;
        const { response, body: data } = fetched;
        const settings = JSON.parse(data.settings);
        settings.power_user.reduced_motion = false;
        applyHomeTestSettings(settings);
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
    // `test` below depends on the size of the window or follows a branch of it; `sizeFreeTest` does not.
    const sizeFreeTest = sizeFreeTestFor(test, options.viewport);
    // A phone shows each Help page as a pushed page, and a desktop shows it beside the sections.
    const helpView = host => (sheet ? shownPage(host) : host.locator('.sb-list-editor__detail')).locator('.sbHelpPage');
    const helpTitle = host => (sheet ? shownPage(host).locator('.sb-dialog__title') : host.locator('.sb-list-editor__detail .sbHelpPageTitle'));
    const showIndex = async (host) => {
        if (sheet) {
            await rowByLabel(helpSidebar(host), 'Overview').click();
        }
    };
    const showSection = (host, title) => rowByLabel(helpSidebar(host), title).click();
    /** A point on the backdrop: above the sheet on a phone, left of the dialog on a desktop. */
    const BACKDROP = sheet ? { x: 195, y: 40 } : { x: 40, y: 450 };
    const showSectionFromIndex = (host, title) => rowByLabel(helpView(host).getByRole('group', { name: 'All Sections' }), title).click();

    test.describe(`Home windows at ${name}`, () => {
        test.use(options);

        test.beforeEach(async ({ page, bundledCardsOnly }) => {
            await protectMaintainerServer(page);
            // The third assistant card is Choose Assistant only while the account has no assistant of its own.
            await installFixtureChats(page, { bundledCardsOnly, accountStorage: PINNED_ASSISTANT_ACCOUNT });
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

            if (menuItem !== 'Show Welcome') {
                sizeFreeTest(`${menuItem} closes with Escape and gives focus back to the main menu button`, async ({ page }) => {
                    await openFromMenu(page, menuItem);

                    await page.keyboard.press('Escape');

                    await expectClosed(page);
                    await expect(menuButton(page)).toBeFocused();
                });
            }
        }

        for (const { menuItem } of WINDOWS.filter(entry => entry.menuItem !== 'Show Welcome')) {
            sizeFreeTest(`${menuItem} closes with its Close button and gives focus back to the main menu button`, async ({ page }) => {
                const host = await openFromMenu(page, menuItem);

                await (await visiblePageClose(host)).click();

                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });
        }

        test.describe('Welcome', () => {
            test.use({ bundledCardsOnly: true });

            test('page one greets with the duo art, its written lines, and the adopted language select', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');

                await expectIntro(host, 'welcome-both', { text: WELCOME_COPY.greeting });
                await expect(host.locator('.sbWelcomeIntro p')).toHaveText([WELCOME_COPY.about, WELCOME_COPY.fork]);
                await expect(host.locator('.sbWelcomeNote')).toHaveText(WELCOME_COPY.fanWork);
                await expect(host.getByRole('button', { name: 'Import From SillyTavern' })).toContainText(WELCOME_COPY.importRow);
                await expect(host.locator('.sbArtLine'), 'only the greeting is the line of the art').toHaveCount(1);
                expect(await readCopyPlaceholders(host), 'page one has no placeholder left').toEqual([]);
                const below = await host.evaluate((root) => {
                    const greeting = root.querySelector('.sbArtLine').getBoundingClientRect();
                    return [...root.querySelectorAll('.sbWelcomeIntro p')].map(line => line.getBoundingClientRect().top >= greeting.bottom - 1);
                });
                expect(below, 'the about and fork lines stay below the greeting').toEqual([true, true]);
                const prose = await host.evaluate((root) => {
                    const read = (selector) => {
                        const style = getComputedStyle(root.querySelector(selector));
                        return { size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight, color: style.color };
                    };
                    return { greeting: read('.sbArtLine'), about: read('.sbWelcomeIntro p:nth-child(1)'), fork: read('.sbWelcomeIntro p:nth-child(2)') };
                });
                expect(prose.greeting, 'the greeting has the type of the lines below it').toEqual(prose.about);
                expect(prose.fork).toEqual(prose.about);
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

            sizeFreeTest('Close on page one closes the dialog and gives focus back to the main menu button', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');

                await shownPage(host).getByRole('button', { name: 'Close', exact: true }).click();

                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });

            sizeFreeTest('shows no Language row, and says why in the console, when the first-run select is gone', async ({ page }) => {
                const debugLines = [];
                page.on('console', message => message.type() === 'debug' && debugLines.push(message.text()));
                await page.evaluate(() => document.getElementById('onboarding_ui_language_select').remove());

                const host = await openFromMenu(page, 'Show Welcome');

                await expect(host.getByRole('button', { name: 'Import From SillyTavern' })).toBeVisible();
                await expect(host.getByText('Language', { exact: true })).toHaveCount(0);
                expect(debugLines.some(line => line.includes('onboarding_ui_language_select'))).toBe(true);
            });

            sizeFreeTest('the current position dot is told apart by an outline in forced colours', async ({ page }) => {
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

            sizeFreeTest('gives the language select back to its template when the dialog closes', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                await shownPage(host).getByRole('button', { name: 'Close', exact: true }).click();
                await expectClosed(page);

                const home = await page.evaluate(() => {
                    const select = document.getElementById('onboarding_ui_language_select');
                    return { count: document.querySelectorAll('#onboarding_ui_language_select').length, inTemplate: Boolean(select?.closest('#onboarding_template')) };
                });
                expect(home).toEqual({ count: 1, inTemplate: true });
            });

            sizeFreeTest('Next and Back walk the three pages and the position text follows', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                const current = shownPage(host);

                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('Your Persona');
                await expect(current.getByText('Step 2 of 3')).toBeAttached();
                // Show Welcome is a reopen: the persona the account has, and no name to ask for.
                await expect(current.getByRole('textbox', { name: 'Your Name' })).toHaveCount(0);
                await expect(current.getByRole('button', { name: 'Manage Personas' })).toBeVisible();
                await expect(current.locator('.sbArtLine')).toHaveText(WELCOME_COPY.personaPrompt);

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

            test('pages one to three open with their art in the same place, at the inline start, with the page line beside it', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                const current = shownPage(host);
                const place = async () => current.evaluate((node) => {
                    const panel = node.querySelector('.sbArtPanel').getBoundingClientRect();
                    const body = node.querySelector('.sb-dialog__body').getBoundingClientRect();
                    return { top: panel.top - body.top, start: panel.left - body.left };
                });

                await expectIntro(host, 'welcome-both', { text: WELCOME_COPY.greeting });
                const first = await place();
                await current.getByRole('button', { name: 'Next', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('Your Persona');
                await expectIntro(current, 'welcome-persona-tewi', { text: WELCOME_COPY.personaPrompt });
                expect(await readIntroOffsetFromList(current), 'the intro and the first list share a start edge').toBeLessThanOrEqual(1);
                const second = await place();
                await current.getByRole('button', { name: 'Next', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('What’s Next');
                await expectIntro(current, 'welcome-next-reisen', { text: WELCOME_COPY.nextIntro });
                const third = await place();

                expect([second.top, third.top], 'the art starts at the same height on every page').toEqual([first.top, first.top]);
                expect([second.start, third.start], 'and at the same inline start').toEqual([first.start, first.start]);
                await expect(host.locator('.sbArtPanel:visible')).toHaveCount(1);
            });

            sizeFreeTest('the Import page has no art', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');

                await host.getByRole('button', { name: 'Import From SillyTavern' }).click();

                await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Import From SillyTavern');
                await expect(shownPage(host).locator('[data-sb-art-placeholder]')).toHaveCount(0);
            });

            const openWhatsNext = async (page) => {
                const host = await openFromMenu(page, 'Show Welcome');
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('What’s Next');
                return host;
            };
            const glyphOf = node => [...node.classList].find(name => name.startsWith('fa-') && !['fa-solid', 'fa-fw'].includes(name));

            sizeFreeTest('What’s Next lists Getting Started, Help and Bundled Extras as rows that match the Home tiles, and no step rows', async ({ page }) => {
                const host = await openWhatsNext(page);
                const current = shownPage(host);
                const rows = current.locator('[data-sb-welcome-destination]');

                await expect(rows).toHaveCount(3);
                await expect(rows.locator('.ds-row-label')).toHaveText(['Getting Started', 'Help', 'Bundled Extras']);
                await expect(rows).toContainText([HOME_COPY.tileGettingStarted, HOME_COPY.tileHelp, HOME_COPY.tileExtras]);
                await expect(rows.first()).toContainText('0 of 4');
                await expect(rows.locator('.ds-row__chevron')).toHaveCount(3);
                for (const [index, key] of ['getting-started', 'help', 'extras'].entries()) {
                    const row = rows.nth(index);
                    await expect(row).toHaveAttribute('data-sb-welcome-destination', key);
                    const tileGlyph = await homeTile(page, key).locator('.sbHomeTileIcon i').evaluate(glyphOf);
                    expect(await row.locator('.sbWelcomeRowIcon').evaluate(glyphOf), `the ${key} row has the icon of its tile`).toBe(tileGlyph);
                    await expect(row.locator('.sbWelcomeRowIcon')).toHaveAttribute('aria-hidden', 'true');
                    const tileLine = await homeTile(page, key).locator('.sbHomeTileLine').textContent();
                    await expect(row.locator('.ds-row-subtitle'), `the ${key} row says the line of its tile`).toHaveText(tileLine);
                }
                await expect(current.locator('.sbArtLine')).toHaveText(WELCOME_COPY.nextIntro);
                expect(await readCopyPlaceholders(current), 'What\'s Next has no placeholder left').toEqual([]);
                await expect(current.locator('.sbHomeStepRow')).toHaveCount(0);
                await expect(current.getByRole('button', { name: 'Show Me' })).toHaveCount(0);
                await expect(current.getByRole('switch', { name: 'Show at Startup' })).not.toBeChecked();
            });

            sizeFreeTest('the Getting Started row follows the shared progress while What’s Next is open', async ({ page }) => {
                const host = await openWhatsNext(page);
                const progress = shownPage(host).locator('[data-sb-welcome-destination="getting-started"] .sbWelcomeRowProgress');
                const setSkipped = (id, skipped) => page.evaluate(async ([step, value]) => {
                    const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
                    getSharedGettingStartedState().setSkipped(step, value);
                }, [id, skipped]);

                await expect(progress).toHaveText('0 of 4');
                await setSkipped('preset', true);
                await expect(progress).toHaveText('1 of 4');
                await setSkipped('chat', true);
                await expect(progress).toHaveText('2 of 4');
                await setSkipped('preset', false);
                await setSkipped('chat', false);
                await expect(progress).toHaveText('0 of 4');
            });

            /** Opens the dialog through its module, so the test can read how it closed. */
            const openRecordingWelcome = async (page) => {
                await menuButton(page).focus();
                await page.evaluate(async () => {
                    const { openWelcomeDialog } = await import('/scripts/sillybunny-welcome.js');
                    const dialog = await openWelcomeDialog();
                    window.__welcomeClosed = dialog.closed;
                });
                const host = hosts(page);
                await expect(host).toBeVisible();
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('What’s Next');
                return host;
            };

            sizeFreeTest('Start finishes Welcome with the start response and lands on Home', async ({ page }) => {
                const host = await openRecordingWelcome(page);

                await shownPage(host).getByRole('button', { name: 'Start', exact: true }).click();

                await expectClosed(page);
                expect(await page.evaluate(() => window.__welcomeClosed)).toEqual({ response: 'start' });
                await expectHome(page);
                await expect(menuButton(page)).toBeFocused();
            });

            for (const { key, row, title } of [
                { key: 'getting-started', row: 'Getting Started', title: 'Getting Started' },
                { key: 'help', row: 'Help', title: 'Help' },
                { key: 'extras', row: 'Bundled Extras', title: 'Bundled Extras' },
            ]) {
                sizeFreeTest(`the ${row} row finishes Welcome as Start does, opens ${title}, and focus returns to its tile`, async ({ page }) => {
                    const host = await openRecordingWelcome(page);

                    await shownPage(host).locator(`[data-sb-welcome-destination="${key}"]`).click();

                    const opened = hosts(page);
                    await expect(opened).toHaveAccessibleName(title);
                    await expect(opened).toHaveCount(1);
                    expect(await page.evaluate(() => window.__welcomeClosed)).toEqual({ response: 'start' });
                    await expect(page.locator('dialog.sb-dialog-host')).toHaveCount(1);

                    await (await visiblePageClose(opened)).click();

                    await expectClosed(page);
                    await expect(homeTile(page, key)).toBeFocused();
                });
            }

            sizeFreeTest('a destination opens its window with the main menu button as the focus target when Home is not shown', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await page.evaluate(() => document.querySelector('#chat > .welcomePanel [data-sb-home-key="help"]').remove());

                await shownPage(host).locator('[data-sb-welcome-destination="help"]').click();

                const opened = hosts(page);
                await expect(opened).toHaveAccessibleName('Help');
                await (await visiblePageClose(opened)).click();
                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });

            sizeFreeTest('the Getting Started row goes while every step is done or skipped, as its tile does, and comes back with it', async ({ page }) => {
                const host = await openWhatsNext(page);
                const current = shownPage(host);
                const rows = current.locator('[data-sb-welcome-destination]');
                const withState = (action) => page.evaluate(async (name) => {
                    const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
                    const state = getSharedGettingStartedState();
                    if (name === 'skip-all') ['connect', 'preset', 'character', 'chat'].forEach(id => state.setSkipped(id, true));
                    if (name === 'unskip-one') state.setSkipped('chat', false);
                    if (name === 'show') state.setHidden(false);
                }, action);

                await expect(rows.locator('.ds-row-label')).toHaveText(['Getting Started', 'Help', 'Bundled Extras']);
                await withState('skip-all');
                await expect(homeTile(page, 'getting-started')).toHaveCount(0);
                await expect(rows.locator('.ds-row-label')).toHaveText(['Help', 'Bundled Extras']);

                await withState('unskip-one');
                await withState('show');
                await expect(homeTile(page, 'getting-started')).toHaveCount(1);
                await expect(rows.locator('.ds-row-label')).toHaveText(['Getting Started', 'Help', 'Bundled Extras']);
                await expect(rows.first().locator('.sbWelcomeRowProgress')).toHaveText('3 of 4');
            });

            sizeFreeTest('What’s Next opened while every step is resolved lists Help and Bundled Extras only', async ({ page }) => {
                await page.evaluate(async () => {
                    const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
                    ['connect', 'preset', 'character', 'chat'].forEach(id => getSharedGettingStartedState().setSkipped(id, true));
                });

                const host = await openWhatsNext(page);

                await expect(shownPage(host).locator('[data-sb-welcome-destination] .ds-row-label')).toHaveText(['Help', 'Bundled Extras']);
            });

            sizeFreeTest('leaving What’s Next stops following the progress', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                const title = shownPage(host).locator('.sb-dialog__title');
                await page.evaluate(async () => {
                    const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
                    const state = getSharedGettingStartedState();
                    const subscribe = state.subscribe;
                    let live = 0;
                    state.subscribe = (listener) => {
                        live++;
                        const stop = subscribe(listener);
                        return () => { live--; stop(); };
                    };
                    window.__liveListeners = () => live;
                });

                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await expect(title).toHaveText('What’s Next');
                expect(await page.evaluate(() => window.__liveListeners())).toBe(1);

                await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();
                await expect(title).toHaveText('Your Persona');
                await expect.poll(() => page.evaluate(() => window.__liveListeners())).toBe(0);
            });

            sizeFreeTest('Import From SillyTavern pushes a page whose buttons send nothing until there is a folder path or a chosen file', async ({ page }) => {
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
                await expect(current.locator('p', { hasText: WELCOME_COPY.importExplanation })).toHaveCount(1);
                expect(await readCopyPlaceholders(current), 'the import page has no placeholder left').toEqual([]);
                await expect(current.getByRole('textbox', { name: 'Folder Path' })).toBeVisible();
                const importFolder = current.getByRole('button', { name: 'Import Folder', exact: true });
                const importZip = current.getByRole('button', { name: 'Import Backup ZIP', exact: true });
                await expect(importFolder).not.toHaveAttribute('data-sb-stub', /.*/);
                await expect(importZip).not.toHaveAttribute('data-sb-stub', /.*/);
                await importFolder.click();
                await expect(current.getByRole('textbox', { name: 'Folder Path' })).toHaveAttribute('aria-invalid', 'true');
                const chooser = page.waitForEvent('filechooser');
                await importZip.click();
                await chooser;
                expect(imports).toEqual([]);

                await current.getByRole('button', { name: 'Back', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('Welcome');
            });

            sizeFreeTest('Escape pops the Import page, and then does nothing on the first page', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                await host.getByRole('button', { name: 'Import From SillyTavern' }).click();
                await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Import From SillyTavern');

                await page.keyboard.press('Escape');
                await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Welcome');
                await expect(hosts(page)).toHaveCount(1);

                await page.keyboard.press('Escape');
                await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Welcome');
                await expect(hosts(page)).toHaveCount(1);
            });

            sizeFreeTest('Escape on the first page does nothing, and Close is still reached by Tab', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');

                await page.keyboard.press('Escape');
                await page.keyboard.press('Escape');

                await expect(hosts(page)).toHaveCount(1);
                await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Welcome');
                const close = shownPage(host).getByRole('button', { name: 'Close', exact: true });
                await expect(async () => {
                    await page.keyboard.press('Tab');
                    await expect(close).toBeFocused({ timeout: 500 });
                }, 'Tab reaches Close').toPass({ timeout: 10_000 });
                await page.keyboard.press('Enter');
                await expectClosed(page);
            });

            test('a click on the backdrop leaves Welcome open on every page', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                const title = shownPage(host).locator('.sb-dialog__title');
                const clickBackdrop = () => page.mouse.click(BACKDROP.x, BACKDROP.y);

                await clickBackdrop();
                await expect(title).toHaveText('Welcome');
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await expect(title).toHaveText('Your Persona');
                await clickBackdrop();
                await expect(title).toHaveText('Your Persona');
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await expect(title).toHaveText('What’s Next');
                await clickBackdrop();
                await expect(title).toHaveText('What’s Next');
                await expect(hosts(page)).toHaveCount(1);
            });

            test('a swipe down never closes Welcome, and the sheet has no grab handle to invite one', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');
                const box = await surface(host).boundingBox();
                const handle = host.locator('.sb-dialog__handle');

                await expect(handle).toBeHidden();
                const startX = box.x + box.width / 2;
                const startY = box.y + 28;
                await page.mouse.move(startX, startY);
                await page.mouse.down();
                for (let step = 1; step <= 10; step++) {
                    await page.mouse.move(startX, startY + step * 60);
                }
                await page.mouse.up();

                await expect(hosts(page)).toHaveCount(1);
                await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Welcome');
                expect((await surface(host).boundingBox()).y).toBeCloseTo(box.y, 0);
            });

            if (sheet) {
                test('a swipe down on Your Persona and What’s Next neither closes Welcome nor goes back', async ({ page }) => {
                    const host = await openFromMenu(page, 'Show Welcome');
                    const title = shownPage(host).locator('.sb-dialog__title');
                    const swipeDown = async () => {
                        const box = await surface(host).boundingBox();
                        const x = box.x + box.width / 2;
                        const y = box.y + 28;
                        await page.mouse.move(x, y);
                        await page.mouse.down();
                        for (let step = 1; step <= 10; step++) {
                            await page.mouse.move(x, y + step * 60);
                        }
                        await page.mouse.up();
                        return box;
                    };

                    await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                    await expect(title).toHaveText('Your Persona');
                    const persona = await swipeDown();
                    await expect(title).toHaveText('Your Persona');
                    await expect(hosts(page)).toHaveCount(1);
                    expect((await surface(host).boundingBox()).y).toBeCloseTo(persona.y, 0);

                    await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                    await expect(title).toHaveText('What’s Next');
                    const next = await swipeDown();
                    await expect(title).toHaveText('What’s Next');
                    await expect(hosts(page)).toHaveCount(1);
                    expect((await surface(host).boundingBox()).y).toBeCloseTo(next.y, 0);
                    await expect(host.locator('.sb-dialog__handle')).toBeHidden();
                });
            }

            sizeFreeTest('nothing in Welcome says that Escape closes it', async ({ page }) => {
                const host = await openFromMenu(page, 'Show Welcome');

                await expect(host.locator('[aria-keyshortcuts]')).toHaveCount(0);
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await shownPage(host).getByRole('button', { name: 'Next', exact: true }).click();
                await expect(host.locator('[aria-keyshortcuts]')).toHaveCount(0);
            });

            sizeFreeTest('Escape on the Persona and What’s Next pages goes back one page each', async ({ page }) => {
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
            sizeFreeTest('lists General, Editors and Lists, Chat and Formatting, with the Keyboard Shortcuts and Help keys in General', async ({ page }) => {
                const host = await openFromMenu(page, 'Keyboard Shortcuts');

                for (const group of ['General', 'Editors and Lists', 'Chat', 'Formatting']) {
                    await expect(host.getByRole('group', { name: group })).toBeVisible();
                }
                const general = host.getByRole('group', { name: 'General' });
                await expect(general.locator('.ds-row')).toHaveCount(8);
                await expect(general.locator('.ds-row', { hasText: 'Home' }).locator('kbd kbd')).toHaveText(['Ctrl', 'O']);
                await expect(general.locator('.ds-row', { hasText: 'Keyboard Shortcuts' }).locator('kbd kbd')).toHaveText(['Ctrl', '?']);
                await expect(general.locator('.ds-row', { hasText: 'Help' }).locator('kbd kbd')).toHaveText(['F1']);
                await expect(host.getByRole('group', { name: 'Chat' }).locator('.ds-row')).toHaveCount(10);
                await expect(host.getByRole('group', { name: 'Formatting' }).locator('.ds-row')).toHaveCount(5);
            });

            test('opens with Tewi\'s art and her line beside it, above the first group', async ({ page }) => {
                const host = await openFromMenu(page, 'Keyboard Shortcuts');

                await expectIntro(host, 'shortcuts-tewi', { text: SHORTCUTS_COPY.intro });
                expect(await readCopyPlaceholders(host), 'Keyboard Shortcuts has no placeholder left').toEqual([]);
                const layout = await host.evaluate((root) => {
                    const body = root.querySelector('.sb-dialog__body');
                    const panel = body.querySelector('.sbArtPanel');
                    const line = body.querySelector('.sbArtLine');
                    return {
                        panelFirst: body.firstElementChild === panel,
                        lineSecond: body.children[1] === line,
                        above: line.getBoundingClientRect().bottom <= body.querySelector('[role="group"]').getBoundingClientRect().top,
                    };
                });
                expect(layout).toEqual({ panelFirst: true, lineSecond: true, above: true });
                await expect(host.locator('[data-sb-art-placeholder]')).toHaveCount(1);
            });

            sizeFreeTest('lists the save and find shortcuts of the editors and lists', async ({ page }) => {
                const host = await openFromMenu(page, 'Keyboard Shortcuts');
                const editors = host.getByRole('group', { name: 'Editors and Lists' });

                await expect(editors.locator('.ds-row')).toHaveCount(2);
                await expect(editors.locator('.ds-row', { hasText: 'Save' }).locator('kbd kbd')).toHaveText(['Ctrl', 'S']);
                await expect(editors.locator('.ds-row', { hasText: 'Find in List' }).locator('kbd kbd')).toHaveText(['Ctrl', 'F']);
            });
        });

        test.describe('Help', () => {
            test('the front page shows the Reisen art, the intro, the featured topics and all twelve sections', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showIndex(host);
                const view = helpView(host);

                await expect(view).toHaveAttribute('data-sb-help-view', 'index');
                await expectIntro(view, 'help-reisen', { text: HOME_COPY.helpIntro });
                await expectSlots(view, [...FEATURED_IDS.map(id => `HELP-TOPIC-${id}-DESC`), ...SECTION_IDS.map(id => `HELP-SECTION-${id}-DESC`)]);
                await expect(view.getByRole('group', { name: 'Featured Topics' }).locator('.ds-row-label')).toHaveText(FEATURED_TITLES);
                const sections = view.getByRole('group', { name: 'All Sections' });
                await expect(sections.locator('.ds-row-label')).toHaveText(SECTION_TITLES);
                await expect(sections.locator('.sbHelpRowIcon')).toHaveCount(12);
                await expect(view.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
                await expectNoUnmarkedPlaceholder(host);
            });

            test('a section from the sidebar shows the section page with its topics', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');

                await showSection(host, 'Models and Connections');

                const view = helpView(host);
                await expect(view).toHaveAttribute('data-sb-help-view', 'section');
                await expect(helpTitle(host)).toHaveText('Models and Connections');
                await expectSlots(view, ['HELP-SECTION-models-and-connections-DESC', 'HELP-TOPIC-connect-to-a-model-DESC']);
                await expect(view.getByRole('group', { name: 'Models and Connections' }).locator('.ds-row-label')).toHaveText(['Connect to a Model']);
                await expectNoUnmarkedPlaceholder(host);
            });

            test('a section row on the front page shows the same section page', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showIndex(host);

                await rowByLabel(helpView(host), 'Troubleshooting').click();

                await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'section');
                await expect(helpTitle(host)).toHaveText('Troubleshooting');
                await expectSlots(helpView(host), ['HELP-SECTION-troubleshooting-DESC', 'HELP-TOPIC-fix-a-connection-problem-DESC']);
            });

            test('a featured topic row on the front page shows the topic page', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showIndex(host);

                await rowByLabel(helpView(host), 'Start a Chat').click();

                await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'topic');
                await expect(helpTitle(host)).toHaveText('Start a Chat');
                await expectSlots(helpView(host), ['HELP-TOPIC-start-a-chat']);
            });

            test('a topic page has the trail, the body, More Information and See Also', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showSection(host, 'Models and Connections');

                await rowByLabel(helpView(host), 'Connect to a Model').click();

                const view = helpView(host);
                await expect(view).toHaveAttribute('data-sb-help-view', 'topic');
                await expect(helpTitle(host)).toHaveText('Connect to a Model');
                await expect(view.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button')).toHaveText(['Help', 'Models and Connections']);
                await expectSlots(view, ['HELP-TOPIC-connect-to-a-model', 'HELP-SECTION-models-and-connections-DESC', 'HELP-TOPIC-choose-a-preset-DESC', 'HELP-TOPIC-fix-a-connection-problem-DESC']);
                await expect(view.getByRole('group', { name: 'More Information' }).locator('.ds-row-label')).toHaveText(['Models and Connections']);
                await expect(view.getByRole('group', { name: 'See Also' }).locator('.ds-row-label')).toHaveText(['Choose a Preset', 'Fix a Connection Problem']);
                await expectNoUnmarkedPlaceholder(host);
            });

            test('a topic without related topics has no See Also group', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showSection(host, 'Extensions and Themes');

                await rowByLabel(helpView(host), 'Install an Extension').click();

                await expect(helpTitle(host)).toHaveText('Install an Extension');
                await expect(helpView(host).getByRole('group', { name: 'More Information' })).toBeVisible();
                await expect(helpView(host).getByRole('group', { name: 'See Also' })).toHaveCount(0);
            });

            test('the trail goes up to the section page, and from there to the front page', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showSection(host, 'Models and Connections');
                await rowByLabel(helpView(host), 'Connect to a Model').click();
                const trail = () => helpView(host).getByRole('navigation', { name: 'Breadcrumb' });

                await trail().getByRole('button', { name: 'Models and Connections', exact: true }).click();

                await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'section');
                await expect(helpTitle(host)).toHaveText('Models and Connections');

                await rowByLabel(helpView(host), 'Connect to a Model').click();
                await trail().getByRole('button', { name: 'Help', exact: true }).click();

                await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'index');
                await expectIntro(helpView(host), 'help-reisen', { text: HOME_COPY.helpIntro });
            });

            test('the intro line has the type of a paragraph in the dialog body', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showIndex(host);

                await expectIntro(helpView(host), 'help-reisen', { text: HOME_COPY.helpIntro });
                const [line, body] = await page.evaluate((introText) => {
                    const read = (node) => {
                        const style = getComputedStyle(node);
                        return { size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight, color: style.color };
                    };
                    const probe = document.createElement('p');
                    document.querySelector('dialog.sb-dialog-host .sb-dialog__body').append(probe);
                    const result = [read([...document.querySelectorAll('.sbArtLine')].find(node => node.textContent === introText)), read(probe)];
                    probe.remove();
                    return result;
                }, HOME_COPY.helpIntro);

                expect(line.size, 'the line is body text, not the smaller meta size').toBe(body.size);
                expect(line.weight).toBe(body.weight);
                expect(line.lineHeight).toBe(body.lineHeight);
                expect(line.color).toBe(body.color);
            });

            test('the intro starts where the first list of the front page starts', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showIndex(host);

                expect(await readIntroOffsetFromList(helpView(host)), 'the intro and the first list share a start edge').toBeLessThanOrEqual(1);
            });

            test('the front page intro mirrors in a right-to-left page: the art at the start, which is the right', async ({ page }) => {
                await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
                const host = await openFromMenu(page, 'Help');
                await showIndex(host);

                const layout = await expectIntro(helpView(host), 'help-reisen', { text: HOME_COPY.helpIntro, rtl: true });

                // Beside a panel the art is on the right of the line; above it in a banner, the art is higher than the line.
                const atStart = layout.mode === 'panel' ? layout.art.left > layout.text.left : layout.art.top < layout.text.top;
                expect(atStart, 'Reisen is at the start, which is the right, or above her line').toBe(true);
            });

            test('More Information opens the section page', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showSection(host, 'Chatting');
                await rowByLabel(helpView(host), 'Start a Chat').click();

                await rowByLabel(helpView(host).getByRole('group', { name: 'More Information' }), 'Chatting').click();

                await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'section');
                await expect(helpTitle(host)).toHaveText('Chatting');
            });

            test('See Also opens the related topic, which can sit in another section', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showSection(host, 'Models and Connections');
                await rowByLabel(helpView(host), 'Connect to a Model').click();

                await rowByLabel(helpView(host).getByRole('group', { name: 'See Also' }), 'Choose a Preset').click();

                await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'topic');
                await expect(helpTitle(host)).toHaveText('Choose a Preset');
                await expectSlots(helpView(host), ['HELP-TOPIC-choose-a-preset']);
                await expect(helpView(host).getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button')).toHaveText(['Help', 'Presets and Prompts']);
            });

            test('search lists the matching topics by section, and a result opens its topic page', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                const results = helpSidebar(host).locator('[data-sb-help-topic] .ds-row-label');
                const nav = helpSidebar(host).locator('[data-sb-help-nav]');
                await expect(nav).toHaveCount(13);

                await host.locator('.sb-dialog__search-toggle').click();
                const field = host.getByRole('searchbox');

                await field.fill('preset');
                await expect(results).toHaveText(['Choose a Preset']);
                await expect(nav).toHaveCount(0);
                await expect(helpSidebar(host).getByRole('group', { name: 'Presets and Prompts' })).toBeVisible();

                await field.fill('troubleshooting');
                await expect(results).toHaveText(['Fix a Connection Problem']);

                await field.fill('preset');
                await results.first().click();

                await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'topic');
                await expect(helpTitle(host)).toHaveText('Choose a Preset');
            });

            sizeFreeTest('a search without a match shows the status page, and clearing it brings the sections back', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await host.locator('.sb-dialog__search-toggle').click();
                const field = host.getByRole('searchbox');

                await field.fill('zzzz');

                await expect(helpSidebar(host).locator('[data-sb-help-topic]')).toHaveCount(0);
                const status = host.locator('.sb-status-page');
                await expect(status).toBeVisible();
                await expectSlots(status, ['HELP-SEARCH-EMPTY-HEAD', 'HELP-SEARCH-EMPTY-BODY']);

                await field.fill('');
                await expect(helpSidebar(host).locator('[data-sb-help-nav]')).toHaveCount(13);
                await expect(status).toBeHidden();
            });

            sizeFreeTest('the no-match page is not a second live announcement', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await host.locator('.sb-dialog__search-toggle').click();

                await host.getByRole('searchbox').fill('zzzz');

                const status = host.locator('.sb-status-page');
                await expect(status).toBeVisible();
                await expect(status).not.toHaveAttribute('role', /.+/);
            });

            sizeFreeTest('Escape closes an open search first, then the window', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await host.locator('.sb-dialog__search-toggle').click();
                await host.getByRole('searchbox').fill('preset');
                await expect(helpSidebar(host).locator('[data-sb-help-topic]')).toHaveCount(1);

                await page.keyboard.press('Escape');

                await expect(host.getByRole('searchbox')).toBeHidden();
                await expect(helpSidebar(host).locator('[data-sb-help-nav]')).toHaveCount(13);
                await expect(hosts(page)).toHaveCount(1);

                await page.keyboard.press('Escape');

                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });

            test('a topic that is added to a section shows up everywhere without other changes', async ({ page }) => {
                await page.evaluate(async () => {
                    const { getHelpSections } = await import('/scripts/sillybunny-help/topics.js');
                    const { openHelpWindow } = await import('/scripts/sillybunny-help/help-window.js');
                    const getSections = () => {
                        const sections = getHelpSections();
                        sections.find(section => section.id === 'troubleshooting').topics.push({
                            id: 'fix-a-slow-reply',
                            title: 'Fix a Slow Reply',
                            descriptionSlot: 'HELP-TOPIC-fix-a-slow-reply-DESC',
                            bodySlot: 'HELP-TOPIC-fix-a-slow-reply',
                            featured: true,
                            seeAlso: ['fix-a-connection-problem'],
                        });
                        return sections;
                    };
                    await openHelpWindow({ getSections });
                });
                const host = hosts(page);
                await expect(host).toBeVisible();

                await showIndex(host);
                await expect(helpView(host).getByRole('group', { name: 'Featured Topics' }).locator('.ds-row-label')).toHaveText([...FEATURED_TITLES, 'Fix a Slow Reply']);

                await showSectionFromIndex(host, 'Troubleshooting');
                await expect(helpView(host).getByRole('group', { name: 'Troubleshooting' }).locator('.ds-row-label')).toHaveText(['Fix a Connection Problem', 'Fix a Slow Reply']);

                await rowByLabel(helpView(host), 'Fix a Slow Reply').click();
                await expect(helpTitle(host)).toHaveText('Fix a Slow Reply');
                await expectSlots(helpView(host), ['HELP-TOPIC-fix-a-slow-reply']);
                await expect(helpView(host).getByRole('group', { name: 'See Also' }).locator('.ds-row-label')).toHaveText(['Fix a Connection Problem']);
            });

            const OUTLINES = {
                index: sheet ? ['H2 Overview', 'H3 Featured Topics', 'H3 All Sections'] : ['H2 Help', 'H3 Featured Topics', 'H3 All Sections'],
                section: sheet ? ['H2 Models and Connections'] : ['H2 Help', 'H3 Models and Connections'],
                topic: sheet ? ['H2 Connect to a Model', 'H3 More Information', 'H3 See Also'] : ['H2 Help', 'H3 Connect to a Model', 'H4 More Information', 'H4 See Also'],
            };
            const readOutline = host => host.locator('h2, h3, h4, h5, h6').evaluateAll(nodes => nodes
                .filter(node => node.checkVisibility())
                .map(node => `${node.tagName} ${node.textContent.trim()}`));

            test('the headings nest under the title of the window without skipping a level', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showIndex(host);
                await expect.poll(() => readOutline(host)).toEqual(OUTLINES.index);

                await showSectionFromIndex(host, 'Models and Connections');
                await expect.poll(() => readOutline(host)).toEqual(OUTLINES.section);

                await rowByLabel(helpView(host), 'Connect to a Model').click();
                await expect.poll(() => readOutline(host)).toEqual(OUTLINES.topic);
            });

            test('every page is a region named after its title, so a page that takes focus is announced', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showIndex(host);
                await expect(helpView(host)).toHaveAttribute('role', 'region');
                await expect(helpView(host)).toHaveAccessibleName('Overview');

                await showSectionFromIndex(host, 'Models and Connections');
                await expect(helpView(host)).toHaveAttribute('role', 'region');
                await expect(helpView(host)).toHaveAccessibleName('Models and Connections');

                await rowByLabel(helpView(host), 'Connect to a Model').click();
                await expect(helpView(host)).toHaveAttribute('role', 'region');
                await expect(helpView(host)).toHaveAccessibleName('Connect to a Model');
            });

            test('going up with the trail or More Information puts focus on something that has a name', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');
                await showSection(host, 'Chatting');
                await rowByLabel(helpView(host), 'Start a Chat').click();

                await rowByLabel(helpView(host).getByRole('group', { name: 'More Information' }), 'Chatting').click();
                await expect(host.locator(':focus')).toHaveAccessibleName('Chatting');

                await rowByLabel(helpView(host), 'Start a Chat').click();
                await helpView(host).getByRole('button', { name: 'Help', exact: true }).click();
                await expect(host.locator(':focus')).toHaveAccessibleName('Overview');
            });

            sizeFreeTest('the search button is named Search Help, and the Search section keeps its name', async ({ page }) => {
                const host = await openFromMenu(page, 'Help');

                await expect(host.getByRole('button', { name: 'Search Help', exact: true })).toHaveCount(1);
                await expect(host.locator('.sb-dialog__search-toggle')).toHaveAttribute('title', 'Search Help');
                await expect(host.getByRole('button', { name: 'Search', exact: true })).toHaveCount(1);
                await expect(host.getByRole('button', { name: 'Search', exact: true })).toHaveAttribute('data-sb-help-nav', 'search');

                await host.getByRole('button', { name: 'Search Help', exact: true }).click();
                await expect(host.getByRole('searchbox', { name: 'Search Help' })).toBeVisible();
            });

            sizeFreeTest('a model that is not valid is refused, and no window opens', async ({ page }) => {
                const message = await page.evaluate(async () => {
                    const { getHelpSections } = await import('/scripts/sillybunny-help/topics.js');
                    const { openHelpWindow } = await import('/scripts/sillybunny-help/help-window.js');
                    const getSections = () => {
                        const sections = getHelpSections();
                        sections[0].topics[0].seeAlso.push('no-such-topic');
                        return sections;
                    };
                    try {
                        await openHelpWindow({ getSections });
                    } catch (error) {
                        return error.message;
                    }
                    return '';
                });

                expect(message).toContain('no-such-topic');
                await expectClosed(page);
            });

            if (sheet) {
                test('opening at the sections and then widening shows the front page beside them', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);

                    await page.setViewportSize({ width: 1440, height: 900 });

                    await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'index');
                    await expect(helpSidebar(host).locator('[aria-current="page"]')).toHaveText(['Overview']);
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
                });

                test('a section page that is open keeps its place when the window widens', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await showSection(host, 'Chatting');
                    await expect(helpTitle(host)).toHaveText('Chatting');

                    await page.setViewportSize({ width: 1440, height: 900 });

                    await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'section');
                    await expect(host.locator('.sb-list-editor__detail .sbHelpPageTitle')).toHaveText('Chatting');
                    await expect(helpSidebar(host).locator('[aria-current="page"]')).toHaveText(['Chatting']);
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
                });

                test('a search result shows the description of its topic', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await host.locator('.sb-dialog__search-toggle').click();

                    await host.getByRole('searchbox').fill('preset');

                    const description = helpSidebar(host).locator('[data-sb-help-topic] .ds-row-subtitle');
                    await expect(description).toBeVisible();
                    await expect(description).toHaveText('TODO(copy)');
                    await expectSlots(helpSidebar(host), ['HELP-TOPIC-choose-a-preset-DESC']);
                    await expectNoUnmarkedPlaceholder(host);
                });

                test('the sections come first on a phone, with Overview at the top and no topic page yet', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');

                    await expect(host.locator('.sb-list-editor__detail')).toBeHidden();
                    await expect(helpSidebar(host).locator('[data-sb-help-nav]').locator('.ds-row-label')).toHaveText(['Overview', ...SECTION_TITLES]);
                    await expect(helpSidebar(host).locator('[data-sb-art-placeholder]')).toHaveCount(0);
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
                });

                test('Overview pushes the front page, and Back returns to the sections', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');

                    await showIndex(host);
                    await expect(helpTitle(host)).toHaveText('Overview');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(2);

                    await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();
                    await expect(helpTitle(host)).toHaveText('Help');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
                    await expect(rowByLabel(helpSidebar(host), 'Overview')).toBeFocused();
                });

                test('a section and a topic push one page each, and Back pops them one at a time', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await showSection(host, 'Models and Connections');
                    await rowByLabel(helpView(host), 'Connect to a Model').click();
                    await expect(helpTitle(host)).toHaveText('Connect to a Model');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(3);

                    await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();
                    await expect(helpTitle(host)).toHaveText('Models and Connections');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(2);

                    await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();
                    await expect(helpTitle(host)).toHaveText('Help');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
                    await expect(rowByLabel(helpSidebar(host), 'Models and Connections')).toBeFocused();
                });

                test('Escape pops one page per press and then closes the window', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await showSection(host, 'Models and Connections');
                    await rowByLabel(helpView(host), 'Connect to a Model').click();
                    await expect(helpTitle(host)).toHaveText('Connect to a Model');

                    await page.keyboard.press('Escape');
                    await expect(helpTitle(host)).toHaveText('Models and Connections');
                    await page.keyboard.press('Escape');
                    await expect(helpTitle(host)).toHaveText('Help');
                    await expect(hosts(page)).toHaveCount(1);

                    await page.keyboard.press('Escape');
                    await expectClosed(page);
                    await expect(menuButton(page)).toBeFocused();
                });

                test('the section link of the trail agrees with Back', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await showSection(host, 'Models and Connections');
                    await rowByLabel(helpView(host), 'Connect to a Model').click();

                    await helpView(host).getByRole('button', { name: 'Models and Connections', exact: true }).click();

                    await expect(helpTitle(host)).toHaveText('Models and Connections');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(2);
                    await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();
                    await expect(helpTitle(host)).toHaveText('Help');
                });

                test('the Help link of the trail leaves one page above the sections, so Back returns to them', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await showSection(host, 'Models and Connections');
                    await rowByLabel(helpView(host), 'Connect to a Model').click();

                    await helpView(host).getByRole('button', { name: 'Help', exact: true }).click();

                    await expect(helpTitle(host)).toHaveText('Overview');
                    await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'index');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(2);
                    await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();
                    await expect(helpTitle(host)).toHaveText('Help');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
                });

                test('See Also swaps the topic on its page, and Back returns to the page before it', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await showSection(host, 'Models and Connections');
                    await rowByLabel(helpView(host), 'Connect to a Model').click();

                    await rowByLabel(helpView(host).getByRole('group', { name: 'See Also' }), 'Choose a Preset').click();

                    await expect(helpTitle(host)).toHaveText('Choose a Preset');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(3);
                    await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();
                    await expect(helpTitle(host)).toHaveText('Models and Connections');
                });

                test('a search result pushes its topic, and Back returns to the results', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await host.locator('.sb-dialog__search-toggle').click();
                    await host.getByRole('searchbox').fill('preset');

                    await helpSidebar(host).locator('[data-sb-help-topic]').click();
                    await expect(helpTitle(host)).toHaveText('Choose a Preset');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(2);

                    await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();
                    await expect(helpSidebar(host).locator('[data-sb-help-topic] .ds-row-label')).toHaveText(['Choose a Preset']);
                    await expect(host.getByRole('searchbox')).toHaveValue('preset');
                });

                test('Close on a deep page closes the whole window and gives focus back to the Help tile', async ({ page }) => {
                    await helpTile(page).click();
                    const host = hosts(page);
                    await expect(host).toBeVisible();
                    await showSection(host, 'Models and Connections');
                    await rowByLabel(helpView(host), 'Connect to a Model').click();
                    await expect(helpTitle(host)).toHaveText('Connect to a Model');

                    await (await visiblePageClose(host)).click();

                    await expectClosed(page);
                    await expect(helpTile(page)).toBeFocused();
                });
            } else {
                test('the front page that is open keeps its place when the window narrows and widens', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'index');

                    await page.setViewportSize({ width: 390, height: 844 });
                    await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Overview');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(2);

                    await page.setViewportSize({ width: 1440, height: 900 });
                    await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'index');
                    await expect(helpSidebar(host).locator('[aria-current="page"]')).toHaveText(['Overview']);
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
                });

                test('a section page that is open keeps its place when the window narrows and widens', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await showSection(host, 'Chatting');
                    await expect(helpTitle(host)).toHaveText('Chatting');

                    await page.setViewportSize({ width: 390, height: 844 });
                    await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Chatting');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(2);

                    await page.setViewportSize({ width: 1440, height: 900 });
                    await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'section');
                    await expect(helpTitle(host)).toHaveText('Chatting');
                    await expect(helpSidebar(host).locator('[aria-current="page"]')).toHaveText(['Chatting']);
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
                });

                test('a search result keeps its topic as one line, because the open page is beside it', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await host.locator('.sb-dialog__search-toggle').click();

                    await host.getByRole('searchbox').fill('preset');

                    const description = helpSidebar(host).locator('[data-sb-help-topic] .ds-row-subtitle');
                    await expect(description).toBeHidden();
                    await expectSlots(helpSidebar(host), ['HELP-TOPIC-choose-a-preset-DESC']);
                });

                test('the selected row has the neutral selected fill, an accent icon and no stripe', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await showSection(host, 'Models and Connections');
                    const selected = helpSidebar(host).locator('[aria-current="page"]');
                    await expect(selected).toHaveText(['Models and Connections']);
                    await page.mouse.move(2, 2);
                    await selected.evaluate(node => node.blur());

                    const expected = await readToken(page, ['--sb-flat-selected-bg', '--sb-accent']);
                    const actual = await selected.evaluate(node => ({
                        background: getComputedStyle(node).backgroundColor,
                        shadow: getComputedStyle(node).boxShadow,
                        borderLeft: getComputedStyle(node).borderInlineStartWidth,
                        icon: getComputedStyle(node.querySelector('.sbHelpRowIcon')).color,
                        weight: getComputedStyle(node.querySelector('.ds-row-label')).fontWeight,
                    }));
                    const other = await helpSidebar(host).locator('[data-sb-help-nav="chatting"] .ds-row-label').evaluate(node => getComputedStyle(node).fontWeight);

                    expect(actual.background).toBe(expected['--sb-flat-selected-bg']);
                    expect(actual.shadow).toBe('none');
                    expect(actual.borderLeft).toBe('0px');
                    expect(actual.icon).toBe(expected['--sb-accent']);
                    expect(actual.weight).toBe(other);
                });

                test('the selected row keeps a selected fill while the pointer is over it, and the focus ring still shows', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await showSection(host, 'Models and Connections');
                    const selected = helpSidebar(host).locator('[aria-current="page"]');
                    const expected = await readToken(page, ['--sb-flat-selected-hover-bg', '--sb-flat-hover-bg']);

                    await selected.hover();
                    await expect.poll(() => selected.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(expected['--sb-flat-selected-hover-bg']);
                    await helpSidebar(host).locator('[data-sb-help-nav="chatting"]').hover();
                    await expect.poll(() => helpSidebar(host).locator('[data-sb-help-nav="chatting"]').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(expected['--sb-flat-hover-bg']);

                    await page.mouse.move(2, 2);
                    await page.keyboard.press('Shift');
                    await selected.focus();
                    await expect.poll(() => selected.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');
                });

                test('in forced colours the selected row is outlined, and the others are not', async ({ page }) => {
                    await page.emulateMedia({ forcedColors: 'active' });
                    const host = await openFromMenu(page, 'Help');
                    await showSection(host, 'Models and Connections');

                    const outline = row => helpSidebar(host).locator(`[data-sb-help-nav="${row}"]`).evaluate(node => getComputedStyle(node).outlineStyle);

                    expect(await outline('models-and-connections')).toBe('solid');
                    expect(await outline('chatting')).toBe('none');
                });

                test('opens on the front page beside the sections, with Overview selected', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');

                    await expect(host.locator('.sb-list-editor')).toHaveAttribute('data-collapsed', 'false');
                    await expect(helpSidebar(host).locator('[data-sb-help-nav]').locator('.ds-row-label')).toHaveText(['Overview', ...SECTION_TITLES]);
                    await expect(helpSidebar(host).locator('[aria-current="page"]')).toHaveText(['Overview']);
                    await expect(helpView(host)).toHaveAttribute('data-sb-help-view', 'index');
                    await expect(helpSidebar(host).locator('[data-sb-art-placeholder]')).toHaveCount(0);
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
                });

                test('the sidebar follows the page: a section, a topic of another section, and the front page', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    const current = helpSidebar(host).locator('[aria-current="page"]');

                    await rowByLabel(helpView(host).getByRole('group', { name: 'All Sections' }), 'Chatting').click();
                    await expect(current).toHaveText(['Chatting']);

                    await rowByLabel(helpView(host), 'Start a Chat').click();
                    await expect(current).toHaveText(['Chatting']);

                    await rowByLabel(helpView(host).getByRole('group', { name: 'See Also' }), 'Add a Character').click();
                    await expect(helpTitle(host)).toHaveText('Add a Character');
                    await expect(current).toHaveText(['Characters and Personas']);

                    await helpView(host).getByRole('button', { name: 'Help', exact: true }).click();
                    await expect(current).toHaveText(['Overview']);
                });

                test('a click in the sidebar keeps focus on its row, and a click in the page moves focus to the new heading', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');

                    await rowByLabel(helpSidebar(host), 'Models and Connections').click();
                    await expect(rowByLabel(helpSidebar(host), 'Models and Connections')).toBeFocused();

                    await rowByLabel(helpView(host), 'Connect to a Model').click();
                    await expect(helpTitle(host)).toBeFocused();

                    await helpView(host).getByRole('button', { name: 'Models and Connections', exact: true }).click();
                    await expect(helpTitle(host)).toBeFocused();
                    await expect(helpTitle(host)).toHaveText('Models and Connections');
                });

                test('keeps the open topic while the window narrows to pages and widens again', async ({ page }) => {
                    const host = await openFromMenu(page, 'Help');
                    await showSection(host, 'Models and Connections');
                    await rowByLabel(helpView(host), 'Connect to a Model').click();
                    await expect(helpTitle(host)).toHaveText('Connect to a Model');

                    await page.setViewportSize({ width: 390, height: 844 });
                    await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Connect to a Model');
                    await expect(host.locator('.sb-list-editor')).toHaveAttribute('data-open', 'false');
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(3);

                    await page.setViewportSize({ width: 1440, height: 900 });
                    await expect(helpTitle(host)).toHaveText('Connect to a Model');
                    await expect(helpSidebar(host).locator('[aria-current="page"]')).toHaveText(['Models and Connections']);
                    await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
                    await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Help');
                });

                test('Escape on any page closes the window, and focus returns to the Help tile', async ({ page }) => {
                    await helpTile(page).click();
                    const host = hosts(page);
                    await expect(host).toBeVisible();
                    await showSection(host, 'Models and Connections');
                    await rowByLabel(helpView(host), 'Connect to a Model').click();
                    await expect(helpTitle(host)).toHaveText('Connect to a Model');

                    await page.keyboard.press('Escape');

                    await expectClosed(page);
                    await expect(helpTile(page)).toBeFocused();
                });
            }

            sizeFreeTest('activating the Help tile twice opens one window, and it opens again after it closes', async ({ page }) => {
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

            sizeFreeTest('a window that fails to load logs the error, toasts, and can be opened again', async ({ page }) => {
                const errors = [];
                page.on('console', message => message.type() === 'error' && errors.push(message.text()));
                await showToasts(page);
                await page.route('**/scripts/sillybunny-about.js*', route => route.abort());

                await menuButton(page).click();
                await page.getByRole('menuitem', { name: 'About SillyBunny', exact: true }).click();

                const toast = page.locator('#toast-container .toast', { hasText: HOME_COPY.windowLoadError });
                await expect(toast).toBeVisible();
                await expect(hosts(page)).toHaveCount(0);
                expect(errors.some(line => line.includes('Could not open the About window'))).toBe(true);

                await page.unroute('**/scripts/sillybunny-about.js*');
                const host = await openFromMenu(page, 'About SillyBunny');
                await expect(host).toHaveAccessibleName('About SillyBunny');
            });

            sizeFreeTest('the Help tile on Home opens Help, is no longer a stub, and gives focus back to the tile', async ({ page }) => {
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
            test('shows the logo, the name, the developer name and the real version, branch and commit', async ({ page }) => {
                const version = await readVersion(page);
                const host = await openFromMenu(page, 'About SillyBunny');

                await expectRealLogo(host.locator('.sbAboutLogo'), ABOUT_LOGO);
                await expect(host.locator('[data-sb-art-placeholder]')).toHaveCount(2);
                await expect(host.getByRole('heading', { name: 'SillyBunny', exact: true })).toBeVisible();
                await expect(host.locator('.sbAboutDeveloper')).toHaveText('SillyBunnyTeam');
                expect(await readCopyPlaceholders(host), 'the main page has no copy placeholder left').toEqual([]);
                await expect(host.getByText(version.pkgVersion, { exact: false }).first()).toBeVisible();
                await expect(host.getByText(version.gitBranch, { exact: true })).toBeVisible();
                await expect(host.getByText(version.gitRevision, { exact: true })).toBeVisible();
            });

            for (const scale of [1, 2, 3]) {
                test.describe(`at a screen scale of ${scale}`, () => {
                    test.use({ deviceScaleFactor: scale });

                    // eslint-disable-next-line playwright/expect-expect -- The logo has its assertions in `expectRealLogo`.
                    sizeFreeTest('the logo is the file made for the scale, in its 64px box', async ({ page }) => {
                        const host = await openFromMenu(page, 'About SillyBunny');

                        await expectRealLogo(host.locator('.sbAboutLogo'), ABOUT_LOGO);
                    });
                });
            }

            test('puts Reisen and Tewi in one panel, Reisen first, with the logo and the name staying in the content', async ({ page }) => {
                const host = await openFromMenu(page, 'About SillyBunny');

                await expectAboutPair(host);
            });

            test('mirrors the order in a right-to-left page: Reisen on the end side of Tewi', async ({ page }) => {
                await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
                const host = await openFromMenu(page, 'About SillyBunny');

                await expectAboutPair(host, { rtl: true });
            });

            sizeFreeTest('opens at once, shows a stand-in for the branch and commit, and fills them when the server answers', async ({ page }) => {
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

            sizeFreeTest('shows Unknown for the branch and commit when the server does not answer', async ({ page }) => {
                await page.route('**/version', route => route.abort());

                const host = await openFromMenu(page, 'About SillyBunny');

                await expect(aboutRow(host, 'about-branch')).toContainText('Unknown');
                await expect(aboutRow(host, 'about-commit')).toContainText('Unknown');
            });

            sizeFreeTest('Website and Report an Issue are links that open a new tab safely', async ({ page }) => {
                const host = await openFromMenu(page, 'About SillyBunny');

                for (const [name, href] of [['Website', WEBSITE_URL], ['Report an Issue', ISSUES_URL]]) {
                    const link = host.getByRole('link', { name, exact: true });
                    await expect(link).toHaveAttribute('href', href);
                    await expect(link).toHaveAttribute('target', '_blank');
                    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
                }
            });

            sizeFreeTest('What’s New pushes a page with the release notes placeholder', async ({ page }) => {
                const host = await openFromMenu(page, 'About SillyBunny');
                const current = shownPage(host);

                await host.getByRole('button', { name: 'What’s New', exact: true }).click();

                await expect(current.locator('.sb-dialog__title')).toHaveText('What’s New');
                await expectSlots(current, ['AB-RELEASE-NOTES']);
                await current.getByRole('button', { name: 'Back', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('About SillyBunny');
                await expect(host.getByRole('button', { name: 'What’s New', exact: true })).toBeFocused();
            });

            sizeFreeTest('Credits lists its names and the acknowledgements, and Legal pushes labelled groups with their text', async ({ page }) => {
                const host = await openFromMenu(page, 'About SillyBunny');
                const current = shownPage(host);

                await host.getByRole('button', { name: 'Credits', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('Credits');
                await expect(current.getByRole('heading', { level: 3 })).toHaveText(CREDIT_GROUPS);
                await expect(current.getByRole('heading', { name: /^(Artists|Translators)$/ })).toHaveCount(0);
                const section = title => current.locator('.sbWindowSection').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

                for (const title of ['Developers', 'Designers', 'Documenters']) {
                    await expect(section(title).locator('.ds-row-label'), `${title} lists each name as a row, in order`).toHaveText(CREDIT_NAMES);
                    await expect(section(title).getByRole('button'), `${title} rows are not activatable`).toHaveCount(0);
                }

                const acknowledgements = section('Acknowledgements').locator('.ds-row');
                await expect(acknowledgements).toHaveCount(ACKNOWLEDGEMENTS.length);
                for (const [index, { title, subtitle }] of ACKNOWLEDGEMENTS.entries()) {
                    const row = acknowledgements.nth(index);
                    await expect(row.locator('.ds-row-label')).toHaveText(title);
                    await expect(row.locator('.ds-row-subtitle')).toHaveText(subtitle ?? []);
                }
                const contributors = section('Acknowledgements').getByRole('link', { name: 'Other SillyTavern contributors', exact: true });
                await expect(contributors).toHaveAttribute('href', CONTRIBUTORS_URL);
                await expect(contributors).toHaveAttribute('target', '_blank');
                await expect(contributors).toHaveAttribute('rel', 'noopener noreferrer');
                await expect(section('Acknowledgements').getByRole('button')).toHaveCount(0);

                expect(await readCopyPlaceholders(current), 'Credits has no copy placeholder left').toEqual([]);
                await current.getByRole('button', { name: 'Back', exact: true }).click();

                await host.getByRole('button', { name: 'Legal', exact: true }).click();
                await expect(current.locator('.sb-dialog__title')).toHaveText('Legal');
                await expect(current.getByRole('heading', { level: 3 })).toHaveText(LEGAL_GROUPS);
                await expect(current.locator('p')).toHaveText([ABOUT_COPY.fanWork, ABOUT_COPY.artLicence, ABOUT_COPY.thirdParty]);
                expect(await readCopyPlaceholders(current), 'Legal has no placeholder left').toEqual([]);
            });

            test('Troubleshooting opens with Reisen\'s art and her line beside it, above the debug text', async ({ page }) => {
                const host = await openFromMenu(page, 'About SillyBunny');

                await host.getByRole('button', { name: 'Troubleshooting', exact: true }).click();

                const current = shownPage(host);
                await expectIntro(current, 'troubleshooting-reisen', { text: ABOUT_COPY.troubleshootingIntro });
                expect(await readCopyPlaceholders(current), 'Troubleshooting has no placeholder left').toEqual([]);
                const above = await current.evaluate(node => node.querySelector('.sbArtLine').getBoundingClientRect().bottom <= node.querySelector('.sbDebugInfo').getBoundingClientRect().top);
                expect(above).toBe(true);
            });

            test('Troubleshooting shows every line of the debug info without scrolling', async ({ page }) => {
                const host = await openFromMenu(page, 'About SillyBunny');
                await host.getByRole('button', { name: 'Troubleshooting', exact: true }).click();
                const info = shownPage(host).getByRole('textbox', { name: 'Debug Information' });
                await expect(info).toBeVisible();

                const fit = await info.evaluate(node => ({
                    scrollHeight: node.scrollHeight,
                    clientHeight: node.clientHeight,
                    lines: node.value.split('\n').length,
                    lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
                }));
                // Wrapped lines make the block taller than one row per line, never shorter.
                expect(fit.clientHeight).toBeGreaterThanOrEqual(fit.lines * fit.lineHeight);
                expect(fit.scrollHeight).toBeLessThanOrEqual(fit.clientHeight + 1);
            });

            sizeFreeTest('Troubleshooting shows real debug info that Copy puts on the clipboard and Save downloads', async ({ page, context }) => {
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

        test.describe('Getting Started', () => {
            test.use({ bundledCardsOnly: true });

            const rowOf = (host, title) => host.locator('.ds-row', { hasText: title });

            test(`opens from its tile as a dialog${sheet ? ' sheet' : ''} with the progress in the header`, async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');

                await expect(surface(host)).toHaveClass(/\bsb-dialog--dialog\b/);
                await expect(host).toHaveAttribute('data-presentation', sheet ? 'sheet' : 'floating');
                await expect(host).toHaveAccessibleName('Getting Started');
                await expect(host.locator('.sb-dialog__subtitle')).toHaveText('0 of 4');
                await expect(homeTile(page, 'getting-started')).not.toHaveAttribute('data-sb-stub', /.*/);
            });

            test('shows Reisen\'s art and intro, then the four steps with their lines, Show Me and Skip', async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');

                await expectIntro(host, 'gs-reisen', { text: HOME_COPY.gettingStartedIntro });
                await expect(host.locator('.ds-row-subtitle')).toHaveText(Object.values(STEP_BODIES));
                expect(await readCopyPlaceholders(host), 'no placeholder is left in the window').toEqual([]);
                await expect(host.locator('.ds-row-label')).toHaveText([
                    'Connect a Model', 'Set Up a Preset', 'Get a Character Card', 'Start Chatting',
                ]);
                for (const title of STEP_TITLES) {
                    const row = rowOf(host, title);
                    await expect(row.getByRole('button', { name: 'Show Me', exact: true })).toHaveAccessibleDescription(new RegExp(`^${title}`));
                    await expect(row.getByRole('button', { name: 'Skip', exact: true })).toHaveAttribute('aria-pressed', 'false');
                }
                await expect(host.locator('.sbHomeTag:visible')).toHaveText(['Optional']);
            });

            for (const { title, check } of STEP_TARGETS) {
                sizeFreeTest(`Show Me on "${title}" closes the window and opens its target`, async ({ page }) => {
                    const host = await openFromTile(page, 'getting-started');

                    await rowOf(host, title).getByRole('button', { name: 'Show Me', exact: true }).click();

                    await expect(hosts(page)).toHaveCount(0);
                    await check(page);
                });
            }

            test('Reisen shows her done pose once all four steps are skipped, live, and goes back when one is un-skipped', async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');
                await expectIntro(host, 'gs-reisen', { text: HOME_COPY.gettingStartedIntro });

                for (const title of STEP_TITLES) {
                    await expect(host.locator('[data-sb-art-placeholder="gs-reisen-done"]')).toHaveCount(0);
                    await rowOf(host, title).getByRole('button', { name: 'Skip', exact: true }).click();
                }

                await expect(host.locator('.sb-dialog__subtitle')).toHaveText('4 of 4');
                await expectIntro(host, 'gs-reisen-done', { text: HOME_COPY.gettingStartedIntroDone });
                await expect(host.locator('[data-sb-art-placeholder="gs-reisen"]')).toHaveCount(0);
                await expect(host.locator('[data-sb-art-placeholder]')).toHaveCount(1);
                await expect(host.getByText(HOME_COPY.gettingStartedIntro, { exact: true })).toHaveCount(0);

                await rowOf(host, 'Set Up a Preset').getByRole('button', { name: 'Skip', exact: true }).click();

                await expectIntro(host, 'gs-reisen', { text: HOME_COPY.gettingStartedIntro });
                await expect(host.locator('[data-sb-art-placeholder="gs-reisen-done"]')).toHaveCount(0);
                await expect(host.getByText(HOME_COPY.gettingStartedIntroDone, { exact: true })).toHaveCount(0);
            });

            test('Skip marks the step, moves the progress in the window and on the tile, and a second press undoes it', async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');
                const row = rowOf(host, 'Get a Character Card');
                const skip = row.getByRole('button', { name: 'Skip', exact: true });

                await skip.click();

                await expect(skip).toHaveAttribute('aria-pressed', 'true');
                await expect(row.locator('.sbHomeTag:visible')).toHaveText(['Skipped']);
                await expect(host.locator('.sb-dialog__subtitle')).toHaveText('1 of 4');
                await expect(homeTile(page, 'getting-started').locator('.sbHomeTileSub')).toHaveText('1 of 4');

                await skip.click();

                await expect(skip).toHaveAttribute('aria-pressed', 'false');
                await expect(row.locator('.sbHomeTag:visible')).toHaveCount(0);
                await expect(host.locator('.sb-dialog__subtitle')).toHaveText('0 of 4');
                await expect(homeTile(page, 'getting-started').locator('.sbHomeTileSub')).toHaveText('0 of 4');
            });

            const geometry = row => row.evaluate((node) => {
                const top = node.getBoundingClientRect().top;
                const place = selector => node.querySelector(selector).getBoundingClientRect().top - top;
                const notes = node.querySelector('.sbHomeStepNotes');
                const noteBox = notes && !notes.hidden ? notes.getBoundingClientRect() : null;
                return {
                    height: node.getBoundingClientRect().height,
                    title: place('.ds-row-label'),
                    subtitle: place('.ds-row-subtitle'),
                    noteHeight: noteBox?.height ?? 0,
                    noteTags: noteBox ? [...notes.querySelectorAll('.sbHomeTag')].filter(tag => !tag.hidden).map(tag => tag.textContent) : null,
                };
            });

            sizeFreeTest('no row has an empty note line at rest, and only the Set Up a Preset row shows Optional', async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');

                for (const title of STEP_TITLES) {
                    const { noteTags } = await geometry(rowOf(host, title));
                    expect(noteTags, `the note line of ${title}`).toEqual(title === 'Set Up a Preset' ? ['Optional'] : null);
                }
                await expect(host.locator('.sbHomeStepNotes:visible')).toHaveCount(1);
            });

            test('pressing Skip on the Set Up a Preset row never changes its height', async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');
                const row = rowOf(host, 'Set Up a Preset');
                const skip = row.getByRole('button', { name: 'Skip', exact: true });
                const before = await geometry(row);

                await skip.click();
                const skipped = await geometry(row);
                await skip.click();

                expect(skipped.noteTags, 'Skipped joins Optional on one line').toEqual(['Optional', 'Skipped']);
                expect(skipped.height).toBe(before.height);
                expect(skipped.noteHeight).toBe(before.noteHeight);
                expect(await geometry(row)).toEqual(before);
            });

            test('a long translation of Optional does not change the height of the Set Up a Preset row when it is skipped', async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');
                const row = rowOf(host, 'Set Up a Preset');
                await row.locator('.sbHomeTag').first().evaluate((tag) => { tag.textContent = 'Facultatif, vous pouvez le faire plus tard'; });
                const before = await geometry(row);

                await row.getByRole('button', { name: 'Skip', exact: true }).click();

                const skipped = await geometry(row);
                expect(skipped.height).toBe(before.height);
                expect(skipped.noteHeight, 'the notes stay on one line').toBe(before.noteHeight);
                await expect(row.locator('.sbHomeTag:visible')).toHaveCount(2);
            });

            for (const title of STEP_TITLES.filter(name => name !== 'Set Up a Preset')) {
                test(`skipping ${title} adds one note line under the text and takes it away again`, async ({ page }) => {
                    const host = await openFromTile(page, 'getting-started');
                    const row = rowOf(host, title);
                    const skip = row.getByRole('button', { name: 'Skip', exact: true });
                    const before = await geometry(row);

                    await skip.click();
                    const skipped = await geometry(row);
                    await skip.click();
                    const after = await geometry(row);

                    expect(skipped.noteTags).toEqual(['Skipped']);
                    // The text is centred in the row, so it rises by half of what the row gained at most.
                    const rise = before.title - skipped.title;
                    expect(rise, 'the title does not move down').toBeGreaterThanOrEqual(0);
                    expect(rise, 'the title rises by half a note line at most').toBeLessThanOrEqual(skipped.noteHeight / 2 + 0.5);
                    expect(skipped.subtitle - skipped.title, 'the title and the text keep their distance').toBe(before.subtitle - before.title);
                    expect(skipped.height - before.height, 'the row grows by the note line').toBeGreaterThan(0);
                    expect(skipped.height - before.height, 'and by no more than the note line').toBeLessThanOrEqual(skipped.noteHeight);
                    expect(after, 'undoing Skip restores the row').toEqual(before);
                });
            }

            test('a note line never wraps the title or the text of a row', async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');
                const row = rowOf(host, 'Connect a Model');
                await row.getByRole('button', { name: 'Skip', exact: true }).click();

                const lines = await row.locator('.sbHomeStepNotes').evaluate((node) => {
                    const style = getComputedStyle(node);
                    return { whiteSpace: style.whiteSpace, overflow: style.overflow, ellipsis: style.textOverflow, lines: Math.round(node.getBoundingClientRect().height / parseFloat(style.lineHeight)) };
                });
                expect(lines).toEqual({ whiteSpace: 'nowrap', overflow: 'hidden', ellipsis: 'ellipsis', lines: 1 });
            });

            sizeFreeTest('a skipped step stays skipped after Home renders again and the window opens again', async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');
                await rowOf(host, 'Connect a Model').getByRole('button', { name: 'Skip', exact: true }).click();
                await page.keyboard.press('Escape');
                await expectClosed(page);

                await renderHomeAgain(page);
                await expect(homeTile(page, 'getting-started').locator('.sbHomeTileSub')).toHaveText('1 of 4');
                const again = await openFromTile(page, 'getting-started');

                await expect(again.locator('.sb-dialog__subtitle')).toHaveText('1 of 4');
                await expect(rowOf(again, 'Connect a Model').getByRole('button', { name: 'Skip', exact: true })).toHaveAttribute('aria-pressed', 'true');
            });

            sizeFreeTest('a Home that renders while the window is open leaves it open, and the new tile follows the window', async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');

                await renderHomeAgain(page);
                await expect(host).toBeVisible();
                await rowOf(host, 'Start Chatting').getByRole('button', { name: 'Skip', exact: true }).click();

                await expect(host.locator('.sb-dialog__subtitle')).toHaveText('1 of 4');
                await expect(homeTile(page, 'getting-started').locator('.sbHomeTileSub')).toHaveText('1 of 4');
            });

            test('when every step is resolved the tile goes, the other two fill the row, and the window stays open until it is closed', async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');

                for (const title of STEP_TITLES) {
                    await rowOf(host, title).getByRole('button', { name: 'Skip', exact: true }).click();
                }

                await expect(host.locator('.sb-dialog__subtitle')).toHaveText('4 of 4');
                await expect(host).toBeVisible();
                await expect(homeTile(page, 'getting-started')).toHaveCount(0);
                await expect(page.locator('#chat > .welcomePanel .sbHomeTile .sbHomeTileTitle')).toHaveText(['Help', 'Bundled Extras']);
                const widths = await page.locator('#chat > .welcomePanel .sbHomeTile').evaluateAll((tiles) => {
                    const row = tiles[0].parentElement.getBoundingClientRect();
                    return { row: row.width, tiles: tiles.map(node => node.getBoundingClientRect().width) };
                });
                expect(Math.abs(widths.tiles[0] - widths.tiles[1])).toBeLessThanOrEqual(1);
                expect(widths.tiles[0] + widths.tiles[1]).toBeGreaterThan(widths.row * 0.9);

                await (await visiblePageClose(host)).click();

                await expectClosed(page);
                await expect(page.locator('#chat > .welcomePanel :focus'), 'focus lands in Home, not on the page body').toHaveCount(1);
                await expect(page.locator('#chat > .welcomePanel .sbHomeTile')).toHaveCount(2);
            });

            sizeFreeTest('Escape closes the window and gives focus back to the tile', async ({ page }) => {
                await openFromTile(page, 'getting-started');

                await page.keyboard.press('Escape');

                await expectClosed(page);
                await expect(homeTile(page, 'getting-started')).toBeFocused();
            });

            sizeFreeTest('Close closes the window and gives focus back to the tile', async ({ page }) => {
                const host = await openFromTile(page, 'getting-started');

                await (await visiblePageClose(host)).click();

                await expectClosed(page);
                await expect(homeTile(page, 'getting-started')).toBeFocused();
            });

            sizeFreeTest('activating the tile twice opens one window', async ({ page }) => {
                await homeTile(page, 'getting-started').evaluate((tile) => {
                    tile.click();
                    tile.click();
                });

                await expect(hosts(page)).toHaveCount(1);
                await expect(hosts(page).locator('.sb-dialog__page')).toHaveCount(1);
            });

            sizeFreeTest('a window that fails to load toasts with its copy slot, logs the error, and can be opened again', async ({ page }) => {
                const errors = [];
                page.on('console', message => message.type() === 'error' && errors.push(message.text()));
                await showToasts(page);
                await page.route('**/sillybunny-home/getting-started-window.js*', route => route.abort());

                await homeTile(page, 'getting-started').click();

                await expect(page.locator('#toast-container .toast-message', { hasText: HOME_COPY.windowLoadError })).toHaveText(HOME_COPY.windowLoadError);
                await expect(hosts(page)).toHaveCount(0);
                expect(errors.some(line => line.includes('Could not open the Getting Started window'))).toBe(true);

                await page.unroute('**/sillybunny-home/getting-started-window.js*');
                const host = await openFromTile(page, 'getting-started');
                await expect(host).toHaveAccessibleName('Getting Started');
            });
        });

        test.describe('Focus after Home renders while a window is open', () => {
            for (const [key, title] of [['getting-started', 'Getting Started'], ['help', 'Help'], ['extras', 'Bundled Extras']]) {
                sizeFreeTest(`Escape on ${title} gives focus to the ${title} tile of the new panel`, async ({ page }) => {
                    const host = await openFromTile(page, key);
                    const replaced = await homeTile(page, key).evaluate((tile) => {
                        window.qaOldPanel = tile.closest('.welcomePanel');
                        return true;
                    });
                    expect(replaced).toBe(true);

                    await renderHomeAgain(page);
                    await expect(host).toBeVisible();
                    expect(await page.evaluate(() => window.qaOldPanel.isConnected), 'the first panel is gone').toBe(false);
                    await page.keyboard.press('Escape');

                    await expectClosed(page);
                    await expect(homeTile(page, key)).toBeFocused();
                });
            }

            sizeFreeTest('Escape on a window from the main menu gives focus to the main menu button of the new panel', async ({ page }) => {
                await openFromMenu(page, 'About SillyBunny');

                await renderHomeAgain(page);
                await page.keyboard.press('Escape');

                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });

            sizeFreeTest('Escape on the Choose Assistant window gives focus to the Choose Assistant card of the new panel', async ({ page }) => {
                await chooseAssistant(page).click();
                await expect(hosts(page)).toBeVisible();

                await renderHomeAgain(page);
                await page.keyboard.press('Escape');

                await expectClosed(page);
                await expect(chooseAssistant(page)).toBeFocused();
            });

            sizeFreeTest('Escape gives focus to the main menu button when the tile is gone from the new panel', async ({ page }) => {
                await openFromTile(page, 'getting-started');

                await page.evaluate(async () => {
                    const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
                    getSharedGettingStartedState().setHidden(true);
                });
                await renderHomeAgain(page);
                await page.keyboard.press('Escape');

                await expectClosed(page);
                await expect(menuButton(page)).toBeFocused();
            });
        });

        test.describe('Bundled Extras', () => {
            const labelsOf = host => host.locator('.ds-row-label');

            test(`opens from its tile as a window${sheet ? ' sheet' : ''}`, async ({ page }) => {
                const host = await openFromTile(page, 'extras');

                await expect(surface(host)).toHaveClass(/\bsb-dialog--window\b/);
                await expect(host).toHaveAttribute('data-presentation', sheet ? 'sheet' : 'floating');
                await expect(host).toHaveAccessibleName('Bundled Extras');
                await expect(homeTile(page, 'extras')).not.toHaveAttribute('data-sb-stub', /.*/);
            });

            sizeFreeTest('lists every extension, theme and preset, then UI Themes, with no Assistants group', async ({ page }) => {
                const host = await openFromTile(page, 'extras');

                await expect(host.getByRole('heading', { level: 3 })).toHaveText(EXTRAS_GROUPS);
                await expect(labelsOf(host)).toHaveText([...EXTRAS_ITEMS, 'UI Themes']);
            });

            sizeFreeTest('says the intro and a description under every item, with no assistant subtitle and no placeholder', async ({ page }) => {
                const host = await openFromTile(page, 'extras');

                await expect(host.locator('.sbArtLine')).toHaveText(HOME_COPY.extrasIntro);
                await expect(host.locator('.ds-row-subtitle')).toHaveText(Object.values(EXTRA_DESCRIPTIONS));
                await expect(host.getByText('Nahida')).toHaveCount(0);
                expect(await readCopyPlaceholders(host)).toEqual([]);
            });

            test('shows the Tewi art, and no art beside a row', async ({ page }) => {
                const host = await openFromTile(page, 'extras');

                await expectIntro(host, 'extras-tewi', { text: HOME_COPY.extrasIntro });
                await expect(host.locator('[data-sb-art-placeholder^="row-"]')).toHaveCount(0);
            });

            sizeFreeTest('gives a library that holds the card of Nahida no row for her, and loads no portrait of her', async ({ page }) => {
                const portraits = [];
                page.on('request', request => /nahida/i.test(request.url()) && /\.(?:png|jpe?g|webp)(?:\?|$)/i.test(request.url()) && request.url().includes('/img/') && portraits.push(request.url()));
                await page.route('**/api/characters/all', async (route) => {
                    const real = await fetchJsonOrSkip(route);
                    if (!real) return;
                    const data = { name: 'Assistant Nahida', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '', creator: '', character_version: '', alternate_greetings: [], group_only_greetings: [], tags: [], extensions: {} };
                    const card = { ...data, avatar: 'default_AssistantNahida.png', data, shallow: false, chat: 'qa-nahida', create_date: 1, json_data: JSON.stringify({ data }) };
                    return route.fulfill({ json: [...real.filter(entry => entry.avatar !== card.avatar), card] });
                });
                await page.evaluate(async () => (await import('/script.js')).getCharacters());

                const host = await openFromTile(page, 'extras');

                await expect(labelsOf(host)).toHaveText([...EXTRAS_ITEMS, 'UI Themes']);
                await expect(host.locator('[data-sb-stub]')).toHaveCount(0);
                expect(portraits).toEqual([]);
            });

            sizeFreeTest('lists no link for an extension, a theme or a preset', async ({ page }) => {
                const host = await openFromTile(page, 'extras');

                await expect(host.locator('a')).toHaveCount(0);
            });

            sizeFreeTest('UI Themes closes the window and opens Customize, Appearance with the theme select shown', async ({ page }) => {
                const host = await openFromTile(page, 'extras');

                await host.getByRole('button', { name: 'UI Themes' }).click();

                await expectClosed(page);
                await expect(page.getByRole('tab', { name: 'Appearance', selected: true })).toBeVisible();
                await expect(page.locator('#themes')).toBeVisible();
            });

            sizeFreeTest('Escape closes the window and gives focus back to the tile', async ({ page }) => {
                await openFromTile(page, 'extras');

                await page.keyboard.press('Escape');

                await expectClosed(page);
                await expect(homeTile(page, 'extras')).toBeFocused();
            });

            sizeFreeTest('Close closes the window and gives focus back to the tile', async ({ page }) => {
                const host = await openFromTile(page, 'extras');

                await (await visiblePageClose(host)).click();

                await expectClosed(page);
                await expect(homeTile(page, 'extras')).toBeFocused();
            });

            sizeFreeTest('opened from the tile, the window does not take focus to a heading', async ({ page }) => {
                const host = await openFromTile(page, 'extras');

                await expect(host.locator('h3:focus')).toHaveCount(0);
                await expect(host.locator(':focus')).toHaveCount(1);
            });

            sizeFreeTest('a window that fails to load toasts, logs the error, and can be opened again', async ({ page }) => {
                const errors = [];
                page.on('console', message => message.type() === 'error' && errors.push(message.text()));
                await showToasts(page);
                await page.route('**/sillybunny-home/bundled-extras-window.js*', route => route.abort());

                await homeTile(page, 'extras').click();

                await expect(page.locator('#toast-container .toast-message', { hasText: HOME_COPY.windowLoadError })).toBeVisible();
                await expect(hosts(page)).toHaveCount(0);
                expect(errors.some(line => line.includes('Could not open the Bundled Extras window'))).toBe(true);

                await page.unroute('**/sillybunny-home/bundled-extras-window.js*');
                await homeTile(page, 'extras').click();
                await expect(hosts(page)).toHaveAccessibleName('Bundled Extras');
            });
        });

        test.describe('Choose Assistant', () => {
            test(`opens from its card as a window${sheet ? ' sheet' : ''} named Choose Assistant, not Bundled Extras`, async ({ page }) => {
                await chooseAssistant(page).click();

                const host = hosts(page);
                await expect(host).toBeVisible();
                await expect(surface(host)).toHaveClass(/\bsb-dialog--window\b/);
                await expect(host).toHaveAttribute('data-presentation', sheet ? 'sheet' : 'floating');
                await expect(host).toHaveAccessibleName('Choose Assistant');
            });

            sizeFreeTest('is not a stub', async ({ page }) => {
                await expect(chooseAssistant(page)).not.toHaveAttribute('data-sb-stub', /.*/);
            });

            sizeFreeTest('gets focus back on its card after Escape and after Close, and opens one window when pressed twice', async ({ page }) => {
                await chooseAssistant(page).evaluate((button) => {
                    button.click();
                    button.click();
                });
                await expect(hosts(page)).toHaveCount(1);

                await page.keyboard.press('Escape');
                await expectClosed(page);
                await expect(chooseAssistant(page)).toBeFocused();

                await chooseAssistant(page).click();
                await (await visiblePageClose(hosts(page))).click();
                await expectClosed(page);
                await expect(chooseAssistant(page)).toBeFocused();
            });

            sizeFreeTest('a window that fails to load toasts, logs the error, and can be opened again', async ({ page }) => {
                const errors = [];
                page.on('console', message => message.type() === 'error' && errors.push(message.text()));
                await showToasts(page);
                await page.route('**/sillybunny-home/assistant-picker.js*', route => route.abort());

                await chooseAssistant(page).click();

                await expect(page.locator('#toast-container .toast-message', { hasText: HOME_COPY.windowLoadError })).toBeVisible();
                await expect(hosts(page)).toHaveCount(0);
                expect(errors.some(line => line.includes('Could not open the Choose Assistant window'))).toBe(true);

                await page.unroute('**/sillybunny-home/assistant-picker.js*');
                await chooseAssistant(page).click();
                await expect(hosts(page)).toHaveAccessibleName('Choose Assistant');
            });
        });

        sizeFreeTest('every window leaves no unmarked copy placeholder behind', async ({ page }) => {
            for (const { menuItem } of WINDOWS) {
                const host = await openFromMenu(page, menuItem);
                await expect(host).toBeVisible();
                await expectNoUnmarkedPlaceholder(host);
                await shownPage(host).getByRole('button', { name: 'Close', exact: true }).click();
                await expectClosed(page);
            }
            for (const key of ['getting-started', 'extras']) {
                const host = await openFromTile(page, key);
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
        await installFixtureChats(page);
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

    test('Help slides a section and a topic in as pages, and the trail and Back slide them out', async ({ page }) => {
        const host = await openFromMenu(page, 'Help');
        const title = shownPage(host).locator('.sb-dialog__title');
        const section = rowByLabel(helpSidebar(host), 'Troubleshooting');
        await expect.poll(() => runningAnimations(host)).toBe(0);

        await section.click();
        await expectSurfaceAnimates(host);
        await expect(title).toHaveText('Troubleshooting');

        await rowByLabel(shownPage(host), 'Fix a Connection Problem').click();
        await expectSurfaceAnimates(host);
        await expect(title).toHaveText('Fix a Connection Problem');
        await expect(host.locator('.sb-dialog__page')).toHaveCount(3);

        await shownPage(host).getByRole('button', { name: 'Troubleshooting', exact: true }).click();
        await expectSurfaceAnimates(host);
        await expect(title).toHaveText('Troubleshooting');
        await expect(host.locator('.sb-dialog__page')).toHaveCount(2);

        await shownPage(host).getByRole('button', { name: 'Back', exact: true }).click();
        await expectSurfaceAnimates(host);
        await expect(title).toHaveText('Help');
        await expect(host.locator('.sb-dialog__page')).toHaveCount(1);
        await expect(section).toBeFocused();
    });

    test('Help swaps the topic of a page with See Also without sliding a second page in', async ({ page }) => {
        const host = await openFromMenu(page, 'Help');
        await rowByLabel(helpSidebar(host), 'Models and Connections').click();
        await rowByLabel(shownPage(host), 'Connect to a Model').click();
        await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Connect to a Model');
        await expectSurfaceAnimates(host);

        await rowByLabel(shownPage(host).getByRole('group', { name: 'See Also' }), 'Choose a Preset').click();

        await expect(shownPage(host).locator('.sb-dialog__title')).toHaveText('Choose a Preset');
        await expect(host.locator('.sb-dialog__page')).toHaveCount(3);
    });
});

test.describe('Intros on a 360px phone', () => {
    test.use({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true });

    test.beforeEach(async ({ page }) => {
        await protectMaintainerServer(page);
        await installFixtureChats(page);
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await expectHome(page);
    });

    test('a window is a banner on a phone, with the line of the character under it', async ({ page }) => {
        const host = await openFromMenu(page, 'Keyboard Shortcuts');

        const layout = await expectIntro(host, 'shortcuts-tewi', { text: SHORTCUTS_COPY.intro });

        expect(layout.mode).toBe('banner');
        expect(layout.text.top, 'the line is under the banner').toBeGreaterThanOrEqual(layout.panel.bottom - 1);
    });

    test('with the Global Font Size at 20px it is still a banner, and the line stays under it', async ({ page }) => {
        await page.evaluate(() => document.documentElement.style.setProperty('--fontScale', String(20 / 15)));
        const host = await openFromMenu(page, 'Keyboard Shortcuts');

        const layout = await expectIntro(host, 'shortcuts-tewi', { text: SHORTCUTS_COPY.intro });

        expect(layout.em, 'the type is larger').toBeGreaterThan(18);
        expect(layout.mode).toBe('banner');
        expect(layout.text.top, 'the line is under the banner').toBeGreaterThanOrEqual(layout.panel.bottom - 1);
    });
});

test.describe('Intros with a larger type size on a desktop', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('the Help line stays beside the art at 20px', async ({ page }) => {
        await protectMaintainerServer(page);
        await installFixtureChats(page);
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await expectHome(page);
        await page.evaluate(() => document.documentElement.style.setProperty('--fontScale', String(20 / 15)));
        const host = await openFromMenu(page, 'Help');

        const layout = await expectIntro(host.locator('.sb-list-editor__detail .sbHelpPage'), 'help-reisen', { text: HOME_COPY.helpIntro });

        expect(layout.em, 'the type is larger').toBeGreaterThan(18);
        expect(layout.mode, 'the window widens for the larger sidebar and keeps the panel').toBe('panel');
        expect(layout.text.left, 'the line is beside the panel').toBeGreaterThanOrEqual(layout.panel.right);
    });
});

test.describe('About on a 360px phone', () => {
    test.use({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true });

    test('shows Reisen and Tewi as one banner above the logo, without leaving the sheet', async ({ page }) => {
        await protectMaintainerServer(page);
        await openQuietChatForSmoke(page, { selectCharacter: false });
        await expectHome(page);

        const host = await openFromMenu(page, 'About SillyBunny');

        await expect(host).toHaveAttribute('data-presentation', 'sheet');
        await expectAboutPair(host);
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
