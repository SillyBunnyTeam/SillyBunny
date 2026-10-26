import { mkdirSync } from 'node:fs';
import { expect } from '@playwright/test';
import { bootMiscDialogs } from './misc-dialogs.js';

export const ARCHIVE_CURSOR = 'a'.repeat(64);
export const ORPHAN_CURSOR = 'b'.repeat(64);
export const FIRST_READ_TOKEN = 'c'.repeat(64);
export const SECOND_READ_TOKEN = 'd'.repeat(64);
export const FIRST_ORPHAN_HASH = 'e'.repeat(64);
export const SECOND_ORPHAN_HASH = 'f'.repeat(64);
export const SEARCH_CONTENT_DEBOUNCE_MS = 600;
/** The character the real host has open; its chats can be opened from the archive. */
export const HOST_AVATAR = 'misc-dialog-character.png';

export const LAYOUT_VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
];

const SHOT_DIRECTORY = process.env.SILLYBUNNY_ARCHIVE_SHOTS;
if (SHOT_DIRECTORY) mkdirSync(SHOT_DIRECTORY, { recursive: true });

export function archivePage(rows, cursor = null, readToken = null, total = rows.length) {
    return { rows, cursor, read_token: readToken, errors: 0, total };
}

export function linkedRow(name, { avatar = 'Alice.png', mtime = 1_000, size = '1 KB', count = 1, preview } = {}) {
    return {
        _source: 'archive-inventory',
        avatar,
        file_name: `${name}.jsonl`,
        file_size: size,
        chat_items: count,
        last_mes: mtime,
        mes: preview ?? `${name} preview`,
    };
}

export function groupRow(name, groupId = 'g1', { mtime = 1_000 } = {}) {
    return {
        _source: 'archive-inventory',
        group: groupId,
        file_name: `${name}.jsonl`,
        file_size: '1 KB',
        chat_items: 1,
        last_mes: mtime,
        mes: `${name} preview`,
    };
}

export function orphanRow(name, hash, { reason = 'missing-character' } = {}) {
    return {
        _source: 'archive-orphan',
        archive_hash: hash,
        chatFolder: 'Deleted',
        file_name: `${name}.jsonl`,
        file_size: '1 KB',
        chat_items: 1,
        last_mes: 1_000,
        mes: `${name} preview`,
        orphan_type: reason,
    };
}

export function emptyOrganization(patch = {}) {
    return { version: 1, lastView: {}, views: [], folders: [], collections: [], chats: {}, ...patch };
}

export const chatKey = (owner, file) => JSON.stringify(['character', owner, file]);

export function chatBody(messages = [{ name: 'Alice', mes: 'A line of dialogue.' }]) {
    return [
        JSON.stringify({ chat_metadata: {}, user_name: 'You', character_name: 'Alice' }),
        ...messages.map(message => JSON.stringify({ is_user: false, send_date: 'October 1, 2026 1:00pm', ...message })),
    ].join('\n');
}

/**
 * Over a hundred chats across characters, groups and orphans, including one chat whose JSONL cannot be parsed
 * and one with 250 messages, so paging, selection and layout all have enough to work with.
 */
