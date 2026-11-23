import { expect } from '@playwright/test';
import { fetchBodyOrSkip } from './route-fetch.js';
import { applyWelcomeSettings } from './welcome-dialog.js';
import { waitForAppReady } from './app-ready.js';

// What the specs of the settings content width read from the pages: where a column sits in its pane, and how wide it is.
// A page is booted with its writes blocked, so nothing reaches the server.

const READ_ONLY_POSTS = new Set([
    '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
    '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
]);

export const INSET = 12;

/** Boots the app at a window size, with the account's text size and Page Width the test names. Writes never reach the server. */
export async function boot(page, { width, height, fontScale = 1, chatWidth = 55 } = {}) {
    await page.setViewportSize({ width, height });
    await page.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/settings/get') {
            const fetched = await fetchBodyOrSkip(route, response => response.json());
            if (!fetched) return;
            const { response, body: data } = fetched;
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            applyWelcomeSettings(settings);
            settings.power_user.font_scale = fontScale;
            settings.power_user.chat_width = chatWidth;
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ response, json: data });
        }
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
        if (request.method() === 'POST' && READ_ONLY_POSTS.has(url.pathname)) return route.continue();
        return route.fulfill({ json: { result: 'ok' } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeout: 60000 });
}

export const sidebarWidth = (viewport, scale) => Math.min(Math.max(viewport * 0.25, 180 * scale), 280 * scale);

/** libadwaita 1.10 `child_size_from_clamp`: the width an AdwClamp gives the room it is offered, floored on the curve and ceiled on the maximum. */
export function adwClamp(available, max, threshold) {
    const lower = Math.min(threshold, max);
    const upper = lower + 3 * (max - lower);
    if (available <= lower) return available;
    if (available >= upper) return Math.ceil(max);
    const progress = (available - lower) / (upper - lower);
    return Math.floor(lower + (1 - (1 - progress) ** 3) * (max - lower));
}

/** The room of a page is its pane less both insets, which are 12px on every page at every desktop width. */
export const preferenceContent = (viewport, scale = 1) => adwClamp(viewport - sidebarWidth(viewport, scale) - 2 * INSET, 1000 * scale, (1000 * scale * 2) / 3);
export const wideContent = (viewport, scale = 1) => adwClamp(viewport - sidebarWidth(viewport, scale) - 2 * INSET, 1440 * scale, (1440 * scale * 2) / 3);

export async function openHosted(page, shell, tab) {
    await page.evaluate(({ shell, tab }) => window.SillyBunnyShell.openTab(shell, tab), { shell, tab });
    await page.locator(`button[data-sb-settings-tab="${tab}"]`).evaluate(element => element.click());
    const panel = page.locator(`[data-sb-panel="${tab}"]`);
    await expect(panel).toHaveAttribute('aria-hidden', 'false');
    return panel;
}

export async function openCharactersTab(page, tab) {
    await page.evaluate(tab => window.SillyBunnyShell.openTab('characters', tab), tab);
    await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', tab === 'editor' ? /^(editor_empty|character_edit|create)$/ : tab);
}

export async function openCharacterEditor(page) {
    await page.evaluate(async () => {
        const { characters, selectCharacterById } = await import('/script.js');
        await selectCharacterById(characters.findIndex(character => character?.avatar), { switchMenu: true });
    });
    await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'character_edit');
    await expect(page.locator('#form_create #sb_character_editor_header')).toBeVisible();
}

/** The widest preference group of a page and where it sits in its scroller, which is the element that holds the page's padding. */
export function readPage(page, { panel, scroller }) {
    return page.evaluate(({ panel, scroller }) => {
        const host = document.getElementById('sb-settings-shell-host').getBoundingClientRect();
        const shown = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
        const scrollerNode = document.querySelector(scroller);
        const groups = [...document.querySelector(panel).querySelectorAll('.ds-pref-group')].filter(shown);
        if (!scrollerNode || groups.length === 0) return { error: `${panel} has ${groups.length} groups and ${scrollerNode ? 'a' : 'no'} scroller` };
        const widest = groups.reduce((a, b) => (b.getBoundingClientRect().width > a.getBoundingClientRect().width ? b : a)).getBoundingClientRect();
        const box = scrollerNode.getBoundingClientRect();
        const clientLeft = box.left + scrollerNode.clientLeft;
        return {
            pane: { left: host.left, right: host.right },
            scroller: { left: box.left, right: box.right },
            width: widest.width,
            // How far the centre of the column is from the centre of the pane, and how wide the scrollbar of the scroller is.
            centre: (widest.left + widest.right) / 2 - (host.left + host.right) / 2,
            scrollbar: scrollerNode.offsetWidth - scrollerNode.clientWidth,
            // Where the page starts its content: its scroller's top edge and the top padding that the page gives it.
            top: box.top + scrollerNode.clientTop + parseFloat(getComputedStyle(scrollerNode).paddingTop),
            before: widest.left - clientLeft,
            after: clientLeft + scrollerNode.clientWidth - widest.right,
        };
    }, { panel, scroller });
}

