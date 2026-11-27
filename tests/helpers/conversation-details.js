/**
 * Steps for the specs of the conversation details window: boot the app with its own persona and library, make
 * conversations through the server's routes, open the window through its entry point, and read the stored state back.
 * Nothing here clicks a surface that the specs test; they do that themselves.
 */

import { deflateSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { waitForAppReady } from './app-ready.js';
import { resetConversations, seedConversation, uniquePersona } from './conversation-seed.js';
import { protectMaintainerServer } from './maintainer-server.js';

const ROUTES = '/api/sillybunny-conversation';

/** The host of the window, the page that shows, and the surface of the window. */
export const DETAILS_HOST = 'dialog.sb-dialog-host[open]:has(.sb-details-window)';
export const DETAILS_SURFACE = '.sb-details-window';
const SHOWN_PAGE = '.sb-dialog__page:not([hidden]):not(.is-underlay):not(.is-leaving)';

/**
 * The page of the window that is on top.
 * @param {import('@playwright/test').Page} page
 */
export const shownPage = page => page.locator(DETAILS_HOST).locator(SHOWN_PAGE).last();

/**
 * Boots the app as a persona of its own and returns the avatar files of the library, so that every spec has conversations
 * that no other spec on the same server touches.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ avatars: string[], names: Record<string, string> }>} Avatar files in the order of the library, and the name on each card.
 */
export async function openDetailsApp(page) {
    await protectMaintainerServer(page);
    const persona = uniquePersona();
    await page.route('**/api/settings/get', async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        const settings = JSON.parse(data.settings);
        settings.user_avatar = persona;
        await route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 60_000 });
    await waitForAppReady(page);
    const cards = await page.evaluate(async () => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const context = window.SillyTavern.getContext();
        if (!context.characters.length) {
            await context.getCharacters();
        }
        return context.characters.filter(character => character.avatar).map(character => [character.avatar, character.name]);
    });
    expect(cards.length, 'the library has three characters for a group').toBeGreaterThanOrEqual(3);
    await resetConversations(page);
    return { avatars: cards.map(([avatar]) => avatar), names: Object.fromEntries(cards) };
}

/**
 * Makes a conversation and opens it in the workspace, with the auto worker stopped so that nothing answers on its own.
 * @param {import('@playwright/test').Page} page
 * @param {import('./conversation-seed.js').SeedOptions} options
 * @returns {Promise<{ conversationId: string, chatIds: string[] }>}
 */
export async function seedAndOpen(page, options) {
    const seeded = await seedConversation(page, options);
    await page.evaluate(async ({ avatar, groupId }) => {
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        await openConversationWorkspaceForAvatar(avatar, { showToast: false, groupId });
        stopConversationAutoWorker();
    }, { avatar: options.avatar, groupId: options.members?.length ? seeded.conversationId : null });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    return seeded;
}

/**
 * Opens the details window through `chrome.js`, the way the header and the list will, and waits for its first page.
 * @param {import('@playwright/test').Page} page
 * @param {string} conversationId
 * @param {{ page?: string, avatar?: string }} [options]
 */
export async function openDetails(page, conversationId, options = {}) {
    const opened = await page.evaluate(async ({ conversationId, options }) => {
        const { openConversationDetails } = await import('/scripts/sillybunny-conversation/chrome.js');
        return openConversationDetails(conversationId, options);
    }, { conversationId, options });
    expect(opened, 'the details window opens').toBe(true);
    await expect(shownPage(page).locator('.sb-details-page')).toBeVisible();
}

export async function openPreferences(page) {
    const opened = await page.evaluate(async () => {
        const { openConversationPreferences } = await import('/scripts/sillybunny-conversation/chrome.js');
        return openConversationPreferences();
    });
    expect(opened, 'Preferences opens').toBe(true);
    await expect(shownPage(page).locator('.sb-details-page')).toBeVisible();
}

/**
 * One server call of the conversation routes, from the page, so that it carries the page's headers.
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {object} body
 */
export async function callRoute(page, path, body = {}) {
    return page.evaluate(async ({ prefix, path, body }) => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch(`${prefix}${path}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
        return { status: response.status, json: await response.json().catch(() => null) };
    }, { prefix: ROUTES, path, body });
}

/** The conversation as the server stores it, or null when it is gone. */
export async function readStored(page, conversationId) {
    const answer = await callRoute(page, '/get', { id: conversationId });
    return answer.status === 200 ? answer.json.conversation : null;
}

/** The state of one character as the server stores it: its routine and its status override. */
export async function readCharacterState(page, avatar) {
    const answer = await callRoute(page, '/characters/get');
    return answer.json?.characters?.[avatar] ?? {};
}

/** The memory summary in the header of a chat as the server stores it, or an empty text. */
export async function readChatMemory(page, conversationId, chatId) {
    const answer = await callRoute(page, '/chat/get', { id: conversationId, chatId });
    return answer.json.chat[0].chat_metadata?.sb_conversation?.memory_summary ?? '';
}

/**
 * A conversation as a route answers it, with the extras of a direct conversation. The routes cannot make extras (only the
 * migration does), so a spec that lists them has the answers of its page changed.
 */
export function withExtras(conversation, conversationId, extras) {
    return conversation.id === conversationId ? { ...conversation, extras } : conversation;
}

/** The conversation that the workspace shows, as the data module names it. */
export async function readOpenConversation(page) {
    return page.evaluate(async () => {
        const { conversationState } = await import('/scripts/sillybunny-conversation/state.js');
        const { getConversationRecord } = await import('/scripts/sillybunny-conversation/context.js');
        const avatar = conversationState.conversationSelectedAvatar;
        const view = avatar ? getConversationRecord(avatar, { groupId: conversationState.conversationSelectedGroupId || '' }) : null;
        return view ? { id: view.id, kind: view.kind, characters: view.characters } : null;
    });
}

/** Writes a PNG of a single colour, for the picture of a group. */
export function solidPng(color = [200, 40, 120]) {
    // A 2x2 PNG built from its chunks, so that no image library is needed.
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        return c >>> 0;
    });
    const crc = (buffer) => {
        let c = 0xffffffff;
        for (const byte of buffer) {
            c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        }
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const check = Buffer.alloc(4);
        check.writeUInt32BE(crc(body));
        return Buffer.concat([length, body, check]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(2, 4);
    header[8] = 8;
    header[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.from([...color, ...color])]);
    const raw = Buffer.concat([row, row]);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