export function bigFixture() {
    const names = ['Alice', 'Bob', 'Cora', 'Dana', 'Eli', 'Fay', 'Gus', 'Hana', 'Iris', 'Jude'];
    const snippets = [
        'The lantern flickered as she leaned across the table and whispered about the summit road, which had been closed since the first snow.',
        'Short note.',
        'He had not expected the letter to arrive so soon, nor to be written in a hand he recognised from his childhood.',
    ];
    const rows = [];
    const chats = {};
    names.forEach((name, owner) => {
        for (let index = 0; index < 12; index++) {
            const file = `${name} - ${index % 3 === 0 ? `The summit road ${index}` : `Chapter ${index}`}`;
            rows.push(linkedRow(file, {
                avatar: `${name}.png`,
                mtime: 1_760_000_000_000 - (owner * 12 + index) * 86_400_000,
                size: `${10 + index * 7} KB`,
                count: 3 + index * 11,
                preview: snippets[(owner + index) % snippets.length],
            }));
            if (index % 5 === 0) chats[chatKey(name, file)] = { favorite: true };
            else if (index % 4 === 0) chats[chatKey(name, file)] = { folder: 'f-rp', tags: ['slow'] };
            else if (index % 7 === 0) chats[chatKey(name, file)] = { collections: ['c-burn'] };
        }
    });
    rows.push(linkedRow('Alice - Long saga', { mtime: 1_770_000_000_000, size: '300 KB', count: 250, preview: 'A very long chat.' }));
    rows.push(linkedRow('Alice - Malformed notes', { mtime: 1_769_900_000_000, size: '300 KB', count: 250, preview: 'A very long chat.' }));
    const groups = [{ id: 'g1', name: 'Tavern Regulars' }, { id: 'g2', name: 'Night Watch' }];
    groups.forEach((group, owner) => {
        for (let index = 0; index < 10; index++) {
            const file = `${group.name} - Evening ${index}`;
            rows.push(groupRow(file, group.id, { mtime: 1_759_000_000_000 - (owner * 10 + index) * 86_400_000 }));
            if (index % 4 === 0) chats[JSON.stringify(['group', file])] = { folder: 'f-arch' };
        }
    });
    const orphans = Array.from({ length: 12 }, (_, index) => orphanRow(`Lost chat ${index}`, String(index).padStart(64, 'e'), {
        reason: index % 2 ? 'missing-character' : 'unlinked-group',
    }));
    const organization = emptyOrganization({
        views: [{ id: 'v-fav', name: 'Favourites by size', view: { favorite: true, sort: 'size' } }],
        folders: [{ id: 'f-rp', name: 'Roleplay' }, { id: 'f-arch', name: 'Archive' }],
        collections: [{ id: 'c-burn', name: 'Slow burn' }, { id: 'c-one', name: 'One-shots' }],
        chats,
    });
    return {
        rows,
        orphans,
        organization,
        characters: names.map(name => ({ name, avatar: `${name}.png` })),
        groups: groups.map(group => ({ ...group, avatar_url: '' })),
    };
}

export function longChat() {
    const lines = [JSON.stringify({ chat_metadata: { note: 'kept' }, user_name: 'You', character_name: 'Alice' })];
    for (let index = 0; index < 250; index++) {
        const user = index % 2 === 1;
        lines.push(JSON.stringify({
            name: user ? 'You' : 'Alice',
            is_user: user,
            send_date: `October ${1 + (index % 27)}, 2026 1:${String(index % 60).padStart(2, '0')}pm`,
            mes: `Message ${index + 1}. The lantern flickered as she leaned across the table.`,
            swipes: index === 3 ? ['alt one', 'alt two'] : undefined,
            extra: index === 4 ? { api: 'x', model: 'y' } : undefined,
        }));
    }
    return lines.join('\n');
}

export function fulfillJson(route, value) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
}

function requestBody(request) {
    try {
        return request.postDataJSON() ?? {};
    } catch {
        return {};
    }
}

/**
 * Boots the real app with every archive endpoint answered from memory. Organisation writes, token releases,
 * searches and chat reads are recorded; nothing reaches the server behind the test.
 * Later `page.route` calls in a test override these defaults.
 */
export async function bootArchive(page, viewport, options = {}) {
    const fixture = options.fixture ?? { rows: [], orphans: [], organization: null, characters: [], groups: [] };
    const recorded = {
        uploads: [],
        releases: [],
        searches: [],
        views: [],
        exports: [],
        inventory: [],
        dataMaid: [],
    };
    let organization = options.organization !== undefined ? options.organization : fixture.organization;
    page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/data-maid')) recorded.dataMaid.push(request.url());
    });
    await page.route('**/thumbnail*', route => route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#6b7fd6"/></svg>',
    }));
    await page.route('**/user/files/_sbca_organization.json', route => {
        const current = recorded.uploads.at(-1) ?? organization;
        return current ? fulfillJson(route, current) : route.fulfill({ status: 404 });
    });
    await page.route('**/api/files/upload', route => {
        const body = requestBody(route.request());
        recorded.uploads.push(JSON.parse(Buffer.from(body.data, 'base64').toString('utf8')));
        return fulfillJson(route, { path: body.name });
    });
    await page.route('**/api/files/delete', route => route.fulfill({ status: 204 }));
    await page.route('**/api/chats/archive/release', route => {
        recorded.releases.push(requestBody(route.request()));
        return route.fulfill({ status: 204 });
    });
    await page.route('**/api/chats/archive/view?**', route => {
        recorded.views.push(route.request().url());
        return route.fulfill({
            status: 200,
            contentType: 'application/x-ndjson',
            body: chatBody([{ name: 'Lost', mes: 'Nobody is left to remember this.' }]),
        });
    });
    await page.route('**/api/chats/export', route => {
        const body = requestBody(route.request());
        recorded.exports.push(body);
        const text = options.chatBody?.(String(body.file ?? '')) ?? chatBody();
        return fulfillJson(route, { result: text });
    });
    await page.route('**/api/chats/search', async route => {
        const body = requestBody(route.request());
        recorded.searches.push(body);
        return fulfillJson(route, (await options.search?.(body)) ?? []);
    });
    await page.route('**/api/chats/archive/inventory', route => {
        const body = requestBody(route.request());
        recorded.inventory.push(body);
        const rows = body.scope === 'archive' ? fixture.rows : fixture.orphans;
        return fulfillJson(route, archivePage(rows, null, body.scope === 'archive' ? null : SECOND_READ_TOKEN));
    });

    await bootMiscDialogs(page, viewport);

    await page.evaluate(async ({ characters, groups }) => {
        const host = await import('/script.js');
        const groupChats = await import('/scripts/group-chats.js');
        host.characters.push(...characters);
        groupChats.groups.splice(0, groupChats.groups.length, ...groups);
    }, { characters: fixture.characters ?? [], groups: fixture.groups ?? [] });

    return {
        ...recorded,
        setOrganization(next) {
            organization = next;
            recorded.uploads.length = 0;
        },
    };
}