/** A framed page: the visible frame of a list or an editor, and where it sits in the box that pads it. */
export function readFrame(page, { frame, container }) {
    return page.evaluate(({ frame, container }) => {
        const frameNode = document.querySelector(frame);
        const containerNode = document.querySelector(container);
        if (!frameNode || !containerNode) return { error: `${frame} ${frameNode ? 'found' : 'missing'}, ${container} ${containerNode ? 'found' : 'missing'}` };
        const box = frameNode.getBoundingClientRect();
        const outer = containerNode.getBoundingClientRect();
        const clientLeft = outer.left + containerNode.clientLeft;
        const host = document.getElementById('sb-settings-shell-host').getBoundingClientRect();
        return {
            width: box.width,
            centre: (box.left + box.right) / 2 - (host.left + host.right) / 2,
            top: box.top,
            before: box.left - clientLeft,
            after: clientLeft + containerNode.clientWidth - box.right,
            container: containerNode.clientWidth,
        };
    }, { frame, container });
}

export const PREFERENCE_PAGES = [
    { id: 'interface', shell: 'right' },
    { id: 'connections', shell: 'left' },
    { id: 'prompting', shell: 'left' },
    { id: 'sampling', shell: 'left' },
    { id: 'context', shell: 'left' },
    { id: 'appearance', shell: 'right' },
    { id: 'messages', shell: 'right' },
    { id: 'data-security', shell: 'right' },
    { id: 'logs', shell: 'right' },
];

export async function readPreferencePage(page, { id, shell }) {
    await openHosted(page, shell, id);
    const selector = `[data-sb-panel="${id}"]`;
    let read;
    await expect.poll(async () => { read = await readPage(page, { panel: selector, scroller: `${selector} > .sb-shell-panel-scroller` }); return read.error ?? ''; }, { timeout: 15_000 }).toBe('');
    return read;
}

export async function readWidePages(page) {
    const reads = {};
    await openHosted(page, 'left', 'editor');
    await expect(page.locator('[data-sb-panel="editor"] .sb-prompt-editor')).toBeVisible();
    reads.promptEditor = await readFrame(page, { frame: '[data-sb-panel="editor"] .sb-prompt-editor', container: '[data-sb-panel="editor"] > .sb-shell-panel-scroller' });
    await openHosted(page, 'left', 'agents');
    await expect(page.locator('[data-sb-panel="agents"] .ica-agents-editor')).toBeVisible();
    reads.agents = await readFrame(page, { frame: '[data-sb-panel="agents"] .ica-agents-editor', container: '[data-sb-panel="agents"] > .sb-shell-panel-scroller' });
    const characters = [
        ['characters', '.sb-character-list'], ['groups', '.sb-character-list'], ['world-info', '.sb-wi-editor'], ['persona', '.sb-persona-editor'],
    ];
    for (const [tab, frame] of characters) {
        await openCharactersTab(page, tab);
        await expect(page.locator(`#right-nav-panel ${frame}`).first()).toBeVisible();
        reads[tab] = await readFrame(page, { frame: `#right-nav-panel ${frame}`, container: '#right-nav-panel > .scrollableInner' });
    }
    await page.evaluate(() => document.body.classList.add('charListGrid'));
    await openCharactersTab(page, 'characters');
    await expect(page.locator('#rm_print_characters_block')).toHaveCSS('display', 'grid');
    reads.charactersGrid = await readFrame(page, { frame: '#right-nav-panel .sb-character-list', container: '#right-nav-panel > .scrollableInner' });
    await page.evaluate(() => document.body.classList.remove('charListGrid'));
    await openCharacterEditor(page);
    reads.characterEditor = await readFrame(page, { frame: '#form_create', container: '#right-nav-panel > .scrollableInner' });
    return reads;
}
