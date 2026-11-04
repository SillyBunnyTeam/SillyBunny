import { expect, test as base } from '@playwright/test';
import { getPixelArt } from '../public/scripts/sillybunny-home/art-sources.js';
import { dismissOpenDialogIfPresent, openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';
import { testSetup } from './frontend/frontent-test-utils.js';
import { OPEN_ACTION_SHEET } from './helpers/action-sheet.js';
import { PINNED_ASSISTANT_ACCOUNT, REISEN_AVATAR, stubAssistantCards, TEWI_AVATAR } from './helpers/assistant-library.js';
import { installFixtureChats, pickFixtureCharacters } from './helpers/fixture-chats.js';
import { HOME_COPY } from './helpers/copy-home.js';
import { applyHomeTestSettings } from './helpers/getting-started-state.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { DESKTOP, matrixViewports, PHONE, sizeFreeTestFor, SMALL_PHONE } from './helpers/matrix.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { settledRead } from './helpers/settled-read.js';

// A test that asserts how many Getting Started steps are finished sets this, so the library holds only the cards that ship with SillyBunny.
const test = base.extend({ bundledCardsOnly: [false, { option: true }] });

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const STARTUP_TIMEOUT = 30_000;
const MODE_KEY = 'WelcomePage_PanelMode';

const TOUCH = { isMobile: true, hasTouch: true };
const HOME_SHELL_WIDTH = 1120;
const VIEWPORTS = [
    { name: 'desktop 1920x1080', wide: true, options: { viewport: { width: 1920, height: 1080 } } },
    { name: 'desktop 1440x900', wide: true, options: { viewport: { width: 1440, height: 900 } } },
    { name: 'laptop 1024x600', wide: false, options: { viewport: { width: 1024, height: 600 } } },
    { name: 'tablet 768x1024', wide: false, options: { viewport: { width: 768, height: 1024 }, ...TOUCH } },
    { name: 'phone 390x844', wide: false, options: { viewport: { width: 390, height: 844 }, ...TOUCH } },
    { name: 'phone 360x640', wide: false, options: { viewport: { width: 360, height: 640 }, ...TOUCH } },
];
const WIDE_VIEWPORTS = VIEWPORTS.filter(viewport => viewport.wide);

const REGION_VISIBILITY = {
    full: { hero: true, tiles: true, 'getting-started': true, assistants: true, 'assistant-art': true, 'recent-chats': true },
    compact: { hero: false, tiles: true, 'getting-started': true, assistants: true, 'assistant-art': false, 'recent-chats': true },
    list: { hero: false, tiles: false, 'getting-started': false, assistants: false, 'assistant-art': false, 'recent-chats': true },
};
const MODE_LABELS = { full: 'Full', compact: 'Compact', list: 'List Only' };
const ART_VISIBILITY = {
    full: { 'hero-duo': true, 'logo-32': true },
    compact: { 'hero-duo': false, 'logo-32': true },
    list: { 'hero-duo': false, 'logo-32': true },
};
const LOGO_SIZE = [32, 32];

/** A menu takes its focus in an animation frame, and its Escape handler lives inside it, so an earlier Escape is lost. */
const FOCUSED_MENU = `${OPEN_ACTION_SHEET}:focus-within, .sb-action-popover:focus-within`;
const ANY_MENU_PART = '.sb-action-sheet, .sb-action-sheet-backdrop, .sb-action-popover';

/** Closes the open menu with Escape once it holds focus, and waits until nothing of it is left to catch a click. */
async function escapeOpenMenu(page) {
    await expect(page.locator(FOCUSED_MENU)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator(ANY_MENU_PART)).toHaveCount(0);
}

const HERO_SELECTOR = ':is([data-sb-art-placeholder="hero-duo"], [data-sb-art-placeholder="hero-duo-night"])';

/** The hero is the day or the night scene by the clock of the machine, and the layout is the same for both. */
function artSelector(id) {
    return id === 'hero-duo' ? HERO_SELECTOR : `[data-sb-art-placeholder="${id}"]`;
}
// The container width at and above which the card portraits and the Choose Assistant icon are drawn at 2x.
const PORTRAIT_ONE_X_MAX = 740;
const TWO_CARDS_MAX = 716;
const VISIBLE_TILES = { full: ['Getting Started', 'Help', 'Bundled Extras'], compact: ['Getting Started', 'Help', 'Bundled Extras'], list: [] };
const VISIBLE_FOOT_BUTTONS = { full: 4, compact: 4, list: 0 };
const PORTRAIT_NATIVE = 64;
/** The hero pictures in art pixels, as the export stores them. */
const HERO_NATIVE = Object.fromEntries(['hero-duo', 'hero-duo-night'].map((id) => {
    const { width, height } = getPixelArt(id);
    return [id, [width, height]];
}));
const REGION_DOM_ORDER = ['hero', 'tiles', 'assistants', 'recent-chats'];
const REGION_NAMES = { assistants: 'Assistants', 'recent-chats': 'Recent Chats', tiles: 'Quick Links' };
const TILE_TITLES = ['Getting Started', 'Help', 'Bundled Extras'];
const ASSISTANT_NAMES = ['Reisen', 'Tewi'];
const SUBTITLES = {
    Reisen: 'Did you need help with setup or troubleshooting? Leave it to me!',
    Tewi: 'Gege~ Are you a little down on your luck? Ask me anything!',
};

const menuButton = page => page.locator('#chat > .welcomePanel .sbHomeMenuButton');
const tiles = page => page.locator('#chat > .welcomePanel .sbHomeTile');
const tile = (page, key) => page.locator(`#chat > .welcomePanel .sbHomeTile[data-sb-home-key="${key}"]`);
const assistantCards = page => page.locator('#chat > .welcomePanel .sbHomeCard:not(.sbHomeCard--choose)');
const assistantCard = (page, name) => page.locator(`#chat > .welcomePanel .sbHomeCard[data-sb-home-key="assistant-${name.toLowerCase()}"]`);
const chooseCard = page => page.locator('#chat > .welcomePanel .sbHomeCard--choose');
const regionSelector = id => `.welcomePanel [data-sb-home-region="${id}"]`;

async function expectHome(page) {
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: STARTUP_TIMEOUT });
    await expect(page.locator('#chat > .welcomePanel')).toBeAttached({ timeout: STARTUP_TIMEOUT });
}

/** The integer scale of the card portraits and the Choose Assistant icon: 2x above the container width, 1x at or below it. */
function pixelScale(panelWidth) {
    return panelWidth > PORTRAIT_ONE_X_MAX ? 2 : 1;
}

function pixelArtSizes(panelWidth) {
    const scale = pixelScale(panelWidth);
    return {
        'row-reisen': [PORTRAIT_NATIVE * scale, PORTRAIT_NATIVE * scale],
        'row-tewi': [PORTRAIT_NATIVE * scale, PORTRAIT_NATIVE * scale],
    };
}

/**
 * What the hero is drawn as at a screen scale of 1: its own size when the band holds it and the padding of its panel,
 * and what is left of the band, at the proportions of the picture, when it does not.
 * @returns {Promise<{ id: string, size: number[], native: number[], expected: number[], fit: string, inner: number, rendering: string, ariaHidden: string | null, pictures: number }>}
 */
async function readHero(page) {
    return page.evaluate((natives) => {
        const panel = document.querySelector('.welcomePanel .sbHomeHeroArt');
        const figure = panel.querySelector('.sbArtFigure');
        const band = panel.closest('.sbHomeBand');
        const style = getComputedStyle(band);
        const panelStyle = getComputedStyle(panel);
        const inner = band.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
            - Number.parseFloat(panelStyle.paddingLeft) - Number.parseFloat(panelStyle.paddingRight);
        const box = figure.getBoundingClientRect();
        const [width, height] = natives[figure.dataset.sbArtPlaceholder];
        const shown = Math.min(width, inner);
        return {
            id: figure.dataset.sbArtPlaceholder,
            size: [box.width, box.height],
            native: [width, height],
            expected: [shown, (height * shown) / width],
            fit: panel.dataset.sbArtFit,
            inner,
            rendering: getComputedStyle(figure.querySelector('img')).imageRendering,
            ariaHidden: panel.getAttribute('aria-hidden'),
            pictures: panel.querySelectorAll('img').length,
        };
    }, HERO_NATIVE);
}

/** A hero drawn at its own size is blocks of device pixels. One that was shrunk below its file is sampled smoothly, because uneven blocks would show as stripes. */
const expectedRendering = hero => (hero.size[0] < hero.native[0] - 0.5 ? 'auto' : 'pixelated');

async function setGettingStartedHidden(page, hidden) {
    await page.evaluate(async (value) => {
        const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
        getSharedGettingStartedState().setHidden(value);
    }, hidden);
}

async function setHomeContentWidth(page, width) {
    const scrollbar = await page.evaluate(() => {
        const shell = document.getElementById('sheld');
        shell.style.setProperty('width', '1100px', 'important');
        return shell.getBoundingClientRect().width - document.querySelector('#chat > .welcomePanel').getBoundingClientRect().width;
    });
    await page.evaluate(value => document.getElementById('sheld').style.setProperty('width', `${value}px`, 'important'), width + scrollbar);
}

/** The boxes of the header of Home, and where the text line of the title and of the version sit. */
async function readHeader(page) {
    return page.evaluate(() => {
        const rect = selector => document.querySelector(`.welcomePanel ${selector}`).getBoundingClientRect();
        // An empty inline-block has its baseline at its bottom edge, so its bottom is where the text line sits.
        // The text goes into a span first, because a flex or grid container would make the probe an item of its own.
        const baselineOf = (selector) => {
            const node = document.querySelector(`.welcomePanel ${selector}`);
            const text = node.textContent;
            const probe = document.createElement('span');
            probe.style.cssText = 'display: inline-block; width: 0; height: 0;';
            const line = document.createElement('span');
            line.append(text, probe);
            node.replaceChildren(line);
            const { bottom } = probe.getBoundingClientRect();
            node.replaceChildren(text);
            return bottom;
        };
        const textBox = (selector) => {
            const range = document.createRange();
            range.selectNodeContents(document.querySelector(`.welcomePanel ${selector}`));
            return range.getBoundingClientRect();
        };
        return {
            column: rect('.sbHomeLayout'),
            row: rect('.sbHomeHeader'),
            logo: rect('[data-sb-art-placeholder="logo-32"]'),
            title: rect('.sbHomeTitle'),
            text: textBox('.sbHomeTitle'),
            version: textBox('.sbHomeVersion'),
            versionLine: rect('.sbHomeVersion'),
            button: rect('.sbHomeMenuButton'),
            edge: rect('[data-sb-home-region="recent-chats"]'),
            titleBaseline: baselineOf('.sbHomeTitle'),
            versionBaseline: baselineOf('.sbHomeVersion'),
        };
    });
}

const centreX = box => (box.left + box.right) / 2;
const centreY = box => (box.top + box.bottom) / 2;

/** Whether the version is beside the menu button without touching it, or below it. */
function isClearOfButton({ version, button }) {
    return version.right <= button.left || version.left >= button.right || version.top >= button.bottom;
}

/** Lengthens the version until it just touches the menu button, which is the shortest version that has to move. */
async function lengthenVersionToTouchButton(page) {
    const length = await page.evaluate(() => {
        const version = document.querySelector('.welcomePanel [data-sb-home-version]');
        const button = document.querySelector('.welcomePanel .sbHomeMenuButton');
        // Below the title the version has no width, so only its place beside the title says when it touches.
        document.querySelector('.welcomePanel .sbHomeHeader').removeAttribute('data-sb-version-below');
        version.textContent = 'v2';
        while (version.getBoundingClientRect().right + 8 <= button.getBoundingClientRect().left && version.textContent.length < 600) {
            version.textContent += 'x';
        }
        return version.textContent.length;
    });
    await waitForAnimationFrames(page, 3);
    return length;
}

/** Gives the header a version string of another length and lets it settle, so each placement can be tested at any width. */
async function setVersionText(page, text) {
    await page.evaluate((value) => { document.querySelector('.welcomePanel [data-sb-home-version]').textContent = value; }, text);
    await waitForAnimationFrames(page, 3);
}

const VERSION_BELOW = 'data-sb-version-below';
const SHORT_VERSION = 'v2';