export const drawerButton = page => page.locator('#sbca_drawer_button');
export const dialog = page => page.locator('.sbca-dialog');
export const rows = page => page.locator('.sbca-row');
export const filenames = page => page.locator('.sbca-filename');
export const search = page => page.getByRole('combobox', { name: 'Search Indexed Chats' });

/** The header search starts collapsed behind its toggle; open it the way a user does. */
export async function openSearch(page) {
    const field = search(page);
    if (!(await field.isVisible())) {
        await page.locator('.sbca-dialog .sb-dialog__header:visible .sb-dialog__search-toggle').first().click();
    }
    await expect(field).toBeVisible();
    return field;
}

export async function openFilters(page) {
    await page.locator('.sbca-dialog .sbca-filters-button:visible').first().click();
    await expect(page.locator('.sbca-filters')).toBeVisible();
}

export const filterCheck = (page, name) => page.locator('.sbca-filters').getByRole('checkbox', { name, exact: true });

export async function showCharacterList(page) {
    await page.evaluate(async () => { await window.SillyBunnyShell.openTab('characters', 'characters'); });
    await expect(drawerButton(page)).toBeVisible();
}

/** Opens the archive the way a user does: through the drawer button in the Characters list header. */
export async function openArchive(page, { waitForList = true } = {}) {
    await showCharacterList(page);
    await drawerButton(page).click();
    await dialog(page).waitFor();
    await page.waitForFunction(() => !document.querySelector('.sbca-dialog[opening]'));
    if (waitForList) {
        await expect(page.locator('.sbca-location').or(rows(page)).first()).toBeVisible();
    }
}

/** True when the archive stacks its panes into pages, as it does on a phone or in a narrow frame. */
export const isCollapsed = async page => (await page.locator('.sbca-shell').getAttribute('data-collapsed')) === 'true';

/** Shows the chat list: beside the sidebar on a wide frame, and on its own pushed page when collapsed. */
export async function showList(page, location = null) {
    const collapsed = await isCollapsed(page);
    if (location) {
        await page.locator('.sbca-location', { hasText: location }).first().click();
    } else if (collapsed || (await rows(page).count()) === 0) {
        await page.locator('.sbca-location').first().click();
    }
    await expect(rows(page).first()).toBeVisible();
}

const MENU_BUTTON = '.sbca-dialog .sb-dialog__header:visible .sb-dialog__menu';

export async function openMenu(page) {
    await page.locator(MENU_BUTTON).last().click();
    await expect(page.getByRole('menu')).toBeVisible();
}

export async function openMenuItem(page, name) {
    await openMenu(page);
    await page.getByRole('menuitem', { name, exact: false }).first().click();
}

/** The chat count the way a user reads it: the window title while selecting, otherwise the subtitle. */
export const selectionTitle = page => page.locator('.sbca-dialog .sb-dialog__header.is-selection-mode .sb-dialog__title');

/** Scrolls `locator` into view, then checks it is shown inside both the viewport and the archive frame. */
export async function expectReachable(page, locator, label) {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator, `${label}: in the viewport`).toBeInViewport();
    const inside = await locator.evaluate(node => {
        const frame = document.querySelector('.sbca-dialog').getBoundingClientRect();
        const box = node.getBoundingClientRect();
        return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1 && box.left >= frame.left - 1 && box.right <= frame.right + 1;
    });
    expect(inside, `${label}: inside the frame`).toBe(true);
}

