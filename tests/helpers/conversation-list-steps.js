import { expect } from '@playwright/test';
import { seedConversation, uniquePersona } from './conversation-seed.js';
import { fetchJsonOrSkip } from './route-fetch.js';
import { applyWelcomeSettings } from './welcome-dialog.js';
import { waitForAppReady } from './app-ready.js';

/** Steps for the specs of the conversation list: a page that has conversations of its own, and ways to read and drive the rows. */

export const LIST = '#sb_conversation_list_items';
export const ROW = '.sb-conversation-list-row';
export const ITEM = '.sb-conversation-list-item';
export const SECTION = '.sb-conversation-list-section';
export const NEW_MENU = '[data-sb-conversation-action="open-new-menu"]';
export const MAIN_MENU = '[data-sb-conversation-action="open-main-menu"]';
const BASE_TIME = Date.UTC(2026, 8, 30, 12, 0, 0);
const minutes = count => BASE_TIME + count * 60_000;

/**
 * Loads the app with a persona of its own, so that the page lists only the conversations that the spec makes on a server
 * that other specs share.
 * @param {import('@playwright/test').Page} page
 * @param {string} baseURL
 */
export async function bootConversationPage(page, baseURL, { theme = '' } = {}) {
    const origin = new URL(baseURL).origin;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(baseURL).hostname);
    let settingsVersion = Date.now();
    const persona = uniquePersona();
    const readOnlyEndpoints = new Set([
        '/api/characters/all', '/api/characters/chats', '/api/groups/all', '/api/backgrounds/all',
        '/api/avatars/get', '/api/stats/get', '/api/secrets/read', '/api/users/me',
    ]);

    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
            return route.abort();
        }
        if (url.pathname === '/api/extensions/discover') {
            const extensions = await fetchJsonOrSkip(route);
            if (!extensions) return;
            return route.fulfill({ json: extensions.filter(extension => !extension.name.startsWith('third-party/')) });
        }
        if (url.pathname === '/api/settings/get') {
            const data = await fetchJsonOrSkip(route);
            if (!data) return;
            const settings = JSON.parse(data.settings);
            settings.firstRun = false;
            applyWelcomeSettings(settings);
            settings.user_avatar = persona;
            settings.power_user.auto_connect = false;
            if (theme) {
                settings.power_user.theme = theme;
            }
            data.request_compression = { ...data.request_compression, enabled: false };
            data.settings = JSON.stringify(settings);
            return route.fulfill({ json: data });
        }
        if (url.pathname === '/api/settings/save') {
            return route.fulfill({ json: { version: ++settingsVersion } });
        }
        if (readOnlyEndpoints.has(url.pathname) || url.pathname.startsWith('/api/tokenizers/') || url.pathname.startsWith('/api/sillybunny-conversation/')) {
            return route.continue();
        }
        if (url.pathname.startsWith('/api/backends/')) {
            return route.fulfill({ json: { data: [] } });
        }
        if (url.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.request().method())) {
            return route.fulfill({ json: {} });
        }
        return route.continue();
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeout: 60000 });
    return persona;
}

/** The avatar file of each bundled character that the specs use, by the name on its card. */
export async function getCharacterAvatars(page) {
    return page.evaluate(() => {
        const find = pattern => window.SillyTavern.getContext().characters.find(character => pattern.test(character?.name ?? ''))?.avatar;
        return { seraphina: find(/Seraphina/), tewi: find(/Tewi/), reisen: find(/Reisen/) };
    });
}

function thread(texts, lastMinute) {
    return texts.map(([role, mes], index) => ({ role, mes, created_at: minutes(lastMinute - (texts.length - 1 - index)) }));
}

/**
 * Five conversations, newest first: Assistant Reisen (2 unread), Seraphina, "Weekend plans" (a group of three), Assistant
 * Tewi and "Study group" (a group of two). Nothing is a favourite and nothing is muted.
 * @returns {Promise<Record<string, { conversationId: string, chatIds: string[] }>>}
 */
