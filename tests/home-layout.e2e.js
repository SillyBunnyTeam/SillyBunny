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

const menuButton = page => page.locator('#chat > .welcomePanel .sbHomeMenuButton');

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

        test('Tab visits the regions in the order a reader sees them', async ({ page }) => {
            await chooseMode(page, 'full');
            const probed = await page.evaluate((ids) => {
                for (const id of ids) {
                    const probe = document.createElement('button');
                    probe.type = 'button';
                    probe.dataset.qaProbe = id;
                    probe.style.cssText = 'display: block; height: 24px;';
                    probe.textContent = id;
                    document.querySelector(`.welcomePanel [data-sb-home-region="${id}"]`).prepend(probe);
                }
                return ids.map((id) => {
                    const rect = document.querySelector(`[data-qa-probe="${id}"]`).getBoundingClientRect();
                    return { id, left: Math.round(rect.left), top: Math.round(rect.top) };
                });
            }, REGION_DOM_ORDER);
            const readingOrder = [...probed]
                .sort((first, second) => (first.left === second.left ? first.top - second.top : first.left - second.left))
                .map(probe => probe.id);

            await menuButton(page).focus();
            const stops = [];
            for (let press = 0; press < 40; press++) {
                await page.keyboard.press('Tab');
                stops.push(await page.evaluate(() => document.activeElement?.dataset?.qaProbe ?? null));
            }
            const visited = [...new Set(stops.filter(Boolean))];

            expect(readingOrder, 'reading order, left column then right column').toEqual(REGION_DOM_ORDER);
            expect(visited).toEqual(REGION_DOM_ORDER);
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
            ]));
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