async function measureChooseCard(page) {
    return page.evaluate(() => {
        const rect = selector => document.querySelector(`.welcomePanel ${selector}`).getBoundingClientRect();
        const choose = document.querySelector('.welcomePanel .sbHomeCard--choose');
        const grid = rect('.sbHomeCards');
        const reisen = rect('.sbHomeCard[data-sb-home-key="assistant-reisen"]');
        const tewi = rect('.sbHomeCard[data-sb-home-key="assistant-tewi"]');
        const box = choose.getBoundingClientRect();
        return {
            panelWidth: document.querySelector('.welcomePanel').clientWidth,
            grid: { left: grid.left, right: grid.right },
            reisen: { top: Math.round(reisen.top), left: reisen.left, width: reisen.width, height: reisen.height },
            tewi: { top: Math.round(tewi.top), right: tewi.right },
            choose: { top: Math.round(box.top), left: box.left, width: box.width, height: box.height },
            footers: choose.querySelectorAll('.sbHomeCardFooter').length,
            icon: choose.querySelectorAll('i.fa-user-plus').length,
            chevrons: choose.querySelectorAll('.fa-chevron-right').length,
            key: choose.dataset.sbHomeKey,
            stub: choose.querySelector('.sbHomeCardOpen')?.dataset.sbStub,
            label: choose.querySelector('.sbHomeCardOpen')?.getAttribute('aria-label'),
        };
    });
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

const LONG_FOOTER_LABELS = ['D\u00e9marrer une nouvelle conversation', 'Conversation temporaire de longue dur\u00e9e'];

async function setFontSize(page, pixels) {
    // The Global Font Size slider sets --fontScale, and --mainFontSize is 15px times it.
    await page.evaluate(size => document.documentElement.style.setProperty('--fontScale', String(size / 15)), pixels);
}

async function readFooters(page) {
    return page.evaluate(() => [...document.querySelectorAll('.welcomePanel .sbHomeCard:not(.sbHomeCard--choose)')].map((card) => {
        const footer = card.querySelector('.sbHomeCardFooter');
        const labels = [...footer.querySelectorAll('.sbHomeFootLabel')];
        const shown = labels.map(label => getComputedStyle(label).display !== 'none');
        return {
            shown,
            clipped: labels.filter((label, index) => shown[index] && label.scrollWidth > label.clientWidth).length,
            overflow: footer.scrollWidth - footer.clientWidth,
            menuOutside: card.querySelector('.sbHomeRowMenu').getBoundingClientRect().right - card.getBoundingClientRect().right,
            measuring: card.hasAttribute('data-sb-footer-measure'),
        };
    }));
}

/** What is wrong with the footers, so a poll can wait for the fit to settle and a failure names the card. */
function footerProblems(footers) {
    return footers.flatMap((footer, index) => [
        new Set(footer.shown).size !== 1 && 'labels split',
        footer.clipped > 0 && 'label cut short',
        footer.overflow > 0 && 'footer overflows',
        footer.menuOutside > 0 && 'menu button outside the card',
        footer.measuring && 'still measuring',
    ].filter(Boolean).map(problem => `card ${index}: ${problem}`));
}

async function expectFootersFit(page) {
    await expect.poll(async () => footerProblems(await readFooters(page)), { timeout: 5000 }).toEqual([]);
}

/** At the default font the cards of a 1440 window or wider hold both labels, as approved, and a phone's hold none. */
async function expectDefaultLabels(page, windowWidth) {
    if (windowWidth >= 1440) {
        await expectLabelsShown(page, true);
    }
    if (windowWidth <= 390) {
        await expectLabelsShown(page, false);
    }
}

async function expectLabelsShown(page, shown) {
    await expect.poll(async () => (await readFooters(page)).map(footer => footer.shown), { timeout: 5000 }).toEqual([[shown, shown], [shown, shown]]);
}

async function useLongFooterLabels(page) {
    // The card does not resize when its text changes, so a 1px margin makes the observer look again.
    await page.evaluate((labels) => {
        document.querySelectorAll('.welcomePanel .sbHomeCard:not(.sbHomeCard--choose)').forEach((card) => {
            card.querySelectorAll('.sbHomeFootLabel').forEach((label, index) => { label.textContent = labels[index]; });
            card.style.marginInlineEnd = '1px';
        });
    }, LONG_FOOTER_LABELS);
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

// A quick run keeps the sizes where the layout tests differ: the desktop, a phone and the narrowest phone, which the tile line limit is tuned for.
for (const { name, options } of matrixViewports(VIEWPORTS, [DESKTOP, PHONE, SMALL_PHONE])) {
    test.describe(`Home layout at ${name}`, () => {
        test.use(options);
        // `test` below measures the layout or follows a branch of the size; `sizeFreeTest` does not depend on the size.
        const sizeFreeTest = sizeFreeTestFor(test, options.viewport);

        test.beforeEach(async ({ page, bundledCardsOnly }) => {
            await protectMaintainerServer(page);
            await installFixtureChats(page, { bundledCardsOnly, accountStorage: PINNED_ASSISTANT_ACCOUNT });
            // The cards of Home depend on the library, so it holds Reisen and Tewi and no other assistant, whatever the data root holds.
            await stubAssistantCards(page, [REISEN_AVATAR, TEWI_AVATAR], { bundledOnly: bundledCardsOnly });
            await openQuietChatForSmoke(page, { selectCharacter: false });
            await expectHome(page);
        });

        test('lays out one column: every block shares the content edges and sits below the one before', async ({ page }) => {
            await chooseMode(page, 'full');
            const blocks = [await measure(page, '.welcomePanel .sbHomeHeader')];
            for (const id of REGION_DOM_ORDER) {
                blocks.push(await measure(page, regionSelector(id)));
            }
            const [header, hero, tilesRow, assistants, recent] = blocks;

            for (const block of blocks) {
                expect(Math.abs(block.left - header.left), 'left edge').toBeLessThanOrEqual(1);
                expect(Math.abs(block.right - header.right), 'right edge').toBeLessThanOrEqual(1);
            }
            blocks.slice(1).forEach((block, index) => expect(block.top).toBeGreaterThanOrEqual(blocks[index].bottom - 1));
            expect(Math.round(hero.top - header.bottom), 'header to band').toBe(16);
            expect(Math.round(tilesRow.top - hero.bottom), 'band to tiles').toBe(32);
            expect(Math.round(assistants.top - tilesRow.bottom), 'tiles to assistants').toBe(32);
            expect(Math.round(recent.top - assistants.bottom), 'assistants to Recent Chats').toBe(32);
        });

        test('the header row is 44px tall and sits 12px below the top of the panel', async ({ page }) => {
            await chooseMode(page, 'full');
            await setVersionText(page, SHORT_VERSION);
            const panel = await measure(page, '#chat > .welcomePanel');
            const header = await measure(page, '.welcomePanel .sbHomeHeader');

            expect(Math.round(header.height)).toBe(44);
            expect(Math.round(header.top - panel.top)).toBe(12);
        });

        test('Tab, the DOM and the screen visit tiles, cards and Recent Chats in one order', async ({ page }) => {
            const characters = await pickFixtureCharacters(page, 2);
            expect(characters.length).toBeGreaterThan(0);
            await renderHome(page, recentChatEntries(characters, 3, { distinctFiles: true }));
            await chooseMode(page, 'full');

            const order = await page.evaluate(() => {
                const idOf = node => node.dataset.sbHomeKey ?? node.dataset.sbHomeRegion;
                const blocks = [...document.querySelectorAll('.welcomePanel [data-sb-home-region="hero"], .welcomePanel [data-sb-home-key], .welcomePanel [data-sb-home-region="recent-chats"]')];
                const onScreen = [...blocks]
                    .map((node) => {
                        const rect = node.getBoundingClientRect();
                        return { id: idOf(node), top: Math.round(rect.top), left: Math.round(rect.left) };
                    })
                    .sort((first, second) => first.top - second.top || first.left - second.left)
                    .map(block => block.id);
                return { inDom: blocks.map(idOf), onScreen };
            });

            await menuButton(page).focus();
            const stops = [];
            for (let press = 0; press < 70; press++) {
                await page.keyboard.press('Tab');
                stops.push(await page.evaluate(() => {
                    const node = document.activeElement?.closest('[data-sb-home-key], [data-sb-home-region]');
                    return node ? (node.dataset.sbHomeKey ?? node.dataset.sbHomeRegion) : null;
                }));
            }
            const inHome = stops.filter(id => order.inDom.includes(id)).filter((id, index, all) => id !== all[index - 1]);
            // Past Recent Chats, focus leaves Home and wraps around, so only the first lap counts.
            const firstLap = inHome.slice(0, inHome.indexOf('recent-chats') + 1);

            expect(order.inDom, 'DOM order').toEqual(['hero', 'getting-started', 'help', 'extras', 'assistant-reisen', 'assistant-tewi', 'assistant-own', 'recent-chats']);
            expect(order.onScreen, 'screen order').toEqual(order.inDom);
            expect(firstLap, 'Tab order').toEqual(order.inDom);
        });

        sizeFreeTest('every region is a landmark named by its visible heading, and the tile row is named Quick Links', async ({ page }) => {
            await chooseMode(page, 'full');

            for (const [id, name] of Object.entries(REGION_NAMES)) {
                await expect(page.locator(regionSelector(id)), id).toHaveAccessibleName(name);
            }
            for (const id of ['assistants', 'recent-chats']) {
                await expect(page.locator(regionSelector(id)).getByRole('heading', { level: 2, name: REGION_NAMES[id] })).toBeVisible();
            }
            await expect(page.getByRole('region', { name: 'Quick Links' })).toBeVisible();
        });

        sizeFreeTest('keeps the DOM order of the regions', async ({ page }) => {
            const order = await page.evaluate((ids) => {
                const nodes = ['.sbHomeHeader', ...ids.map(id => `[data-sb-home-region="${id}"]`)]
                    .map(selector => document.querySelector(`.welcomePanel ${selector}`));
                return nodes.slice(1).every((node, index) => Boolean(nodes[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
            }, REGION_DOM_ORDER);

            expect(order).toBe(true);
        });

        test('the column is centred in the panel and takes its whole width', async ({ page }) => {
            const layout = await measure(page, '.welcomePanel .sbHomeLayout');
            const panel = await measure(page, '#chat > .welcomePanel');

            expect(Math.abs(layout.width - panel.width)).toBeLessThanOrEqual(1);
            expect(Math.abs((layout.left - panel.left) - (panel.right - layout.right))).toBeLessThanOrEqual(1);
        });

        for (const mode of ['full', 'compact', 'list']) {
            test(`${MODE_LABELS[mode]}: the title is centred on the column, the logo before it and the version after it or below it, and the menu button at the end`, async ({ page }) => {
                await chooseMode(page, mode);
                await waitForAnimationFrames(page, 3);

                const header = await readHeader(page);

                expect(Math.abs(centreX(header.text) - centreX(header.column)), 'the word is centred on the column').toBeLessThanOrEqual(1);
                expect(header.logo.right, 'the logo ends before the word').toBeLessThanOrEqual(header.text.left);
                expect(header.logo.left, 'the logo stays in the column').toBeGreaterThanOrEqual(header.column.left);
                expect(Math.abs(header.button.right - header.edge.right), 'button at the content edge').toBeLessThanOrEqual(1);
                expect(Math.abs(centreY(header.button) - centreY(header.text)), 'button on the title line').toBeLessThanOrEqual(1);
                expect(Math.abs(centreY(header.logo) - centreY(header.text)), 'logo on the title line').toBeLessThanOrEqual(1);
                expect(isClearOfButton(header), 'the version stays clear of the button').toBe(true);
                expect(Math.round(header.row.height)).toBeGreaterThanOrEqual(44);
            });
        }

        test('a short version sits after the title on its baseline, and the header is 44px tall', async ({ page }) => {
            await chooseMode(page, 'full');
            await setVersionText(page, SHORT_VERSION);

            const header = await readHeader(page);

            await expect(page.locator('.welcomePanel .sbHomeHeader')).not.toHaveAttribute(VERSION_BELOW, /.*/);
            expect(Math.abs(header.versionBaseline - header.titleBaseline), 'version baseline').toBeLessThanOrEqual(1);
            expect(header.version.left, 'the version follows the word').toBeGreaterThanOrEqual(header.text.right);
            expect(Math.abs(centreX(header.text) - centreX(header.column)), 'the word is centred on the column').toBeLessThanOrEqual(1);
            expect(Math.round(header.row.height)).toBe(44);
        });

        test('a version that cannot fit beside the menu button goes below the title, centred under it, and the title stays centred', async ({ page }) => {
            await chooseMode(page, 'full');
            const length = await lengthenVersionToTouchButton(page);

            expect(length, 'the shortest version that touches the button was found before the cap').toBeLessThan(600);
            const header = await readHeader(page);
            const hero = await measure(page, regionSelector('hero'));

            await expect(page.locator('.welcomePanel .sbHomeHeader')).toHaveAttribute(VERSION_BELOW, '');
            expect(header.version.top, 'below the title').toBeGreaterThanOrEqual(header.text.bottom - 1);
            expect(Math.abs(centreX(header.version) - centreX(header.text)), 'centred under the word').toBeLessThanOrEqual(1);
            expect(Math.abs(centreX(header.text) - centreX(header.column)), 'the word is centred on the column').toBeLessThanOrEqual(1);
            expect(Math.abs(centreY(header.button) - centreY(header.text)), 'button on the title line').toBeLessThanOrEqual(1);
            expect(Math.abs(centreY(header.logo) - centreY(header.text)), 'logo on the title line').toBeLessThanOrEqual(1);
            expect(header.version.bottom, 'the version is inside the header').toBeLessThanOrEqual(header.row.bottom + 1);
            expect(Math.round(hero.top - header.row.bottom), 'header to band').toBe(16);
        });

        test('with the text at 20px the title stays centred and the version stays clear of the button', async ({ page }) => {
            await chooseMode(page, 'full');
            await page.evaluate(() => document.documentElement.style.setProperty('--mainFontSize', '20px'));
            await waitForAnimationFrames(page, 3);

            const header = await readHeader(page);

            expect(Math.abs(centreX(header.text) - centreX(header.column)), 'the word is centred on the column').toBeLessThanOrEqual(1);
            expect(isClearOfButton(header), 'the version stays clear of the button').toBe(true);
            expect(Math.abs(centreY(header.button) - centreY(header.text)), 'button on the title line').toBeLessThanOrEqual(1);
        });

        test('in a right-to-left page the header is mirrored and the title stays centred', async ({ page }) => {
            await chooseMode(page, 'full');
            await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
            await waitForAnimationFrames(page, 3);

            const header = await readHeader(page);

            expect(Math.abs(centreX(header.text) - centreX(header.column)), 'the word is centred on the column').toBeLessThanOrEqual(1);
            expect(header.logo.left, 'the logo is after the word, on its right').toBeGreaterThanOrEqual(header.text.right);
            expect(Math.abs(header.button.left - header.edge.left), 'the menu button is at the left edge').toBeLessThanOrEqual(1);
            expect(isClearOfButton(header), 'the version stays clear of the button').toBe(true);
        });

        test('the menu button is flat at rest and keeps the content edge of the band', async ({ page }) => {
            await chooseMode(page, 'full');

            const look = await menuButton(page).evaluate(button => ({ background: getComputedStyle(button).backgroundColor, border: getComputedStyle(button).borderTopWidth }));
            const button = await measure(page, '.welcomePanel .sbHomeMenuButton');
            const band = await measure(page, regionSelector('hero'));

            expect(look).toEqual({ background: 'rgba(0, 0, 0, 0)', border: '0px' });
            expect(Math.abs(button.right - band.right)).toBeLessThanOrEqual(1);
        });

        test('the header, the tiles, the Assistants and Recent Chats have the same width in every display mode', async ({ page }) => {
            const widths = {};
            for (const mode of ['full', 'compact', 'list']) {
                await chooseMode(page, mode);
                widths[mode] = await page.evaluate(() => {
                    const rect = selector => document.querySelector(`.welcomePanel ${selector}`).getBoundingClientRect();
                    const header = rect('.sbHomeHeader');
                    const recent = rect('[data-sb-home-region="recent-chats"]');
                    return { header: [Math.round(header.left), Math.round(header.right)], recent: [Math.round(recent.left), Math.round(recent.right)] };
                });
            }

            expect(widths.compact).toEqual(widths.full);
            expect(widths.list).toEqual(widths.full);
            expect(widths.full.recent).toEqual(widths.full.header);
        });

        sizeFreeTest('the Home panel starts at the top of the chat, whatever the resize observer did', async ({ page }) => {
            await chooseMode(page, 'full');
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));

            expect(await page.evaluate(() => document.getElementById('chat').scrollTop)).toBe(0);
            await renderHome(page, []);
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
            expect(await page.evaluate(() => document.getElementById('chat').scrollTop)).toBe(0);
        });

        test('the content ends 24px above the bottom of the panel', async ({ page }) => {
            await chooseMode(page, 'full');

            const padding = await page.locator('.welcomePanel .sbHomeLayout').evaluate(layout => getComputedStyle(layout).paddingBlockEnd);

            expect(padding).toBe('24px');
        });

        if (options.viewport.width < 769) {
            test('on a phone or tablet the Home column is flush with the bottom of the window', async ({ page }) => {
                await chooseMode(page, 'full');

                const gap = await page.evaluate(() => window.innerHeight - document.getElementById('chat').getBoundingClientRect().bottom);

                expect(Math.abs(gap)).toBeLessThanOrEqual(2);
            });
        }

        if (options.viewport.width === 1440) {
            test('on a desktop the Home column ends where the Roleplay composer card ends', async ({ page }) => {
                const characters = await pickFixtureCharacters(page, 1);
                expect(characters).toHaveLength(1);
                await chooseMode(page, 'full');
                const homeGap = await page.evaluate(() => window.innerHeight - document.getElementById('chat').getBoundingClientRect().bottom);
                await renderHome(page, recentChatEntries(characters, 1));

                await page.locator('.welcomePanel .recentChat button.recentChatOpen').first().click();
                await dismissOpenDialogIfPresent(page);
                await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/, { timeout: STARTUP_TIMEOUT });
                await expect(page.locator('#send_form')).toBeVisible();
                const composerGap = await page.evaluate(() => window.innerHeight - document.getElementById('send_form').getBoundingClientRect().bottom);

                expect(homeGap).toBeGreaterThan(0);
                expect(Math.abs(homeGap - composerGap)).toBeLessThanOrEqual(1);
            });
        }

        if (options.hasTouch) {
            test('the targets of the header, tiles and cards are 44px on a coarse pointer', async ({ page }) => {
                expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
                await chooseMode(page, 'full');

                const sizes = await page.evaluate(() => {
                    const boxes = selector => [...document.querySelectorAll(`.welcomePanel ${selector}`)].map((node) => {
                        const rect = node.getBoundingClientRect();
                        return { width: Math.round(rect.width), height: Math.round(rect.height) };
                    });
                    return {
                        menu: boxes('.sbHomeMenuButton'),
                        tiles: boxes('.sbHomeTile'),
                        footButtons: boxes('.sbHomeFootButton'),
                        cardMenus: boxes('.sbHomeRowMenu'),
                        filters: boxes('.welcomeRecentTab:not(.displayNone)'),
                    };
                });

                for (const [name, boxes] of Object.entries(sizes)) {
                    expect(boxes.length, name).toBeGreaterThan(0);
                    expect(Math.min(...boxes.map(box => box.height)), `${name} height`).toBeGreaterThanOrEqual(44);
                }
                for (const name of ['menu', 'footButtons', 'cardMenus']) {
                    expect(Math.min(...sizes[name].map(box => box.width)), `${name} width`).toBeGreaterThanOrEqual(44);
                }
            });
        }

        for (const mode of ['full', 'compact', 'list']) {
            test(`${MODE_LABELS[mode]} shows the right regions and art`, async ({ page }) => {
                await chooseMode(page, mode);

                for (const [id, visible] of Object.entries(REGION_VISIBILITY[mode])) {
                    const rendered = await page.locator(regionSelector(id))
                        .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).display !== 'none' && !node.closest('[hidden]')));
                    expect(rendered.length, `${id} is in the template`).toBeGreaterThan(0);
                    expect(rendered.every(value => value === visible), `${id} in ${mode}`).toBe(true);
                }
                for (const [artId, visible] of Object.entries(ART_VISIBILITY[mode])) {
                    const art = page.locator(`.welcomePanel ${artSelector(artId)}`);
                    await expect(art).toHaveCount(1);
                    await expect(art, `${artId} in ${mode}`).toBeVisible({ visible });
                }
                await expect(page.getByRole('heading', { level: 1, name: 'SillyBunny' })).toBeVisible();
                await expect(menuButton(page)).toBeVisible();
                await expect(page.locator('.welcomePanel .sbHomeTile:visible')).toHaveText(VISIBLE_TILES[mode].map(title => new RegExp(`^${title}`)));
                await expect(page.locator('.welcomePanel .sbHomeFootButton:visible')).toHaveCount(VISIBLE_FOOT_BUTTONS[mode]);
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

        sizeFreeTest('the display mode is saved and survives a reload', async ({ page }) => {
            const saved = await trackSettingsSaves(page);

            await chooseMode(page, 'compact');
            await expect.poll(() => saved.accountStorage[MODE_KEY], { timeout: STARTUP_TIMEOUT }).toBe('compact');

            await page.route('**/api/settings/get', async (route) => {
                const data = await fetchJsonOrSkip(route);
                if (!data) return;
                const settings = JSON.parse(data.settings);
                settings.accountStorage = { ...settings.accountStorage, ...saved.accountStorage };
                applyHomeTestSettings(settings);
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

        sizeFreeTest('switching the display mode does not fetch Recent Chats again', async ({ page }) => {
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

        sizeFreeTest('the main menu button is named, announced and reachable by keyboard', async ({ page }) => {
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

        sizeFreeTest('the main menu checks the current display mode', async ({ page }) => {
            await chooseMode(page, 'list');

            await menuButton(page).click();

            await expect(page.getByRole('menuitemradio', { name: 'List Only', exact: true })).toHaveAttribute('aria-checked', 'true');
            await expect(page.getByRole('menuitemradio', { name: 'Full', exact: true })).toHaveAttribute('aria-checked', 'false');
            await escapeOpenMenu(page);
        });

        sizeFreeTest('Recent Chats Settings opens from the main menu', async ({ page }) => {
            await menuButton(page).click();
            await page.getByRole('menuitem', { name: 'Recent Chats Settings', exact: true }).click();

            await expect(page.locator('#maxRecentChats')).toBeVisible();
            await expect(page.locator('#collapsedRecentChats')).toBeVisible();

            await page.keyboard.press('Escape');
            await expect(page.locator('#maxRecentChats')).toHaveCount(0);
        });

        sizeFreeTest('Home carries no copy placeholder, because every line on it is written', async ({ page }) => {
            await chooseMode(page, 'full');

            const report = await page.evaluate(() => {
                const root = document.querySelector('#chat > .welcomePanel');
                return {
                    marked: root.querySelectorAll('[data-sb-copy-placeholder], [data-sb-copy-slot]').length,
                    todo: [...root.querySelectorAll('*')].filter(node => node.children.length === 0 && node.textContent.includes('TODO(copy)')).length,
                };
            });

            expect(report).toEqual({ marked: 0, todo: 0 });
        });

        for (const mode of ['full', 'compact']) {
            test(`the tile row holds Getting Started, Help and Bundled Extras as three equal cards in ${MODE_LABELS[mode]}`, async ({ page }) => {
                await chooseMode(page, mode);

                await expect(tiles(page).locator('.sbHomeTileTitle')).toHaveText(TILE_TITLES);
                const layout = await page.evaluate(() => {
                    const rect = node => node.getBoundingClientRect();
                    const row = rect(document.querySelector('.welcomePanel [data-sb-home-region="tiles"]'));
                    const boxes = [...document.querySelectorAll('.welcomePanel .sbHomeTile')].map(rect);
                    return {
                        row: { left: row.left, right: row.right },
                        tops: boxes.map(box => Math.round(box.top)),
                        widths: boxes.map(box => box.width),
                        first: boxes[0].left,
                        last: boxes[boxes.length - 1].right,
                    };
                });

                expect(new Set(layout.tops).size, 'one row').toBe(1);
                expect(Math.max(...layout.widths) - Math.min(...layout.widths)).toBeLessThanOrEqual(1);
                expect(Math.abs(layout.first - layout.row.left)).toBeLessThanOrEqual(1);
                expect(Math.abs(layout.last - layout.row.right)).toBeLessThanOrEqual(1);
            });
        }

        test('Full shows the whole voiced line of every tile, and the three tiles keep one height', async ({ page }) => {
            await chooseMode(page, 'full');

            const report = await page.evaluate(() => [...document.querySelectorAll('.welcomePanel .sbHomeTile')].map((node) => {
                const line = node.querySelector('.sbHomeTileLine');
                return {
                    text: line.textContent,
                    overflow: getComputedStyle(line).overflow,
                    clamp: getComputedStyle(line).webkitLineClamp,
                    inside: line.getBoundingClientRect().bottom <= node.getBoundingClientRect().bottom,
                    height: Math.round(node.getBoundingClientRect().height),
                };
            }));

            expect(report.map(entry => entry.text)).toEqual([HOME_COPY.tileGettingStarted, HOME_COPY.tileHelp, HOME_COPY.tileExtras]);
            expect(report.map(entry => entry.overflow), 'no line is cut by its own box').toEqual(['visible', 'visible', 'visible']);
            expect(report.map(entry => entry.clamp), 'no line clamp is left on a line').toEqual(['none', 'none', 'none']);
            expect(report.map(entry => entry.inside), 'every line ends inside its tile').toEqual([true, true, true]);
            expect(new Set(report.map(entry => entry.height)).size, 'one height').toBe(1);
        });

        test('each tile is a button with a circled icon, a title and a voiced line', async ({ page }) => {
            await chooseMode(page, 'full');

            await expect(tiles(page)).toHaveCount(3);
            for (const [key, icon] of [['getting-started', 'fa-list-check'], ['help', 'fa-circle-question'], ['extras', 'fa-box-open']]) {
                const tileNode = tile(page, key);
                await expect(tileNode, key).toHaveJSProperty('tagName', 'BUTTON');
                await expect(tileNode.locator(`.sbHomeTileIcon i.${icon}`)).toHaveCount(1);
                await expect(tileNode.locator('.sbHomeTileTitle')).toBeVisible();
                await expect(tileNode.locator('.sbHomeTileLine')).toBeVisible();
            }
            const icon = await tile(page, 'help').locator('.sbHomeTileIcon').evaluate((node) => {
                const rect = node.getBoundingClientRect();
                return { width: Math.round(rect.width), height: Math.round(rect.height), radius: getComputedStyle(node).borderTopLeftRadius };
            });
            expect(icon).toMatchObject({ width: 48, height: 48 });
            expect(parseFloat(icon.radius)).toBeGreaterThanOrEqual(24);
        });

        sizeFreeTest('Compact shows the title of Getting Started, Help and Bundled Extras without the voiced line, and Full brings it back', async ({ page }) => {
            await chooseMode(page, 'compact');

            await expect(tiles(page).locator('.sbHomeTileTitle:visible')).toHaveText(TILE_TITLES);
            await expect(tiles(page).locator('.sbHomeTileLine:visible')).toHaveCount(0);
            await expect(tiles(page).locator('.sbHomeTileLine')).toHaveCount(3);

            await chooseMode(page, 'full');

            await expect(tiles(page).locator('.sbHomeTileLine')).toHaveCount(3);
            await expect(tiles(page).locator('.sbHomeTileLine').first()).toBeVisible();
            await expect(tiles(page).locator('.sbHomeTileLine').last()).toBeVisible();
        });

        sizeFreeTest('the ids that name and describe the tiles are unique and the same after Home renders again', async ({ page }) => {
            const ids = () => page.evaluate(() => [...document.querySelectorAll('.welcomePanel .sbHomeTile')].map(node => [node.getAttribute('aria-labelledby'), node.getAttribute('aria-describedby')]));
            await chooseMode(page, 'full');
            const before = await ids();

            await renderHome(page, []);
            await chooseMode(page, 'full');

            expect(await ids()).toEqual(before);
            for (const id of before.flatMap(pair => pair.join(' ').split(' '))) {
                await expect(page.locator(`[id="${id}"]`), id).toHaveCount(1);
            }
        });

        test('the progress reads as the status of the tile, set apart from the voiced line above it', async ({ page }) => {
            await chooseMode(page, 'full');

            const layout = await page.evaluate(() => {
                const started = document.querySelector('.welcomePanel .sbHomeTile[data-sb-home-key="getting-started"]');
                const line = started.querySelector('.sbHomeTileLine');
                const progress = started.querySelector('.sbHomeTileSub');
                const style = getComputedStyle(progress);
                return {
                    gap: progress.getBoundingClientRect().top - line.getBoundingClientRect().bottom,
                    weight: style.fontWeight,
                    numbers: style.fontVariantNumeric,
                    sameColour: style.color === getComputedStyle(line).color,
                    smaller: Number.parseFloat(style.fontSize) <= Number.parseFloat(getComputedStyle(line).fontSize),
                };
            });

            expect(layout.gap, 'space between the line and the progress').toBeGreaterThanOrEqual(10);
            expect(layout.weight).toBe('700');
            expect(layout.numbers).toContain('tabular-nums');
            expect(layout.sameColour, 'no accent colour').toBe(true);
            expect(layout.smaller, 'the label role is no larger than the line').toBe(true);
        });

        test('a tile shows a long voiced line in full, never cut, and the three tiles keep one height', async ({ page }) => {
            await chooseMode(page, 'full');
            const longer = `${HOME_COPY.tileGettingStarted} ${HOME_COPY.tileGettingStarted} ${HOME_COPY.tileGettingStarted}`;

            const result = await page.evaluate((text) => {
                const tilesNodes = [...document.querySelectorAll('.welcomePanel .sbHomeTile')];
                const lines = tilesNodes.map(node => node.querySelector('.sbHomeTileLine'));
                lines[1].textContent = text;
                const lineHeight = Number.parseFloat(getComputedStyle(lines[1]).lineHeight);
                return {
                    clamp: lines.map(line => getComputedStyle(line).webkitLineClamp),
                    clipped: lines.map(line => line.scrollHeight > line.clientHeight),
                    shownLines: Math.round(lines[1].getBoundingClientRect().height / lineHeight),
                    heights: new Set(tilesNodes.map(node => Math.round(node.getBoundingClientRect().height))).size,
                    kept: lines[1].textContent === text,
                };
            }, longer);

            expect(result.clamp, 'no line clamp is left').toEqual(['none', 'none', 'none']);
            expect(result.clipped, 'no line is cut').toEqual([false, false, false]);
            expect(result.shownLines, 'a long line takes the lines it needs').toBeGreaterThan(3);
            expect(result.heights, 'the tiles of a row keep one height').toBe(1);
            expect(result.kept).toBe(true);
        });

        test('with Getting Started hidden, Help and Bundled Extras each take half of the row', async ({ page }) => {
            await chooseMode(page, 'full');

            await setGettingStartedHidden(page, true);

            await expect(tiles(page).locator('.sbHomeTileTitle')).toHaveText(['Help', 'Bundled Extras']);
            await expect(tile(page, 'getting-started')).toHaveCount(0);
            const layout = await page.evaluate(() => {
                const row = document.querySelector('.welcomePanel [data-sb-home-region="tiles"]').getBoundingClientRect();
                const boxes = [...document.querySelectorAll('.welcomePanel .sbHomeTile')].map(node => node.getBoundingClientRect());
                const gap = parseFloat(getComputedStyle(document.querySelector('.welcomePanel [data-sb-home-region="tiles"]')).columnGap);
                return { half: (row.width - gap) / 2, widths: boxes.map(box => box.width), tops: boxes.map(box => Math.round(box.top)), left: row.left, right: row.right, edges: [boxes[0].left, boxes[1].right] };
            });
            expect(new Set(layout.tops).size).toBe(1);
            for (const width of layout.widths) {
                expect(Math.abs(width - layout.half)).toBeLessThanOrEqual(1);
            }
            expect(Math.abs(layout.edges[0] - layout.left)).toBeLessThanOrEqual(1);
            expect(Math.abs(layout.edges[1] - layout.right)).toBeLessThanOrEqual(1);
        });

        sizeFreeTest('Getting Started stays hidden when Home renders again, and Show Getting Started in the main menu brings it back first', async ({ page }) => {
            await chooseMode(page, 'full');
            await setGettingStartedHidden(page, true);

            await renderHome(page, []);
            await expect(tiles(page)).toHaveCount(2);
            await menuButton(page).click();
            await page.getByRole('menuitem', { name: 'Show Getting Started', exact: true }).click();

            await expect(tiles(page).locator('.sbHomeTileTitle')).toHaveText(TILE_TITLES);
            await expect(tile(page, 'getting-started')).toBeVisible();
            await menuButton(page).click();
            await expect(page.getByRole('menuitem', { name: 'Show Getting Started', exact: true })).toHaveCount(0);
            await escapeOpenMenu(page);
        });

        sizeFreeTest('the main menu offers Show Getting Started in Full and Compact, where the tile can show, and not in List Only', async ({ page }) => {
            await chooseMode(page, 'full');
            await setGettingStartedHidden(page, true);

            for (const [mode, offered] of [['list', false], ['compact', true], ['full', true]]) {
                await chooseMode(page, mode);
                await menuButton(page).click();
                await expect(page.getByRole('menuitem', { name: 'Show Welcome', exact: true })).toBeVisible();
                await expect(page.getByRole('menuitem', { name: 'Show Getting Started', exact: true }), mode).toHaveCount(offered ? 1 : 0);
                await escapeOpenMenu(page);
            }
        });

        sizeFreeTest('a Getting Started tile that comes back follows the display mode', async ({ page }) => {
            await chooseMode(page, 'compact');

            await setGettingStartedHidden(page, true);
            await setGettingStartedHidden(page, false);

            await expect(tile(page, 'getting-started')).toBeVisible();
            await expect(tiles(page).locator('.sbHomeTileTitle')).toHaveText(TILE_TITLES);
            await expect(page.locator('.welcomePanel .sbHomeTile:visible')).toHaveCount(3);
            await chooseMode(page, 'list');
            await expect(tile(page, 'getting-started')).toBeHidden();
            await chooseMode(page, 'full');
            await expect(tile(page, 'getting-started')).toBeVisible();
            await expect(tiles(page).first()).toHaveAttribute('data-sb-home-key', 'getting-started');
        });

        sizeFreeTest('the tile row never holds a Getting Started tile that every step has resolved', async ({ page }) => {
            await chooseMode(page, 'full');

            await page.evaluate(async () => {
                const { getSharedGettingStartedState } = await import('/scripts/sillybunny-home/getting-started.js');
                const state = getSharedGettingStartedState();
                ['connect', 'preset', 'character', 'chat'].forEach(id => state.setSkipped(id, true));
            });

            await expect(tiles(page)).toHaveCount(2);
        });

        test('the tile titles stay whole words on at most two lines', async ({ page }) => {
            await chooseMode(page, 'full');

            const titles = await page.evaluate(() => [...document.querySelectorAll('.welcomePanel .sbHomeTileTitle')].map((title) => {
                const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
                const textNode = title.firstChild;
                const range = document.createRange();
                let brokenWords = 0;
                let offset = 0;
                for (const word of textNode.textContent.split(' ')) {
                    range.setStart(textNode, offset);
                    range.setEnd(textNode, offset + word.length);
                    brokenWords += range.getClientRects().length > 1 ? 1 : 0;
                    offset += word.length + 1;
                }
                return { text: title.textContent, lines: Math.round(title.getBoundingClientRect().height / lineHeight), brokenWords, overflow: title.scrollWidth - title.clientWidth };
            }));

            for (const title of titles) {
                expect(title.lines, title.text).toBeLessThanOrEqual(2);
                expect(title.brokenWords, title.text).toBe(0);
                expect(title.overflow, title.text).toBeLessThanOrEqual(0);
            }
        });

        sizeFreeTest('the Assistants section holds Reisen, Tewi and a Choose Assistant card', async ({ page }) => {
            await chooseMode(page, 'full');
            const cards = page.locator('#chat > .welcomePanel .sbHomeCards > .sbHomeCard');

            await expect(cards).toHaveCount(3);
            await expect(assistantCards(page).locator('.sbHomeCardName')).toHaveText(ASSISTANT_NAMES);
            await expect(chooseCard(page).locator('.sbHomeCardName')).toHaveText('Choose Assistant');
            await expect(page.locator('.welcomePanel [data-sb-home-region="assistants"] details')).toHaveCount(0);
            await expect(page.locator('.welcomePanel [data-sb-home-region="assistants"]').getByRole('heading', { level: 2, name: 'Assistants' })).toBeVisible();
        });

        sizeFreeTest('each assistant card has a portrait, a name, a subtitle and a footer with three controls', async ({ page }) => {
            await chooseMode(page, 'full');

            for (const name of ASSISTANT_NAMES) {
                const card = assistantCard(page, name);
                await expect(card.locator(`[data-sb-art-placeholder="row-${name.toLowerCase()}"]`)).toBeVisible();
                await expect(card.locator('.sbHomeCardSub')).toHaveText(SUBTITLES[name]);
                await expect(card.locator('.sbHomeCardSub')).not.toHaveAttribute('data-sb-copy-placeholder', /./);
                await expect(card.locator('.sbHomeCardFooter > *')).toHaveCount(3);
                await expect(card.locator('.sbHomeFootButton i.fa-plus')).toHaveCount(1);
                await expect(card.locator('.sbHomeFootButton i.fa-hourglass-half')).toHaveCount(1);
                await expect(card.locator('.sbHomeRowMenu i.fa-ellipsis-vertical')).toHaveCount(1);
                await expect(card.locator('button')).toHaveCount(4);
            }
            const border = await assistantCard(page, 'Reisen').locator('.sbHomeCardFooter').evaluate(footer => getComputedStyle(footer).borderTopWidth);
            expect(border).toBe('1px');
        });

        sizeFreeTest('the card controls are named after their assistant, with a title, and the card button is described by its subtitle', async ({ page }) => {
            await chooseMode(page, 'full');

            for (const name of ASSISTANT_NAMES) {
                const card = assistantCard(page, name);
                const footButtons = card.locator('.sbHomeFootButton');
                await expect(card.locator('.sbHomeCardOpen')).toHaveAccessibleName(`New chat with ${name}`);
                await expect(card.locator('.sbHomeCardOpen')).toHaveAttribute('title', `New Chat With ${name}`);
                await expect(card.locator('.sbHomeCardOpen')).toHaveAccessibleDescription(SUBTITLES[name]);
                await expect(footButtons.nth(0)).toHaveAccessibleName(`Start new chat with ${name}`);
                await expect(footButtons.nth(0)).toHaveAttribute('title', `Start New Chat With ${name}`);
                await expect(footButtons.nth(1)).toHaveAccessibleName(`Temporary Chat with ${name}`);
                await expect(footButtons.nth(1)).toHaveAttribute('title', `Temporary Chat With ${name}`);
                await expect(card.locator('.sbHomeRowMenu')).toHaveAccessibleName(`Assistant Menu ${name}`);
                await expect(card.locator('.sbHomeRowMenu')).toHaveAttribute('aria-haspopup', 'menu');
                await expect(card.locator('.sbHomeRowMenu')).toHaveAttribute('aria-expanded', 'false');
            }
        });

        sizeFreeTest('Tab visits the card button, Start New Chat, Temporary Chat and the menu in that order', async ({ page }) => {
            await chooseMode(page, 'full');
            const card = assistantCard(page, 'Tewi');

            await card.locator('.sbHomeCardOpen').focus();
            for (const control of [card.locator('.sbHomeFootButton').nth(0), card.locator('.sbHomeFootButton').nth(1), card.locator('.sbHomeRowMenu')]) {
                await page.keyboard.press('Tab');
                await expect(control).toBeFocused();
            }
        });

        test('both footer labels are shown together or hidden together, and the footer never overflows', async ({ page }) => {
            await chooseMode(page, 'full');

            await expectFootersFit(page);
            await expectDefaultLabels(page, options.viewport.width);

            expect(footerProblems(await readFooters(page))).toEqual([]);
        });

        test('a larger font size keeps the menu button inside the card, and the labels come back with the default size', async ({ page }) => {
            await chooseMode(page, 'full');

            await setFontSize(page, 20);
            await expectFootersFit(page);
            expect(footerProblems(await readFooters(page)), 'at 20px').toEqual([]);
            await setFontSize(page, 15);
            await expectFootersFit(page);
            await expectDefaultLabels(page, options.viewport.width);

            expect(footerProblems(await readFooters(page)), 'back at 15px').toEqual([]);
        });

        test('long translated labels hide together and leave the menu button inside the card', async ({ page }) => {
            await chooseMode(page, 'full');
            await expectFootersFit(page);

            await useLongFooterLabels(page);

            await expectFootersFit(page);
            await expectLabelsShown(page, false);
            expect(footerProblems(await readFooters(page))).toEqual([]);
        });

        if (options.viewport.width >= 1440) {
            test('before the footer is measured again, long labels shrink to an ellipsis instead of pushing the menu button out', async ({ page }) => {
                await chooseMode(page, 'full');
                await expectLabelsShown(page, true);

                const footers = await page.evaluate((labels) => {
                    document.querySelectorAll('.welcomePanel .sbHomeCard:not(.sbHomeCard--choose)').forEach((card) => {
                        card.querySelectorAll('.sbHomeFootLabel').forEach((label, index) => { label.textContent = labels[index]; });
                    });
                    return [...document.querySelectorAll('.welcomePanel .sbHomeCard:not(.sbHomeCard--choose)')].map((card) => {
                        const footer = card.querySelector('.sbHomeCardFooter');
                        return {
                            overflow: footer.scrollWidth - footer.clientWidth,
                            menuOutside: card.querySelector('.sbHomeRowMenu').getBoundingClientRect().right - card.getBoundingClientRect().right,
                            ellipsised: [...footer.querySelectorAll('.sbHomeFootLabel')].filter(label => label.scrollWidth > label.clientWidth).length,
                            compact: card.hasAttribute('data-sb-footer-compact'),
                        };
                    });
                }, LONG_FOOTER_LABELS);

                for (const footer of footers) {
                    expect(footer.compact, 'no measure has run yet').toBe(false);
                    expect(footer.ellipsised, 'the labels were cut short').toBe(2);
                    expect(footer.overflow).toBeLessThanOrEqual(0);
                    expect(footer.menuOutside).toBeLessThanOrEqual(0);
                }
            });
        }

        test('the footer is measured again when the display mode changes the card back into view', async ({ page }) => {
            await chooseMode(page, 'full');
            await expectFootersFit(page);

            await chooseMode(page, 'list');
            await setFontSize(page, 20);
            await chooseMode(page, 'full');
            await expectFootersFit(page);
            expect(footerProblems(await readFooters(page)), 'after a larger font while hidden').toEqual([]);

            await chooseMode(page, 'list');
            await setFontSize(page, 15);
            await chooseMode(page, 'compact');
            await expectFootersFit(page);
            await chooseMode(page, 'full');
            await expectFootersFit(page);
            await expectDefaultLabels(page, options.viewport.width);

            expect(footerProblems(await readFooters(page)), 'back at the default font').toEqual([]);
        });

        test('the footer labels switch together at the width where both fit, and no width cuts a label or overflows the footer', async ({ page }) => {
            await chooseMode(page, 'full');
            await expectFootersFit(page);

            // Every second pixel, since the labels are cut short only in a band a few pixels wide just above the switch.
            const sweep = await page.evaluate(async () => {
                const card = document.querySelector('.welcomePanel .sbHomeCard[data-sb-home-key="assistant-reisen"]');
                const footer = card.querySelector('.sbHomeCardFooter');
                const labels = [...footer.querySelectorAll('.sbHomeFootLabel')];
                card.style.justifySelf = 'start';
                const steps = [];
                for (let width = 150; width <= 420; width += 2) {
                    card.style.width = `${width}px`;
                    for (let frame = 0; frame < 4; frame++) {
                        await new Promise(resolve => requestAnimationFrame(resolve));
                    }
                    const shown = labels.map(label => getComputedStyle(label).display !== 'none');
                    steps.push({
                        width,
                        shown,
                        cut: labels.filter((label, index) => shown[index] && label.scrollWidth > label.clientWidth).length,
                        overflow: footer.scrollWidth - footer.clientWidth,
                        menuOutside: card.querySelector('.sbHomeRowMenu').getBoundingClientRect().right - card.getBoundingClientRect().right,
                    });
                }
                return steps;
            });

            const broken = sweep.filter(step => new Set(step.shown).size !== 1 || step.cut > 0 || step.overflow > 0 || step.menuOutside > 0);
            expect(broken.map(step => step.width), 'widths with a split, cut or overflowing footer').toEqual([]);
            const shownWidths = sweep.filter(step => step.shown[0]).map(step => step.width);
            expect(sweep[0].shown[0], 'icon-only at the narrowest card').toBe(false);
            expect(shownWidths.length, 'labels appear at some width').toBeGreaterThan(0);
            expect(shownWidths, 'once shown, shown at every wider width').toEqual(sweep.filter(step => step.width >= Math.min(...shownWidths)).map(step => step.width));
        });

        test('pressing a footer button does not start the card action, and pressing the card or the empty footer space does', async ({ page }) => {
            await chooseMode(page, 'full');
            await page.evaluate(() => {
                window.qaCardActions = {};
                window.qaFooterClicks = [0, 0];
                document.querySelectorAll('.welcomePanel .sbHomeCard:not(.sbHomeCard--choose)').forEach((card) => {
                    const key = card.dataset.sbHomeKey;
                    window.qaCardActions[key] = 0;
                    // The capture phase sees the click before the control does, and stopping it keeps the real chat actions from leaving Home.
                    card.addEventListener('click', (event) => {
                        const footer = event.target.closest('.sbHomeFootButton');
                        if (footer && key === 'assistant-reisen') window.qaFooterClicks[[...card.querySelectorAll('.sbHomeFootButton')].indexOf(footer)]++;
                        if (event.target.closest('.sbHomeCardOpen')) window.qaCardActions[key]++;
                        if (footer || event.target.closest('.sbHomeCardOpen')) event.stopPropagation();
                    }, true);
                });
            });
            const card = assistantCard(page, 'Reisen');
            await card.scrollIntoViewIfNeeded();
            const centre = async (locator) => {
                const box = await locator.boundingBox();
                return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            };

            for (const control of [card.locator('.sbHomeFootButton').nth(0), card.locator('.sbHomeFootButton').nth(1)]) {
                const point = await centre(control);
                await page.mouse.click(point.x, point.y);
            }
            await card.locator('.sbHomeFootButton').nth(0).focus();
            await page.keyboard.press('Enter');
            await card.locator('.sbHomeFootButton').nth(1).focus();
            await page.keyboard.press('Space');
            const menuPoint = await centre(card.locator('.sbHomeRowMenu'));
            await page.mouse.click(menuPoint.x, menuPoint.y);
            await escapeOpenMenu(page);

            expect(await page.evaluate(() => window.qaFooterClicks), 'the footer buttons took a mouse click and a key press each').toEqual([2, 2]);
            expect(await page.evaluate(() => window.qaCardActions), 'footer controls').toEqual({ 'assistant-reisen': 0, 'assistant-tewi': 0 });

            // The footer strip takes no clicks of its own, so its padding, left of the first button, reaches the card.
            const footerBox = await card.locator('.sbHomeCardFooter').boundingBox();
            const spacePoint = { x: footerBox.x + 2, y: footerBox.y + footerBox.height / 2 };
            expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, spacePoint), 'what is under the empty footer space').toBe('sbHomeCardOpen');
            await page.mouse.click(spacePoint.x, spacePoint.y);

            expect(await page.evaluate(() => window.qaCardActions), 'empty footer space').toEqual({ 'assistant-reisen': 1, 'assistant-tewi': 0 });

            const bodyPoint = await centre(card.locator('.sbHomeCardName'));
            await page.mouse.click(bodyPoint.x, bodyPoint.y);

            expect(await page.evaluate(() => window.qaCardActions), 'card body').toEqual({ 'assistant-reisen': 2, 'assistant-tewi': 0 });
        });

        sizeFreeTest('pressing an assistant card fills the card, and pressing its menu button does not', async ({ page }) => {
            await chooseMode(page, 'full');
            const card = assistantCard(page, 'Reisen');
            await card.scrollIntoViewIfNeeded();
            const background = () => card.evaluate(node => getComputedStyle(node).backgroundColor);
            const centre = async (selector) => {
                const box = await card.locator(selector).boundingBox();
                return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            };

            const menuPoint = await centre('.sbHomeRowMenu');
            await page.mouse.move(menuPoint.x, menuPoint.y);
            const resting = await background();
            await page.mouse.down();
            await waitForAnimationFrames(page);
            const pressedMenu = await background();
            await page.mouse.up();
            await escapeOpenMenu(page);

            const bodyPoint = await centre('.sbHomeCardName');
            await page.mouse.move(bodyPoint.x, bodyPoint.y);
            await page.mouse.down();
            // The pressed style lands on the next frame, so a read right after the press can still see the resting fill.
            await expect.poll(background, { timeout: 2000 }).not.toBe(resting);
            await page.mouse.up();

            expect(pressedMenu).toBe(resting);
        });

        sizeFreeTest('the card, Start New Chat and Temporary Chat of a card with a file are enabled controls and no stubs', async ({ page }) => {
            await chooseMode(page, 'full');
            const card = assistantCard(page, 'Reisen');

            for (const control of [card.locator('.sbHomeCardOpen'), card.locator('.sbHomeFootButton').nth(0), card.locator('.sbHomeFootButton').nth(1)]) {
                await expect(control).toBeEnabled();
                await expect(control).not.toHaveAttribute('data-sb-stub', /.*/);
            }
            await expect(card).not.toHaveAttribute('data-sb-stub', /.*/);
        });

        test('the Assistant Menu offers the chat mode other than the last one, and Escape closes it', async ({ page }) => {
            await chooseMode(page, 'full');
            const card = assistantCard(page, 'Reisen');
            const trigger = card.getByRole('button', { name: 'Assistant Menu' });

            await trigger.click();
            const menu = page.getByRole('menu', { name: 'Assistant Menu' });
            await expect(menu).toBeVisible();
            await expect(trigger).toHaveAttribute('aria-expanded', 'true');
            await expect(menu.getByRole('menuitem')).toHaveText(['New Chat in Conversation']);
            await expect(menu.getByRole('menuitem').locator('i')).toHaveCount(1);
            await expect(menu.getByRole('menuitem')).not.toHaveAttribute('data-sb-stub', /.*/);
            const menuBox = await menu.boundingBox();
            const panelBox = await measure(page, '#chat > .welcomePanel');
            expect(menuBox.x).toBeGreaterThanOrEqual(Math.max(0, panelBox.left) - 1);
            expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(Math.min(page.viewportSize().width, panelBox.right) + 1);

            await escapeOpenMenu(page);
            await expect(menu).toHaveCount(0);
            await expect(trigger).toBeFocused();
            await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
            await expect(page.locator('dialog[open]')).toHaveCount(0);
        });

        sizeFreeTest('the Assistant Menu opens from the keyboard and offers Roleplay after Conversation', async ({ page }) => {
            await page.evaluate(async () => {
                const { recordChatMode } = await import('/scripts/sillybunny-chat-mode-memory.js');
                recordChatMode('conversation');
            });
            await renderHome(page, []);
            await chooseMode(page, 'full');
            const trigger = assistantCard(page, 'Tewi').getByRole('button', { name: 'Assistant Menu' });

            await trigger.focus();
            await page.keyboard.press('Enter');

            const menu = page.getByRole('menu', { name: 'Assistant Menu' });
            await expect(menu.getByRole('menuitem')).toHaveText(['New Chat in Roleplay']);
            await expect(menu.getByRole('menuitem').first()).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(trigger).toBeFocused();
        });

        test('Choose Assistant is a card without a footer, the size of the card of Reisen', async ({ page }) => {
            await chooseMode(page, 'full');

            const layout = await measureChooseCard(page);

            expect(layout).toMatchObject({ footers: 0, icon: 1, chevrons: 0, key: 'assistant-own', stub: undefined, label: 'Choose Assistant' });
            expect(Math.abs(layout.choose.width - layout.reisen.width), 'width').toBeLessThanOrEqual(1);
            expect(Math.abs(layout.choose.height - layout.reisen.height), 'height').toBeLessThanOrEqual(1);
        });

        if (options.viewport.width > TWO_CARDS_MAX) {
            test('Choose Assistant is in the line of Reisen and Tewi', async ({ page }) => {
                await chooseMode(page, 'full');

                const layout = await measureChooseCard(page);

                expect(layout.panelWidth).toBeGreaterThan(TWO_CARDS_MAX);
                expect(layout.choose.top, 'in the same line').toBe(layout.reisen.top);
            });
        } else {
            test('Choose Assistant is alone in the first column of the second line under two cards per line', async ({ page }) => {
                await chooseMode(page, 'full');

                const layout = await measureChooseCard(page);

                expect(layout.panelWidth).toBeLessThanOrEqual(TWO_CARDS_MAX);
                expect(layout.reisen.top).toBe(layout.tewi.top);
                expect(layout.choose.top, 'under the cards').toBeGreaterThan(layout.reisen.top + layout.reisen.height - 1);
                expect(Math.abs(layout.choose.left - layout.reisen.left), 'first column').toBeLessThanOrEqual(1);
            });
        }

        test('Compact keeps the card footers and hides the portraits', async ({ page }) => {
            await chooseMode(page, 'compact');

            await expect(page.locator('.welcomePanel [data-sb-art-placeholder^="row-"]:visible')).toHaveCount(0);
            await expect(page.locator('.welcomePanel .sbHomeFootButton:visible')).toHaveCount(4);
            await expect(chooseCard(page)).toBeVisible();
            const heights = await page.evaluate(() => [...document.querySelectorAll('.welcomePanel .sbHomeCard')].map(card => Math.round(card.getBoundingClientRect().height)));
            expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
        });

        test('the Recent Chats filters stay in one row that scrolls sideways without a scrollbar', async ({ page }) => {
            await chooseMode(page, 'full');

            const filters = await page.evaluate(() => {
                const row = document.querySelector('.welcomePanel .welcomeRecentTabs');
                const buttons = [...row.querySelectorAll('.welcomeRecentTab:not(.displayNone)')];
                const before = { tops: buttons.map(button => Math.round(button.getBoundingClientRect().top)), overflowX: getComputedStyle(row).overflowX };
                row.style.width = '180px';
                row.style.flex = 'none';
                const narrow = {
                    tops: buttons.map(button => Math.round(button.getBoundingClientRect().top)),
                    scrolls: row.scrollWidth > row.clientWidth,
                    scrollbarHeight: row.offsetHeight - row.clientHeight,
                    scrollbarWidthStyle: getComputedStyle(row).scrollbarWidth,
                };
                buttons[buttons.length - 1].focus();
                const focusedScroll = row.scrollLeft;
                return { before, narrow, focusedScroll, count: buttons.length };
            });

            expect(filters.count).toBe(4);
            expect(new Set(filters.before.tops).size, 'one row at the natural width').toBe(1);
            expect(filters.before.overflowX).toBe('auto');
            expect(new Set(filters.narrow.tops).size, 'one row when squeezed').toBe(1);
            expect(filters.narrow.scrolls).toBe(true);
            expect(filters.narrow.scrollbarHeight).toBeLessThanOrEqual(0);
            expect(filters.narrow.scrollbarWidthStyle).toBe('none');
            expect(filters.focusedScroll, 'keyboard focus scrolls the row').toBeGreaterThan(0);
        });

        test('the filters stay inside the Recent Chats heading row', async ({ page }) => {
            await chooseMode(page, 'full');

            const inside = await page.evaluate(() => {
                const filters = document.querySelector('.welcomePanel .welcomeRecentTabs').getBoundingClientRect();
                const header = document.querySelector('.welcomePanel [data-sb-home-region="recent-chats"] .sbHomeGroupHeader').getBoundingClientRect();
                return filters.right <= header.right + 1 && filters.left >= header.left - 1;
            });

            expect(inside).toBe(true);
        });

        if (options.viewport.width >= 1024) {
            test('on a wide container the filters sit beside the Recent Chats heading', async ({ page }) => {
                await chooseMode(page, 'full');

                const beside = await page.evaluate(() => document.querySelector('.welcomePanel .welcomeRecentTabs').getBoundingClientRect().top
                    < document.getElementById('welcome-recent-title').getBoundingClientRect().bottom);

                expect(beside).toBe(true);
            });
        }

        for (const mode of ['full', 'compact']) {
            for (const footer of ['labelled', 'icon-only']) {
                sizeFreeTest(`every icon-only control in ${mode} has a tooltip and a name, and no labelled control repeats its label, with ${footer} card footers`, async ({ page }) => {
                    const characters = await pickFixtureCharacters(page, 2);
                    await renderHome(page, recentChatEntries(characters, 5, { distinctFiles: true }));
                    await chooseMode(page, mode);
                    await expect(page.locator('.welcomePanel button.showMoreChats')).toBeVisible();

                    const controls = await page.evaluate((icons) => {
                        const visibleText = (node, pieces = []) => {
                            let text = '';
                            const walk = (child) => {
                                if (child.nodeType === 3) {
                                    text += child.textContent;
                                    if (child.textContent.trim()) {
                                        pieces.push(child.textContent.replace(/\s+/g, ' ').trim());
                                    }
                                    return;
                                }
                                if (child.nodeType !== 1) {
                                    return;
                                }
                                const style = getComputedStyle(child);
                                if (style.display === 'none' || style.visibility === 'hidden' || child.getAttribute('aria-hidden') === 'true' || child.classList.contains('sr-only')) {
                                    return;
                                }
                                child.childNodes.forEach(walk);
                            };
                            node.childNodes.forEach(walk);
                            return text.replace(/\s+/g, ' ').trim();
                        };
                        document.querySelectorAll('.welcomePanel .sbHomeCard[data-sb-footer-compact]').forEach(card => card.removeAttribute('data-sb-footer-compact'));
                        if (icons) {
                            document.querySelectorAll('.welcomePanel .sbHomeCard').forEach((card) => {
                                if (card.querySelector('.sbHomeCardFooter')) {
                                    card.setAttribute('data-sb-footer-compact', '');
                                }
                            });
                        }
                        const found = [...document.querySelectorAll('.welcomePanel button, .welcomePanel a[href]')].filter(node => node.getClientRects().length > 0);
                        return found.map((node, index) => {
                            node.dataset.qaAudit = String(index);
                            const pieces = [];
                            return {
                                index,
                                kind: node.className,
                                text: visibleText(node, pieces),
                                pieces,
                                hasIcon: node.querySelector('i, svg, [class*="fa-"]') !== null,
                                title: node.getAttribute('title') ?? '',
                            };
                        });
                    }, footer === 'icon-only');

                    const iconOnly = controls.filter(control => control.hasIcon && control.text === '');
                    const labelled = controls.filter(control => control.text !== '');
                    expect(iconOnly.map(control => control.kind.split(' ')[0]), 'the icon-only controls of Home').toEqual(expect.arrayContaining(['sbHomeMenuButton', 'pinChat', 'chatMenu', 'showMoreChats', 'sbHomeRowMenu']));
                    const footerButtons = controls.filter(control => control.kind.startsWith('sbHomeFootButton'));
                    expect(footerButtons.length, 'the footer buttons').toBeGreaterThan(0);
                    expect(footerButtons.map(control => control.text === ''), 'the footer buttons show their label or not').toEqual(footerButtons.map(() => footer === 'icon-only'));

                    for (const control of iconOnly) {
                        expect(control.title.trim(), `${control.kind} has a tooltip`).not.toBe('');
                        await expect(page.locator(`[data-qa-audit="${control.index}"]`), `${control.kind} has an accessible name`).toHaveAccessibleName(/\S/);
                    }
                    for (const control of labelled) {
                        const labels = [control.text, ...control.pieces].map(label => label.trim().toLowerCase());
                        expect(labels, `${control.kind} "${control.text}" repeats its label in the tooltip "${control.title}"`).not.toContain(control.title.trim().toLowerCase());
                    }
                });
            }
        }

        sizeFreeTest('the pin tooltips are header-capitalised and follow the state of the chat', async ({ page }) => {
            const characters = await pickFixtureCharacters(page, 1);
            await renderHome(page, recentChatEntries(characters, 1));
            const pin = page.locator('.welcomePanel .recentChat .pinChat').first();

            await expect(pin).toHaveAttribute('title', 'Pin Chat');
            await expect(pin).toHaveAccessibleName('Pin Chat');

            await pin.click();

            const pinned = page.locator('.welcomePanel .recentChat .pinChat').first();
            await expect(pinned).toHaveAttribute('title', 'Unpin Chat');
            await expect(pinned).toHaveAccessibleName('Unpin Chat');
            await pinned.click();
            await expect(page.locator('.welcomePanel .recentChat .pinChat').first()).toHaveAttribute('title', 'Pin Chat');
        });

        sizeFreeTest('the fork notice link is separate from its sentence and opens SillyTavern safely', async ({ page }) => {
            const link = page.locator('.welcomePanel a[href="https://github.com/SillyTavern/SillyTavern"]');

            await expect(link).toHaveText('SillyTavern');
            await expect(link).toHaveAttribute('target', '_blank');
            await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
            await expect(page.locator('.welcomePanel .sbHomeFork p')).toHaveText(HOME_COPY.heroFork);
            await expect(page.locator('.welcomePanel .sbHomeFork p a')).toHaveCount(0);
        });

        test('art placeholders keep their native size and are hidden from assistive technology', async ({ page }) => {
            await chooseMode(page, 'full');
            await renderHome(page, []);
            const panelWidth = await page.evaluate(() => document.querySelector('.welcomePanel').clientWidth);
            const sizes = pixelArtSizes(panelWidth);

            for (const [id, [width, height]] of Object.entries(sizes)) {
                const box = page.locator(`.welcomePanel ${artSelector(id)}`);
                await expect(box).toBeVisible();
                await expect(box).toHaveAttribute('aria-hidden', 'true');
                await expect(box).toHaveText(id);
                const rect = await measure(page, `.welcomePanel ${artSelector(id)}`);
                expect([id, Math.round(rect.width), Math.round(rect.height)]).toEqual([id, width, height]);
            }
            const logo = page.locator('.welcomePanel [data-sb-art-placeholder="logo-32"]');
            await expect(logo).toBeVisible();
            await expect(logo).toHaveAttribute('aria-hidden', 'true');
            const logoRect = await measure(page, '.welcomePanel [data-sb-art-placeholder="logo-32"]');
            expect([Math.round(logoRect.width), Math.round(logoRect.height)]).toEqual(LOGO_SIZE);

            // The hero is a picture, not a stand-in: one image, hidden from assistive technology, at a size that fits the band.
            const hero = await settledRead(page, readHero);
            expect(hero.pictures).toBe(1);
            expect(hero.ariaHidden).toBe('true');
            expect(hero.rendering).toBe(expectedRendering(hero));
            expect(hero.size[0]).toBeCloseTo(hero.expected[0], 0);
            expect(hero.size[1]).toBeCloseTo(hero.expected[1], 0);
            await expect(page.locator(`.welcomePanel ${artSelector('hero-duo')} img`)).toHaveAttribute('alt', '');

            await chooseMode(page, 'compact');
            await expect(page.locator('.welcomePanel [data-sb-art-placeholder="logo-32"]')).toBeVisible();
            await expect(page.locator('.welcomePanel [data-sb-art-placeholder="empty-tewi"]')).toBeHidden();
            await expect(page.locator('.welcomePanel [data-sb-art-placeholder="row-reisen"]')).toBeHidden();
        });

        test('the hero is the day scene at 12:00 and the night scene at 20:00, picked when Home renders and not while it is shown', async ({ page }) => {
            await chooseMode(page, 'full');
            const hero = id => page.locator(`.welcomePanel [data-sb-art-placeholder="${id}"]`);

            await page.clock.setFixedTime(new Date(2026, 9, 30, 12, 0));
            await renderHome(page, []);
            await expect(hero('hero-duo')).toHaveCount(1);
            await expect(hero('hero-duo-night')).toHaveCount(0);

            await page.clock.setFixedTime(new Date(2026, 9, 30, 20, 0));
            await expect(hero('hero-duo'), 'the hero stays while Home is shown').toHaveCount(1);
            await renderHome(page, []);
            await expect(hero('hero-duo-night')).toHaveCount(1);
            await expect(hero('hero-duo')).toHaveCount(0);
            await expect(hero('hero-duo-night').locator('xpath=..'), 'the panel around the figure is what hides it').toHaveAttribute('aria-hidden', 'true');
            await expect(hero('hero-duo-night').locator('img')).toHaveAttribute('src', /\/img\/sillybunny\/hero-duo-night@native\.webp\?v=/);
            const night = await settledRead(page, readHero);
            expect(night.id).toBe('hero-duo-night');
            expect(night.size[0]).toBeCloseTo(night.expected[0], 0);
            expect(night.size[1]).toBeCloseTo(night.expected[1], 0);
            expect(night.rendering).toBe(expectedRendering(night));

            await page.clock.setFixedTime(new Date(2026, 9, 31, 6, 0));
            await renderHome(page, []);
            await expect(hero('hero-duo')).toHaveCount(1);
        });

        test('the hero band is a bordered Window-layer card with the art and the project info centred', async ({ page }) => {
            await chooseMode(page, 'full');

            const band = await page.evaluate(() => {
                const bandNode = document.querySelector('.welcomePanel [data-sb-home-region="hero"]');
                const style = getComputedStyle(bandNode);
                const box = bandNode.getBoundingClientRect();
                const centre = node => (node.getBoundingClientRect().left + node.getBoundingClientRect().right) / 2;
                const probe = document.createElement('div');
                probe.style.cssText = 'position: absolute; visibility: hidden; background: var(--sb-layer-window);';
                document.body.append(probe);
                const windowLayer = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return {
                    border: style.borderTopWidth,
                    radius: style.borderTopLeftRadius,
                    background: style.backgroundColor,
                    windowLayer,
                    centre: (box.left + box.right) / 2,
                    artCentre: centre(bandNode.querySelector(':is([data-sb-art-placeholder="hero-duo"], [data-sb-art-placeholder="hero-duo-night"])')),
                    textCentre: centre(bandNode.querySelector('.sbHomeHeroText')),
                    textAlign: getComputedStyle(bandNode.querySelector('.sbHomeHeroText')).textAlign,
                    textWidth: bandNode.querySelector('.sbHomeHeroText').getBoundingClientRect().width,
                    fontSize: parseFloat(getComputedStyle(bandNode.querySelector('.sbHomeDescription')).fontSize),
                };
            });

            expect(band.border).toBe('1px');
            expect(band.radius).toBe('20px');
            expect(band.background).toBe(band.windowLayer);
            expect(Math.abs(band.artCentre - band.centre)).toBeLessThanOrEqual(1);
            expect(Math.abs(band.textCentre - band.centre)).toBeLessThanOrEqual(1);
            expect(band.textAlign).toBe('center');
            expect(band.textWidth, 'readable measure').toBeLessThanOrEqual(band.fontSize * 70);
        });

        sizeFreeTest('the project info says its three lines in order, the fork link apart from its sentence', async ({ page }) => {
            await chooseMode(page, 'full');

            const lines = await page.locator('.welcomePanel [data-sb-home-region="hero"] :is(.sbHomeDescription, .sbHomeFork p, .sbHomeGreeting)')
                .evaluateAll(nodes => nodes.map(node => node.textContent));

            expect(lines).toEqual([HOME_COPY.heroDescription, HOME_COPY.heroFork, HOME_COPY.heroGreeting]);
        });

        sizeFreeTest('an empty Recent Chats list shows its heading and body and no filtered state', async ({ page }) => {
            await chooseMode(page, 'full');
            await renderHome(page, []);

            const empty = page.locator('.welcomePanel [data-sb-home-empty="all"]');
            await expect(empty.locator('.sbHomeEmptyTitle')).toHaveText(HOME_COPY.recentEmptyHead);
            await expect(empty.locator('.sbHomeEmptyDescription')).toHaveText(HOME_COPY.recentEmptyBody);
            await expect(page.locator('.welcomePanel [data-recent-chat-empty-state="filtered"]')).toBeHidden();
        });

        sizeFreeTest('Recent Chats lists, filters and expands', async ({ page }) => {
            const characters = await pickFixtureCharacters(page, 2);
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
            await expect(filtered.locator('.sb-status-page__title')).toHaveText(HOME_COPY.recentFilterEmptyHead);
            await expect(filtered.locator('.sb-status-page__description')).toHaveText(HOME_COPY.recentFilterEmptyBody);

            await page.locator('.welcomePanel [data-recent-chat-filter="individual"]').click();
            await expect(filtered).toBeHidden();
            await expect(rows).toHaveCount(3);
        });

        sizeFreeTest('a Recent Chats entry opens its chat', async ({ page }) => {
            const characters = await pickFixtureCharacters(page, 1);
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

        sizeFreeTest('pinning a chat re-renders Home in place without announcing a Home state change', async ({ page }) => {
            const characters = await pickFixtureCharacters(page, 2);
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

        sizeFreeTest('a pinned chat keeps keyboard focus on its pin control after Home renders again', async ({ page }) => {
            const characters = await pickFixtureCharacters(page, 1);
            expect(characters.length).toBeGreaterThan(0);
            await renderHome(page, recentChatEntries(characters, 3, { distinctFiles: true }));
            const row = page.locator('.welcomePanel .recentChat[data-file="qa-home-2"]');

            await row.locator('.pinChat').focus();
            await page.keyboard.press('Enter');

            await expect(row.locator('.pinChat')).toHaveAttribute('aria-pressed', 'true');
            await expect(row.locator('.pinChat')).toBeFocused();
        });

        sizeFreeTest('a pin activated by a pointer that does not focus buttons still keeps focus on the pin control', async ({ page }) => {
            const characters = await pickFixtureCharacters(page, 1);
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

        sizeFreeTest('Recent Chats Settings returns focus to the main menu button after it saves', async ({ page }) => {
            await menuButton(page).click();
            await page.getByRole('menuitem', { name: 'Recent Chats Settings', exact: true }).click();
            await expect(page.locator('#maxRecentChats')).toBeVisible();

            await page.locator('dialog[open] .popup-button-ok').click();

            await expect(page.locator('#maxRecentChats')).toHaveCount(0);
            await expect(menuButton(page)).toBeFocused();
        });

        test('each Recent Chats row holds two controls and a Chat Menu with Rename and Delete', async ({ page }) => {
            const characters = await pickFixtureCharacters(page, 1);
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

        sizeFreeTest('Delete from the Chat Menu confirms, and focus lands on the row that took its place', async ({ page }) => {
            const characters = await pickFixtureCharacters(page, 1);
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

        sizeFreeTest('cancelling Delete leaves focus on the Chat Menu button', async ({ page }) => {
            const characters = await pickFixtureCharacters(page, 1);
            expect(characters.length).toBeGreaterThan(0);
            await renderHome(page, recentChatEntries(characters, 2, { distinctFiles: true }));
            const trigger = page.locator('.welcomePanel .recentChat[data-file="qa-home-0"] .chatMenu');

            await trigger.click();
            await page.getByRole('menuitem', { name: 'Delete' }).click();
            await page.locator('dialog[open] .popup-button-cancel').click();

            await expect(page.locator('dialog[open]')).toHaveCount(0);
            await expect(trigger).toBeFocused();
        });

        test.describe('Getting Started progress', () => {
            test.use({ bundledCardsOnly: true });

            sizeFreeTest('the Getting Started tile shows the progress in one string and opens its window', async ({ page }) => {
                await chooseMode(page, 'full');
                const started = tile(page, 'getting-started');

                await expect(started.locator('.sbHomeTileSub')).toHaveText('0 of 4');
                await expect(started.locator('.sbHomeTileSub')).not.toHaveAttribute('data-sb-copy-placeholder', /.*/);
                await expect(started).not.toHaveAttribute('data-sb-stub', /.*/);
                await expect(started).not.toHaveAttribute('aria-expanded', /.*/);

                await started.click();

                await expect(page.locator('dialog.sb-dialog-host')).toHaveAccessibleName('Getting Started');
                await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on');
                await expect(page.locator('.welcomePanel details')).toHaveCount(0);
            });

            sizeFreeTest('every tile says its voiced line, and only Getting Started has a progress', async ({ page }) => {
                await chooseMode(page, 'full');

                for (const [key, text] of [['getting-started', HOME_COPY.tileGettingStarted], ['help', HOME_COPY.tileHelp], ['extras', HOME_COPY.tileExtras]]) {
                    const line = tile(page, key).locator('.sbHomeTileLine');
                    await expect(line, key).toHaveText(text);
                    await expect(line, key).not.toHaveAttribute('data-sb-copy-placeholder', /.*/);
                }
                await expect(tile(page, 'getting-started').locator('.sbHomeTileSub')).toHaveText('0 of 4');
                await expect(tile(page, 'help').locator('.sbHomeTileSub')).toHaveCount(0);
                await expect(tile(page, 'extras').locator('.sbHomeTileSub')).toHaveCount(0);
                await expect(tile(page, 'help')).not.toHaveAttribute('data-sb-stub', /.*/);
                await expect(tile(page, 'extras')).not.toHaveAttribute('data-sb-stub', /.*/);
            });

            sizeFreeTest('a tile is named by its title and described by its voiced line and progress, and Compact leaves the line out of the description', async ({ page }) => {
                await chooseMode(page, 'full');

                await expect(tile(page, 'getting-started')).toHaveAccessibleName('Getting Started');
                await expect(tile(page, 'getting-started')).toHaveAccessibleDescription(`${HOME_COPY.tileGettingStarted} 0 of 4`);
                await expect(tile(page, 'help')).toHaveAccessibleName('Help');
                await expect(tile(page, 'help')).toHaveAccessibleDescription(HOME_COPY.tileHelp);
                await expect(tile(page, 'extras')).toHaveAccessibleName('Bundled Extras');
                await expect(tile(page, 'extras')).toHaveAccessibleDescription(HOME_COPY.tileExtras);

                await chooseMode(page, 'compact');

                await expect(tile(page, 'help')).toHaveAccessibleName('Help');
                await expect(tile(page, 'help')).toHaveAccessibleDescription('');
                await expect(tile(page, 'extras')).toHaveAccessibleName('Bundled Extras');
                await expect(tile(page, 'extras')).toHaveAccessibleDescription('');
                await expect(tile(page, 'getting-started'), 'only the progress is left in the description').toHaveAttribute('aria-describedby', 'sb-home-tile-getting-started-progress');
            });
        });
    });
}

for (const { name, options } of WIDE_VIEWPORTS) {
    test.describe(`Home shell width at ${name}`, () => {
        test.use(options);

        test.beforeEach(async ({ page }) => {
            await protectMaintainerServer(page);
            await installFixtureChats(page, { accountStorage: PINNED_ASSISTANT_ACCOUNT });
            await stubAssistantCards(page, [REISEN_AVATAR, TEWI_AVATAR]);
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
            const characters = await pickFixtureCharacters(page, 1);
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
            const characters = await pickFixtureCharacters(page, 1);
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
            const characters = await pickFixtureCharacters(page, 1);
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

        for (const percent of [25, 55, 100]) {
            test(`Page Width ${percent} sets the Home width, and the panel fills the shell`, async ({ page }) => {
                const windowWidth = page.viewportSize().width;
                const expected = Math.round(Math.min(Math.max(HOME_SHELL_WIDTH, windowWidth * percent / 100), windowWidth - 32));

                await page.evaluate(value => document.documentElement.style.setProperty('--sheldWidth', `${value}vw`), percent);

                await expect.poll(async () => Math.round((await measure(page, '#sheld')).width)).toBe(expected);
                const edges = await page.evaluate(() => {
                    const rect = selector => document.querySelector(selector).getBoundingClientRect();
                    return { shell: rect('#sheld'), panel: rect('#chat > .welcomePanel') };
                });
                expect(Math.abs(edges.panel.width - edges.shell.width), 'panel fills the shell').toBeLessThanOrEqual(20);
            });
        }

        for (const [target, narrow] of [[TWO_CARDS_MAX, true], [TWO_CARDS_MAX + 1, false]]) {
            test(`a Home content width of exactly ${target}px has ${narrow ? 'two assistant cards per line' : 'the assistant cards in one row'}`, async ({ page }) => {
                await chooseMode(page, 'full');

                await setHomeContentWidth(page, target);

                const layout = await page.evaluate(() => {
                    const tops = [...document.querySelectorAll('.welcomePanel .sbHomeCard')].map(card => Math.round(card.getBoundingClientRect().top));
                    return { panel: document.querySelector('.welcomePanel').clientWidth, rows: new Set(tops).size };
                });
                expect(layout.panel).toBe(target);
                expect(layout.rows).toBe(narrow ? 2 : 1);
            });
        }

        test('with the text at 24px, taller than the header row, the version below the title ends where the header ends', async ({ page }) => {
            await chooseMode(page, 'full');
            await page.evaluate(() => document.documentElement.style.setProperty('--mainFontSize', '24px'));
            await lengthenVersionToTouchButton(page);

            const header = await readHeader(page);

            await expect(page.locator('.welcomePanel .sbHomeHeader')).toHaveAttribute(VERSION_BELOW, '');
            expect(header.title.height, 'the title line is taller than the 44px row').toBeGreaterThan(44);
            expect(Math.abs(header.versionLine.bottom - header.row.bottom), 'no spare space below the version').toBeLessThanOrEqual(1);
        });

        for (const fontSize of ['15px', '20px']) {
            test(`at every content width with ${fontSize} text the title is centred and the version is clear of the menu button`, async ({ page }) => {
                await chooseMode(page, 'full');
                await page.evaluate(size => document.documentElement.style.setProperty('--mainFontSize', size), fontSize);
                const measured = [];

                for (const width of [300, 346, 360, 420, 480, 560, 741, 1000]) {
                    await setHomeContentWidth(page, width);
                    await waitForAnimationFrames(page, 3);
                    const header = await readHeader(page);
                    const clear = isClearOfButton(header);
                    const centred = Math.abs(centreX(header.text) - centreX(header.column)) <= 1;
                    const online = Math.abs(centreY(header.button) - centreY(header.text)) <= 1;
                    measured.push({ width, clear, centred, online });
                }

                expect(measured.filter(row => !(row.clear && row.centred && row.online))).toEqual([]);
            });
        }

        for (const [target, scale] of [[PORTRAIT_ONE_X_MAX, 1], [PORTRAIT_ONE_X_MAX + 1, 2]]) {
            test(`a Home content width of exactly ${target}px draws the assistant portraits and the Choose Assistant icon at ${scale}x`, async ({ page }) => {
                await chooseMode(page, 'full');

                await setHomeContentWidth(page, target);

                const sizes = {};
                for (const [id, selector] of Object.entries({
                    'row-reisen': '[data-sb-art-placeholder="row-reisen"]',
                    'row-tewi': '[data-sb-art-placeholder="row-tewi"]',
                    'choose-icon': '.sbHomeCard--choose .sbHomeChooseIcon',
                })) {
                    const box = await measure(page, `.welcomePanel ${selector}`);
                    sizes[id] = [Math.round(box.width), Math.round(box.height)];
                }
                expect(sizes).toEqual({
                    'row-reisen': [64 * scale, 64 * scale],
                    'row-tewi': [64 * scale, 64 * scale],
                    'choose-icon': [64 * scale, 64 * scale],
                });
                // The card portraits are smooth pictures, so they are not drawn as pixel art.
                expect(await page.locator('.welcomePanel [data-sb-art-placeholder="row-reisen"]').evaluate(node => getComputedStyle(node).imageRendering)).toBe('auto');
            });
        }
    });
}

test.describe('Home filtered empty state', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('stays invisible until the shared styles of the status page arrive, then shows styled', async ({ page }) => {
        await protectMaintainerServer(page);
        await installFixtureChats(page);
        let releaseSheet = () => {};
        const sheetGate = new Promise((resolve) => { releaseSheet = resolve; });
        await page.route('**/sillybunny-editor-shell.css*', async (route) => {
            await sheetGate;
            await route.continue();
        });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expectHome(page);
        await page.waitForFunction(() => window.SillyTavern?.getContext?.().characters?.some(character => character?.avatar), undefined, { timeout: STARTUP_TIMEOUT });
        const characters = await pickFixtureCharacters(page, 1);
        await renderHome(page, recentChatEntries(characters, 1, { distinctFiles: true }));
        const filtered = page.locator('.welcomePanel [data-recent-chat-empty-state="filtered"]');

        await page.locator('.welcomePanel [data-recent-chat-filter="group"]').click();

        await expect(filtered).not.toHaveClass(/displayNone/);
        await expect(filtered).toHaveCSS('visibility', 'hidden');
        releaseSheet();
        await expect(filtered).toHaveCSS('visibility', 'visible');
        await expect(filtered.locator('.sb-status-page')).toHaveCSS('display', 'flex');
        await expect(filtered.locator('.sb-status-page__title')).toHaveText(HOME_COPY.recentFilterEmptyHead);
    });
});

test.describe('Home Recent Chats empty states', () => {
    const EMPTY = '.welcomePanel [data-sb-home-empty="all"]';

    /** Reads the geometry and type of the empty state, and what the shared type tokens resolve to. */
    async function readEmptyState(page) {
        return page.evaluate((selector) => {
            const root = document.querySelector(selector);
            const box = node => node.getBoundingClientRect();
            const centre = node => (box(node).left + box(node).right) / 2;
            const art = root.querySelector('.sbArtPanel');
            const figure = art.querySelector('.sbArtFigure');
            const title = root.querySelector('.sbHomeEmptyTitle');
            const body = root.querySelector('.sbHomeEmptyDescription');
            const probe = document.createElement('div');
            probe.style.cssText = 'position: absolute; visibility: hidden; font-size: var(--sb-type-headline); color: var(--sb-muted-fg);';
            const bodyProbe = document.createElement('div');
            bodyProbe.style.cssText = 'position: absolute; visibility: hidden; font-size: var(--sb-type-body);';
            document.body.append(probe, bodyProbe);
            const tokens = { headline: getComputedStyle(probe).fontSize, body: getComputedStyle(bodyProbe).fontSize, muted: getComputedStyle(probe).color };
            probe.remove();
            bodyProbe.remove();
            const style = node => getComputedStyle(node);
            return {
                role: root.getAttribute('role'),
                titleTag: title.tagName,
                bodyTag: body.tagName,
                art: {
                    hidden: getComputedStyle(art).display === 'none',
                    mode: art.dataset.sbArtMode,
                    id: figure.dataset.sbArtPlaceholder,
                    width: box(figure).width,
                    height: box(figure).height,
                    left: box(art).left,
                    right: box(art).right,
                    bottom: box(art).bottom,
                    centre: centre(art),
                    ariaHidden: art.getAttribute('aria-hidden'),
                    rendering: getComputedStyle(figure.firstElementChild).imageRendering,
                },
                title: { top: box(title).top, bottom: box(title).bottom, left: box(title).left, centre: centre(title), align: style(title).textAlign, size: style(title).fontSize, weight: style(title).fontWeight },
                body: { top: box(body).top, left: box(body).left, centre: centre(body), align: style(body).textAlign, size: style(body).fontSize, color: style(body).color },
                centre: (box(root).left + box(root).right) / 2,
                overflows: root.scrollWidth > root.clientWidth,
                tokens,
            };
        }, EMPTY);
    }

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844, ...TOUCH }]) {
        test.describe(`at ${viewport.width}x${viewport.height}`, () => {
            test.use({ viewport: { width: viewport.width, height: viewport.height }, ...(viewport.isMobile ? TOUCH : {}) });

            test.beforeEach(async ({ page }) => {
                await protectMaintainerServer(page);
                await installFixtureChats(page);
                await page.goto('/', { waitUntil: 'domcontentloaded' });
                await expectHome(page);
                await page.waitForFunction(() => window.SillyTavern?.getContext?.().characters?.some(character => character?.avatar), undefined, { timeout: STARTUP_TIMEOUT });
            });

            // Wide Home puts Tewi beside the text, and narrow Home puts a banner above it.
            const beside = viewport.width >= 1024;

            test(`with no chats, Tewi is ${beside ? 'a panel beside' : 'a banner above'} the heading and the body, as one status page`, async ({ page }) => {
                await renderHome(page, []);
                await chooseMode(page, 'full');

                const state = await readEmptyState(page);

                expect(state.role).toBe('status');
                expect([state.titleTag, state.bodyTag]).toEqual(['H3', 'P']);
                expect(state.art).toMatchObject({ hidden: false, mode: beside ? 'panel' : 'banner', id: 'empty-tewi', ariaHidden: 'true', rendering: 'pixelated' });
                // 159 x 318 art pixels at one device pixel each. A banner shows the rows down to the hips, 62% of them.
                expect([state.art.width, Math.round(state.art.height)]).toEqual([159, beside ? 318 : Math.floor(318 * 0.62)]);
                expect(state.overflows).toBe(false);
                if (beside) {
                    expect(state.art.right, 'the art is before the text').toBeLessThanOrEqual(state.title.left);
                    expect(Math.abs(state.title.left - state.body.left), 'the heading and the body share a start edge').toBeLessThanOrEqual(1);
                    expect([state.title.align, state.body.align]).toEqual(['start', 'start']);
                    expect(state.title.bottom, 'the heading sits above the body').toBeLessThanOrEqual(state.body.top);
                    return;
                }
                expect(state.art.bottom, 'the art sits above the heading').toBeLessThanOrEqual(state.title.top);
                expect(state.title.bottom, 'the heading sits above the body').toBeLessThanOrEqual(state.body.top);
                for (const centre of [state.art.centre, state.title.centre, state.body.centre]) {
                    expect(Math.abs(centre - state.centre)).toBeLessThanOrEqual(1);
                }
                expect([state.title.align, state.body.align]).toEqual(['center', 'center']);
            });

            test('with no chats, the heading and the body use the type scale of the status pages', async ({ page }) => {
                await renderHome(page, []);
                await chooseMode(page, 'full');

                const { title, body, tokens } = await readEmptyState(page);

                expect(title.size).toBe(tokens.headline);
                expect(title.weight).toBe('800');
                expect(body.size).toBe(tokens.body);
                expect(body.color).toBe(tokens.muted);
            });

            test('with no chats, Compact keeps the heading and the body in the middle without the art', async ({ page }) => {
                await renderHome(page, []);
                await chooseMode(page, 'compact');

                const state = await readEmptyState(page);

                expect(state.art.hidden).toBe(true);
                expect(Math.abs(state.title.centre - state.centre)).toBeLessThanOrEqual(1);
                expect(Math.abs(state.body.centre - state.centre)).toBeLessThanOrEqual(1);
            });

            test('a filter with no match keeps the symbolic icon and no mascot, and the empty state is gone while chats exist', async ({ page }) => {
                const characters = await pickFixtureCharacters(page, 1);
                await renderHome(page, recentChatEntries(characters, 1, { distinctFiles: true }));
                await chooseMode(page, 'full');
                const filtered = page.locator('.welcomePanel [data-recent-chat-empty-state="filtered"]');

                await expect(page.locator(EMPTY)).toHaveCount(0);
                await page.locator('.welcomePanel [data-recent-chat-filter="group"]').click();

                await expect(filtered).toBeVisible();
                await expect(filtered.locator('.sb-status-page')).toHaveAttribute('role', 'status');
                await expect(filtered.locator('.sb-status-page__icon')).toBeVisible();
                await expect(filtered.locator('[data-sb-art-placeholder]')).toHaveCount(0);
                const [filteredSize, tokens] = await page.evaluate(() => {
                    const probe = document.createElement('div');
                    probe.style.cssText = 'position: absolute; visibility: hidden; font-size: var(--sb-type-headline);';
                    document.body.append(probe);
                    const size = getComputedStyle(probe).fontSize;
                    probe.remove();
                    return [getComputedStyle(document.querySelector('.welcomePanel [data-recent-chat-empty-state="filtered"] .sb-status-page__title')).fontSize, size];
                });
                expect(filteredSize, 'both states name themselves at one size').toBe(tokens);
            });
        });
    }
});

test.describe('Home Recent Chats group row', () => {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        test.describe(`at ${viewport.width}x${viewport.height}`, () => {
            test.use({ viewport });

            test('a group chat avatar is as large as an individual avatar and its text starts at the same inset', async ({ page }) => {
                await protectMaintainerServer(page);
                await installFixtureChats(page);
                await page.goto('/', { waitUntil: 'domcontentloaded' });
                await expectHome(page);
                await page.waitForFunction(() => window.SillyTavern?.getContext?.().characters?.some(character => character?.avatar), undefined, { timeout: STARTUP_TIMEOUT });
                const characters = await pickFixtureCharacters(page, 2);
                // The recent chat list only keeps rows whose group is known, so one stand-in group is added in the page.
                await page.evaluate(async (members) => {
                    const { groups } = await import('/scripts/group-chats.js');
                    groups.push({ id: 'qa-group-1', name: 'Study Circle', members, avatar_url: '', chat_id: 'qa-group-chat', chats: ['qa-group-chat'], generation_mode: 0, disabled_members: [] });
                }, characters.map(character => character.avatar));
                await renderHome(page, [
                    ...recentChatEntries(characters, 1, { distinctFiles: true }),
                    { file_name: 'qa-group-chat.jsonl', avatar: '', group: 'qa-group-1', last_mes: Date.now() - 60_000, mes: 'Group preview', chat_items: 5, file_size: '1kb' },
                ]);

                const rows = page.locator('#chat > .welcomePanel .recentChat');
                await expect(rows).toHaveCount(2);
                const measure = row => row.evaluate((node) => {
                    const avatar = node.querySelector('.avatar').getBoundingClientRect();
                    const info = node.querySelector('.recentChatInfo').getBoundingClientRect();
                    return { width: avatar.width, height: avatar.height, textInset: info.left - node.getBoundingClientRect().left };
                });
                const individual = await measure(rows.filter({ hasNot: page.locator('.avatar_collage') }));
                const group = await measure(rows.filter({ has: page.locator('.avatar_collage') }));

                expect(group.width).toBe(individual.width);
                expect(group.height).toBe(individual.height);
                expect(group.textInset).toBe(individual.textInset);
            });
        });
    }
});

test.describe('Home while its template loads', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('a chat that opens during the first template request is not covered by the Home panel', async ({ page }) => {
        await protectMaintainerServer(page);
        await installFixtureChats(page);
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
        await page.waitForFunction(() => window.SillyTavern?.getContext?.().characters?.some(character => character?.avatar), undefined, { timeout: STARTUP_TIMEOUT });
        await expect.poll(() => templateRequested, { message: 'the Home template request is held while the chat opens', timeout: STARTUP_TIMEOUT }).toBe(true);
        await page.evaluate(async () => {
            const { characters, selectCharacterById } = await import('/script.js');
            await selectCharacterById(characters.findIndex(character => character?.avatar));
        });
        await dismissOpenDialogIfPresent(page);
        await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId() !== undefined)).toBe(true);

        releaseTemplate();
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));

        await expect(page.locator('#chat > .welcomePanel')).toHaveCount(0);
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', /.*/);
    });
});