export async function seedConversationList(page) {
    const { seraphina, tewi, reisen } = await getCharacterAvatars(page);
    const made = {};
    made.reisen = await seedConversation(page, { avatar: reisen, chats: [{ messages: thread([['character', 'Hi'], ['user', 'Hey'], ['character', 'Almost.'], ['character', 'Ten more minutes.']], 50) }] });
    made.seraphina = await seedConversation(page, { avatar: seraphina, chats: [{ messages: thread([['character', 'Welcome back'], ['user', 'Hello'], ['character', 'Take care on the road. Tell me how it goes?']], 40) }] });
    made.weekend = await seedConversation(page, { avatar: seraphina, members: [reisen, tewi], name: 'Weekend plans', chats: [{ messages: thread([['character', 'I will bring carrots.']], 30) }] });
    made.tewi = await seedConversation(page, { avatar: tewi, chats: [{ messages: thread([['character', 'A very lucky rabbit. Me.']], 20) }] });
    made.study = await seedConversation(page, { avatar: reisen, members: [tewi], name: 'Study group', chats: [{ messages: thread([['character', 'Chapter 4 is brutal.']], 10) }] });
    // The read marker that the seed sets is moved back, so that the two newest messages of Assistant Reisen are unread.
    await patchConversation(page, made.reisen.conversationId, { chats: { [made.reisen.chatIds[0]]: { readThrough: 'seed-0-1' } } });
    return made;
}

/** Sends a patch to the route of a conversation and reads the list again in the page. */
export async function patchConversation(page, id, patch) {
    await page.evaluate(async ({ id, patch }) => {
        const { getRequestHeaders } = await import('/script.js');
        await fetch('/api/sillybunny-conversation/update', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id, patch }) });
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        await conversationData.refresh();
    }, { id, patch });
}

/** What the server holds for a conversation, after the page has written what it waits to write. */
export async function readStoredConversation(page, id) {
    return page.evaluate(async (id) => {
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        await conversationData.flush();
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch('/api/sillybunny-conversation/list', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
        return (await response.json()).conversations.find(conversation => conversation.id === id) ?? null;
    }, id);
}

/** Opens the workspace on no conversation, so that the list is what shows (the page of the list on a phone). */
export async function openConversationList(page) {
    await page.evaluate(async () => {
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
        const { stopConversationAutoWorker } = await import('/scripts/sillybunny-conversation/auto-engine.js');
        openConversationWorkspaceForAvatar(null, { showToast: false });
        stopConversationAutoWorker();
    });
    await expect(page.locator('#sheld')).toHaveAttribute('data-sb-conversation-mode', 'on');
    await expect(page.locator(`${LIST} ${ROW}`).first()).toBeVisible();
}

/** The row of the list with exactly this name; the copy of a row that follows the pointer in a drag is not in the list. */
export function rowNamed(page, name) {
    return page.locator(`${LIST} ${ROW}`).filter({ has: page.locator('.sb-conversation-list-item-name', { hasText: new RegExp(`^${name}$`) }) });
}

/** The names of the rows of a section, in order: `favorites` or `conversations`. */
export async function namesIn(page, section) {
    return page.locator(`${LIST} ${SECTION}[data-section="${section}"] ${ROW} .sb-conversation-list-item-name`).allTextContents();
}

/** Waits for the names of a section, because the list is drawn on the frame after a change. */
export async function expectNames(page, section, names) {
    await expect.poll(() => namesIn(page, section)).toEqual(names);
}

export async function sectionOfRow(row) {
    return row.evaluate(element => element.closest('[data-section]')?.dataset.section ?? '');
}

/** The centre of an element on the page, scrolled into view. */
export async function centreOf(locator) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

/** The id of the conversation that a row shows. */
export function conversationIdOf(row) {
    return row.getAttribute('data-conversation-id');
}

export async function activeElementDescription(page) {
    return page.evaluate(() => {
        const active = document.activeElement;
        const row = active?.closest?.('.sb-conversation-list-row');
        return {
            row: row?.querySelector('.sb-conversation-list-item-name')?.textContent ?? '',
            heading: Boolean(active?.closest?.('.sb-conversation-list-heading')),
            inList: Boolean(active?.closest?.('#sb_conversation_list_items')),
            tag: active?.tagName ?? '',
        };
    });
}