/** The scopes a content search asked the server about, in request order. */
export function searchedScopes(archive, query) {
    return archive.searches.filter(body => body.query === query).map(body => body.avatar_url ?? `group:${body.group_id}`);
}

export async function openRow(page, text) {
    await rows(page).filter({ hasText: text }).first().click();
    await expect(page.locator('.sbca-viewer-content')).toBeVisible();
}

export async function waitForDetail(page) {
    await expect(page.locator('.sbca-viewer-content')).toBeVisible();
    await expect(page.locator('.sbca-viewer-content[aria-busy="true"]')).toHaveCount(0, { timeout: 10000 });
}

export async function goBack(page) {
    await page.locator('.sbca-dialog .sb-dialog__back').last().click();
}

export async function shot(page, name) {
    if (!SHOT_DIRECTORY) return;
    const { width, height } = page.viewportSize();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT_DIRECTORY}/${width}x${height}-${name}.png` });
}

/**
 * Header, selection bar and body of the frame on top: no pair of controls overlaps, and no label is cut off
 * unless its element ellipsizes by design.
 */
export async function expectCleanLayout(page, label, scopeSelector = '.sbca-dialog') {
    const report = await page.evaluate(scopeSelector => {
        const surface = document.querySelector('.sbca-dialog');
        const scope = document.querySelector(scopeSelector) ?? surface;
        const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
        const pages = [...surface.querySelectorAll('.sb-dialog__page')].filter(visible);
        const header = pages.at(-1)?.querySelector(':scope > .sb-dialog__header') ?? surface.querySelector('.sb-dialog__header');
        const bar = surface.querySelector('.sb-selection-action-bar:not([hidden])');
        const overlaps = [];
        for (const group of [header, bar].filter(Boolean)) {
            const nodes = [...group.querySelectorAll('button, .sb-dialog__title, .sb-dialog__subtitle, .sb-dialog__search-entry')]
                .filter(visible)
                .map(node => ({
                    node,
                    rect: node.getBoundingClientRect(),
                    name: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 24) || node.className,
                }));
            for (let a = 0; a < nodes.length; a++) {
                for (let b = a + 1; b < nodes.length; b++) {
                    const x = Math.min(nodes[a].rect.right, nodes[b].rect.right) - Math.max(nodes[a].rect.left, nodes[b].rect.left);
                    const y = Math.min(nodes[a].rect.bottom, nodes[b].rect.bottom) - Math.max(nodes[a].rect.top, nodes[b].rect.top);
                    if (x > 1 && y > 1 && !nodes[a].node.contains(nodes[b].node) && !nodes[b].node.contains(nodes[a].node)) {
                        overlaps.push(`${nodes[a].name} x ${nodes[b].name}`);
                    }
                }
            }
        }
        if (header && bar) {
            const top = header.getBoundingClientRect();
            const bottom = bar.getBoundingClientRect();
            if (Math.min(top.bottom, bottom.bottom) - Math.max(top.top, bottom.top) > 1) overlaps.push('header x selection bar');
        }
        const clipped = [];
        for (const node of scope.querySelectorAll('*')) {
            if (!visible(node) || node.scrollWidth <= node.clientWidth + 1) continue;
            const style = getComputedStyle(node);
            if (style.overflowX === 'visible' || style.textOverflow === 'ellipsis' || style.clipPath !== 'none') continue;
            if (node.closest('.sb-dialog__page:not(:last-child)') || node.matches('pre, .sbca-list-scroll, .sb-list-editor__sidebar') || node.closest('.sb-picker')) continue;
            clipped.push(`${node.tagName}.${String(node.className).slice(0, 50)} ${node.scrollWidth}>${node.clientWidth} ${style.overflowX}`);
        }
        const frame = surface.getBoundingClientRect();
        return {
            overlaps,
            clipped: clipped.slice(0, 8),
            insideViewport: frame.left >= -0.5 && frame.right <= innerWidth + 0.5 && frame.top >= -0.5 && frame.bottom <= innerHeight + 0.5,
        };
    }, scopeSelector);
    expect(report.overlaps, `${label}: overlapping controls`).toEqual([]);
    expect(report.clipped, `${label}: clipped labels`).toEqual([]);
    expect(report.insideViewport, `${label}: frame inside the viewport`).toBe(true);
}
