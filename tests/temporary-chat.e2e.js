import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { dismissOpenDialogIfPresent, openQuietChatForSmoke } from './chat-scroll-regression-helpers.js';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { testSetup } from './frontend/frontent-test-utils.js';
import { DESKTOP, matrixViewports } from './helpers/matrix.js';
import { fetchJsonOrSkip } from './helpers/route-fetch.js';
import { applyWelcomeSettings } from './helpers/welcome-dialog.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.describe.configure({ timeout: 90_000 });

const MODEL = 'stub-model';
const REPLY = 'A stubbed reply.';
const BANNER = '#sb-temporary-chat-banner';
const GREETING_START = 'You wake with a start';
const COMMIT_HEADER = 'x-generation-commit';
const RESERVED_CHAT_ID = /^Temporary Chat: [0-9a-f]{16}$/;
/** Routes that write a chat, a card or statistics. A page that starts up reads a lot, so after a reload only these count. */
const CHAT_WRITE_PATHS = [
    /^\/api\/chats\/(?:group\/)?(?:save|rename|delete)$/,
    /^\/api\/characters\/(?:last-chat|edit[^/]*)$/,
    /^\/api\/stats\/update$/,
];

/** A chat save is debounced by `debounce_timeout.relaxed` (1000 ms); this waits that out, plus slack. */
const DEBOUNCED_SAVE_WINDOW_MS = 1500;
/** A Conversation reaction to a Roleplay message is scheduled 2000 ms after the message (sillybunny-conversation/init.js). */
const REACTION_WINDOW_MS = 4000;

const VIEWPORTS = [
    { label: '1440x900', size: { width: 1440, height: 900 } },
    { label: '390x844', size: { width: 390, height: 844 } },
];

/**
 * Requests that are not GETs and that a temporary chat may still make: reads the page needs, and writes that are
 * not chat, card, statistics or vector data. Anything else that a temporary chat sends fails the spec by name.
 */
const ALLOWED_NON_GET_PATHS = new Set([
    // Reads.
    '/api/worldinfo/get',
    '/api/characters/get',
    '/api/characters/all',
    '/api/groups/all',
    '/api/characters/chats',
    '/api/avatars/get',
    '/api/chats/recent',
    '/api/tokenizers/openai/count',
    '/api/ping',
    '/api/backends/chat-completions/status',
    // The model, which the spec stubs.
    '/api/backends/chat-completions/generate',
    // Settings: the active character in them is asserted separately.
    '/api/settings/save',
    // Quick Replies re-save their set after every chat change; it holds no chat data.
    '/api/quick-replies/save',
]);

/**
 * Starts the app as a signed-in user with the sample characters, and records what the page sends.
 * `protectMaintainerServer` stubs the writes it knows, and the routes below stub the rest, so the record is what the
 * page asked for, not what the server did.
 * @param {import('@playwright/test').Page} page Page
 * @param {object} [options] Options
 * @param {Record<string, object>} [options.extensionSettings] Extension settings to start with
 */
async function boot(page, { extensionSettings = null } = {}) {
    const requests = [];
    const settingsSaves = [];
    const generations = [];
    const recentChats = [];

    page.on('request', (request) => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/')) {
            return;
        }
        let body = null;
        const buffer = request.postDataBuffer();
        if (buffer) {
            try {
                body = JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer).toString());
            } catch {
                body = null;
            }
        }
        requests.push({ method: request.method(), path: url.pathname, body });
        if (url.pathname === '/api/settings/save' && body) {
            settingsSaves.push(body);
        }
    });

    await protectMaintainerServer(page);
    await page.route('**/api/settings/get', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        const settings = JSON.parse(data.settings);
        settings.firstRun = false;
        applyWelcomeSettings(settings);
        settings.extension_settings = settings.extension_settings || {};
        Object.assign(settings.extension_settings, extensionSettings ?? {});
        return route.fulfill({ json: { ...data, settings: JSON.stringify(settings) } });
    });
    // The list is what the server really holds, and the page never writes the file a temporary chat would need.
    await page.route('**/api/chats/recent', async (route) => {
        const data = await fetchJsonOrSkip(route);
        if (!data) return;
        recentChats.push(data);
        return route.fulfill({ json: data });
    });
    // The spec must never reach the maintainer's data: the record of the request is what counts.
    await page.route('**/api/characters/last-chat', route => route.fulfill({ json: { ok: true } }));
    await page.route('**/api/vector/**', route => route.fulfill({ json: route.request().url().endsWith('/list') ? [] : { hashes: [], metadata: [] } }));
    await page.route('**/api/backends/chat-completions/status', route => route.fulfill({ json: { data: [{ id: MODEL }] } }));
    await page.route('**/api/backends/chat-completions/generate', (route) => {
        const request = route.request();
        generations.push({ headers: request.headers(), body: request.postDataJSON() });
        return route.fulfill({ json: { id: 'stub', object: 'chat.completion', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }] } });
    });

    await openQuietChatForSmoke(page, { selectCharacter: false });
    await dismissOpenDialogIfPresent(page);
    await spyOnToasts(page);
    return { requests, settingsSaves, generations, recentChats, since: 0, settingsSince: 0 };
}

/** Records every error and warning toast, so a test can tell what the user would have been told. */
async function spyOnToasts(page) {
    await page.evaluate(() => {
        window.__toastCalls = [];
        for (const level of ['error', 'warning']) {
            const original = window.toastr[level].bind(window.toastr);
            window.toastr[level] = (...args) => {
                window.__toastCalls.push([level, args[0]]);
                return original(...args);
            };
        }
    });
}

const toastCalls = page => page.evaluate(() => window.__toastCalls);

async function connectStubModel(page) {
    await page.waitForFunction(() => typeof window.SillyBunnyShell?.openTab === 'function');
    await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'api'));
    await page.locator('#main_api').selectOption('openai');
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill('http://127.0.0.1:9/v1');
    await page.locator('#custom_model_id').fill(MODEL);
    const status = page.waitForResponse('**/api/backends/chat-completions/status');
    await page.locator('#api_button_openai').click();
    expect((await status).ok()).toBe(true);
    await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        oai_settings.stream_openai = false;
    });
    await dismissOpenDialogIfPresent(page);
    await page.locator('#sb-settings-close').click();
    await expect(page.locator('#sb-settings-page')).toBeHidden();
}

const characterIdOf = (page, name) => page.evaluate((wanted) => window.SillyTavern.getContext().characters.findIndex(character => character.name === wanted), name);
const realChatNameOf = (page, name) => page.evaluate((wanted) => window.SillyTavern.getContext().characters.find(character => character.name === wanted).chat, name);

/**
 * Starts a temporary chat with a character of the sample set. Everything the page sends from here on counts as the
 * start of the chat: `context.since` marks where it begins, and `writesSince` checks it.
 * @param {import('@playwright/test').Page} page Page
 * @param {{ requests: object[], settingsSaves: object[], since: number, settingsSince: number }} context Context from `boot`
 * @param {string} [name] Character name
 */
async function startTemporary(page, context, name = 'Seraphina') {
    const id = await characterIdOf(page, name);
    expect(id).toBeGreaterThanOrEqual(0);
    context.since = context.requests.length;
    context.settingsSince = context.settingsSaves.length;
    const opened = await page.evaluate(async (characterId) => {
        const { startTemporaryChat } = await import('/scripts/sillybunny-temporary-chat.js');
        return startTemporaryChat(characterId);
    }, id);
    expect(opened).toBe(true);
    await expect(page.locator(BANNER)).toBeVisible();
    await expect(page.locator('#chat .mes').first()).toContainText(GREETING_START);
    return { id, avatar: await page.evaluate(characterId => window.SillyTavern.getContext().characters[characterId].avatar, id) };
}

const chatState = page => page.evaluate(() => {
    const context = window.SillyTavern.getContext();
    return {
        chatId: context.getCurrentChatId(),
        messages: context.chat.map(message => ({ user: message.is_user === true, mes: message.mes })),
        cardChat: context.characters[context.characterId]?.chat ?? null,
        characterId: context.characterId,
    };
});

/** Sends a message the way the user does, and waits for the stubbed reply. */
async function sendAndWaitForReply(page, text, expectedMessages) {
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_textarea').press('Enter');
    await expect.poll(async () => (await chatState(page)).messages.length, { timeout: 20_000 }).toBe(expectedMessages);
    await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.mes), { timeout: 20_000 }).toBe(REPLY);
}

/** Sends a user message without a reply, which is all that makes a chat "written in". */
const sendUserMessage = (page, text) => page.evaluate(async (message) => {
    const { sendMessageAsUser } = await import('/script.js');
    await sendMessageAsUser(message, '');
}, text);

/** Makes the page save its settings now, so that a test can read what a save carries. */
const saveSettingsNow = page => page.evaluate(async () => (await import('/script.js')).saveSettings());

/**
 * Paths of the requests that a temporary chat must not make: every non-GET request in the range that is not on the
 * allowlist of reads and non-chat writes.
 * @param {{ requests: { method: string, path: string }[], since: number }} context Context from `boot`
 * @param {number} [from] First request to look at; the start of the temporary chat by default
 * @param {number} [until] End of the range
 */
const writesSince = (context, from = context.since, until = context.requests.length) => context.requests
    .slice(from, until)
    .filter(({ method, path }) => method !== 'GET' && !ALLOWED_NON_GET_PATHS.has(path))
    .map(({ path }) => path);
const countOf = (requests, path) => requests.filter(request => request.path === path).length;
const alertOf = page => page.locator('[role="alertdialog"]');
const tabWarningArmed = page => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
});

/** Whether the file-bound message actions would be offered: the message menu reads this with its probe attribute on. */
const fileBoundActionDisplays = page => page.evaluate(() => [...document.querySelectorAll('#chat .mes')].flatMap((message) => {
    message.setAttribute('data-sb-actions-probe', '');
    const displays = ['mes_create_branch', 'mes_create_bookmark', 'mes_bookmark']
        .map(name => message.querySelector(`.${name}`))
        .filter(Boolean)
        .map(element => getComputedStyle(element).display);
    message.removeAttribute('data-sb-actions-probe');
    return displays;
}));

/** The entries of the options menu that write a chat file, as the page renders them. */
const optionsMenuDisplays = page => page.evaluate(() => ['option_new_bookmark', 'option_convert_to_group']
    .map(id => [id, getComputedStyle(document.getElementById(id)).display]));

/** What is stored for the chats of the page: the number of prompt sets under each chat id (itemized-prompts.js). */
const storedPromptSets = page => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('SillyTavern_Prompts');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
        const database = open.result;
        const [store] = database.objectStoreNames;
        if (!store) {
            resolve({});
            return;
        }
        const objects = database.transaction(store, 'readonly').objectStore(store);
        const values = objects.getAll();
        const keys = objects.getAllKeys();
        values.onsuccess = () => {
            keys.onsuccess = () => resolve(Object.fromEntries(keys.result.map((key, index) => [key, Array.isArray(values.result[index]) ? values.result[index].length : 0])));
        };
    };
}));

for (const { label, size } of matrixViewports(VIEWPORTS, [DESKTOP], viewport => viewport.size)) {
    test.describe(`Temporary Chat at ${label}`, () => {
        test.use({ viewport: size });

        test.describe('while open', () => {
            test('opens with the greeting of the card and a banner, and sends nothing that writes', async ({ page }) => {
                const context = await boot(page);
                const { requests } = context;
                const realChatName = await realChatNameOf(page, 'Seraphina');

                const { avatar } = await startTemporary(page, context);
                await saveSettingsNow(page);
                const settingsSaves = context.settingsSaves.slice(context.settingsSince);
                await page.waitForTimeout(DEBOUNCED_SAVE_WINDOW_MS);

                // The card form is saved with the card, so it must keep the real chat name, not the stand-in.
                expect(await page.evaluate(() => document.getElementById('selected_chat_pole').value)).toBe(realChatName);

                const state = await chatState(page);
                expect(state.messages).toHaveLength(1);
                expect(state.messages[0].mes).toContain(GREETING_START);
                expect(state.chatId).toMatch(RESERVED_CHAT_ID);

                expect(writesSince(context)).toEqual([]);
                expect(countOf(requests, '/api/chats/get')).toBe(0);
                expect(settingsSaves.length).toBeGreaterThan(0);
                expect(settingsSaves.every(save => save.active_character === null)).toBe(true);
                expect(settingsSaves.some(save => save.active_character === avatar)).toBe(false);

                const title = page.locator(`${BANNER} > span`);
                await expect(title).toHaveText('TODO(copy)');
                await expect(title).toHaveAttribute('data-sb-copy-slot', 'TC-BANNER');
                await expect(title).toHaveAttribute('data-sb-copy-placeholder', 'true');
                await expect(page.locator(`${BANNER} button`)).toHaveCount(1);
                await expect(page.locator(`${BANNER} button`)).toHaveText('Save as New Chat');
            });

            test('shows "Temporary Chat" in the chat bar instead of its internal id', async ({ page }) => {
                const context = await boot(page);
                await startTemporary(page, context);

                await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('select option')].filter(option => option.textContent === 'Temporary Chat').length)).toBeGreaterThan(0);
                const leaks = await page.evaluate(() => ({
                    text: [...document.querySelectorAll('body *')]
                        .filter(element => element.children.length === 0 && element.textContent.includes('Temporary Chat:') && element.getBoundingClientRect().width > 0)
                        .map(element => `${element.tagName}.${element.className}`),
                    options: [...document.querySelectorAll('select option')].filter(option => option.textContent.includes('Temporary Chat:')).map(option => option.textContent),
                    attributes: [...document.querySelectorAll('[title*="Temporary Chat:"], [aria-label*="Temporary Chat:"], [data-tooltip*="Temporary Chat:"]')].map(element => element.className),
                }));
                expect(leaks).toEqual({ text: [], options: [], attributes: [] });
                expect(writesSince(context)).toEqual([]);
            });

            test('keeps writing nothing across a sent message, a swipe, an edit and a delete, and gives the server no commit plan', async ({ page }) => {
                const context = await boot(page);
                const { requests, generations } = context;
                await connectStubModel(page);
                await startTemporary(page, context);

                await sendAndWaitForReply(page, 'Hello there', 3);
                expect(generations).toHaveLength(1);

                // A swipe on the greeting-less reply makes another generation.
                await page.evaluate(() => window.$('#chat .mes').last().find('.swipe_right').trigger('click'));
                await expect.poll(() => generations.length, { timeout: 20_000 }).toBe(2);
                await expect.poll(() => page.evaluate(() => window.SillyTavern.getContext().chat.at(-1)?.swipes?.length), { timeout: 20_000 }).toBe(2);

                // An edit of the user's message.
                await page.locator('#chat .mes[mesid="1"] .mes_edit').click();
                await page.locator('#curEditTextarea').fill('Hello again');
                await page.locator('#chat .mes[mesid="1"] .mes_edit_done').click();
                await expect.poll(async () => (await chatState(page)).messages[1].mes).toBe('Hello again');

                // A delete of the reply.
                await page.evaluate(async () => {
                    const { deleteMessage } = await import('/script.js');
                    await deleteMessage(2);
                });
                await expect.poll(async () => (await chatState(page)).messages.length).toBe(2);
                await page.waitForTimeout(DEBOUNCED_SAVE_WINDOW_MS);

                expect(writesSince(context)).toEqual([]);
                expect(generations.every(({ headers }) => headers[COMMIT_HEADER] === undefined)).toBe(true);
                expect(requests.some(({ path }) => path.startsWith('/api/resumable-generations/'))).toBe(false);
                // A write that the page declines must not surface as an error or a warning to the user.
                expect(await toastCalls(page)).toEqual([]);
                await expect(page.locator(BANNER)).toBeVisible();
                expect((await chatState(page)).chatId).toMatch(RESERVED_CHAT_ID);
            });

            test('keeps its stand-in chat name when the card or the character list is read again from the server', async ({ page }) => {
                const context = await boot(page);
                const { id, avatar } = await startTemporary(page, context);

                for (const reread of ['getOneCharacter', 'getCharacters']) {
                    await page.evaluate(async ({ name, target }) => {
                        const script = await import('/script.js');
                        await (name === 'getOneCharacter' ? script.getOneCharacter(target) : script.getCharacters());
                    }, { name: reread, target: avatar });

                    const state = await chatState(page);
                    expect([reread, state.cardChat]).toEqual([reread, expect.stringMatching(RESERVED_CHAT_ID)]);
                    expect(state.chatId).toBe(state.cardChat);
                }
                expect(await page.evaluate(characterId => window.SillyTavern.getContext().characters[characterId].avatar, id)).toBe(avatar);
                expect(writesSince(context)).toEqual([]);
            });

            test('reloading the open chat redraws it from memory, without asking or reading any chat file', async ({ page }) => {
                const context = await boot(page);
                await startTemporary(page, context);
                await sendUserMessage(page, 'Hello there');

                await page.evaluate(() => window.SillyTavern.getContext().reloadCurrentChat());

                await expect(alertOf(page)).toHaveCount(0);
                const state = await chatState(page);
                expect(state.messages.map(message => message.mes)).toEqual([expect.stringContaining(GREETING_START), 'Hello there']);
                await expect(page.locator('#chat .mes')).toHaveCount(2);
                expect(state.chatId).toMatch(RESERVED_CHAT_ID);
                expect(countOf(context.requests, '/api/chats/get')).toBe(0);
                expect(writesSince(context)).toEqual([]);
            });

            test('reports success when a cache clear or a rename flushes the chat, without a save or an error', async ({ page }) => {
                const context = await boot(page);
                await startTemporary(page, context);
                await sendUserMessage(page, 'Hello there');

                const flushed = await page.evaluate(async () => (await import('/script.js')).flushPendingChatSaves());

                expect(flushed).toBe(true);
                expect(await toastCalls(page)).toEqual([]);
                expect(writesSince(context)).toEqual([]);
            });

            test('a normal chat sends the commit plan that a temporary chat does not (control)', async ({ page }) => {
                const { generations } = await boot(page);
                await connectStubModel(page);
                const id = await characterIdOf(page, 'Seraphina');
                await page.evaluate(characterId => window.SillyTavern.getContext().selectCharacterById(characterId, { switchMenu: false }), id);
                await expect(page.locator('#send_textarea')).toBeVisible();
                await dismissOpenDialogIfPresent(page);

                const before = (await chatState(page)).messages.length;
                await sendAndWaitForReply(page, 'Hello control', before + 2);

                expect(generations).toHaveLength(1);
                expect(generations[0].headers[COMMIT_HEADER]).toBeTruthy();
            });
        });

        test.describe('vectors', () => {
            const VECTORS = { vectors: { enabled: true, enabled_chats: true, source: 'extras' } };

            test('a normal chat fills the vector collection of its chat (control)', async ({ page }) => {
                const { requests } = await boot(page, { extensionSettings: VECTORS });
                await connectStubModel(page);
                const id = await characterIdOf(page, 'Seraphina');
                await page.evaluate(characterId => window.SillyTavern.getContext().selectCharacterById(characterId, { switchMenu: false }), id);
                await dismissOpenDialogIfPresent(page);
                const before = (await chatState(page)).messages.length;

                await sendAndWaitForReply(page, 'Hello control', before + 2);

                await expect.poll(() => requests.filter(({ path }) => path.startsWith('/api/vector/')).length, { timeout: 20_000 }).toBeGreaterThan(0);
            });

            test('a temporary chat lists, fills, queries and purges no vector collection', async ({ page }) => {
                const context = await boot(page, { extensionSettings: VECTORS });
                await connectStubModel(page);
                await startTemporary(page, context);

                await sendAndWaitForReply(page, 'Hello there', 3);
                await page.waitForTimeout(DEBOUNCED_SAVE_WINDOW_MS * 2);

                expect(context.requests.filter(({ path }) => path.startsWith('/api/vector/')).map(({ path, body }) => ({ path, collectionId: body?.collectionId }))).toEqual([]);
                expect(writesSince(context)).toEqual([]);
            });
        });

        test.describe('message actions', () => {
            test('hide the ones that write a chat file while the chat is temporary, and offer them again for a normal chat', async ({ page }) => {
                const context = await boot(page);
                await startTemporary(page, context);
                await sendUserMessage(page, 'Hello there');

                const hidden = await fileBoundActionDisplays(page);
                expect(hidden.length).toBeGreaterThan(0);
                expect(hidden.every(display => display === 'none')).toBe(true);
                expect(await optionsMenuDisplays(page)).toEqual([['option_new_bookmark', 'none'], ['option_convert_to_group', 'none']]);
                await expect(page.locator('html')).toHaveAttribute('data-sb-temporary-chat', 'true');

                const closed = page.evaluate(() => window.SillyTavern.getContext().closeCurrentChat());
                await alertOf(page).getByRole('button', { name: 'Discard' }).click();
                await closed;
                await expect(page.locator('html')).not.toHaveAttribute('data-sb-temporary-chat', 'true');

                const id = await characterIdOf(page, 'Seraphina');
                await page.evaluate(characterId => window.SillyTavern.getContext().selectCharacterById(characterId, { switchMenu: false }), id);
                await dismissOpenDialogIfPresent(page);
                await expect(page.locator('#chat .mes').first()).toBeVisible();
                const offered = await fileBoundActionDisplays(page);
                expect(offered.some(display => display !== 'none')).toBe(true);
                expect((await optionsMenuDisplays(page)).every(([, display]) => display !== 'none')).toBe(true);
            });

            for (const command of ['/branch-create', '/checkpoint-create']) {
                test(`${command} says it cannot run while the chat is temporary, and writes nothing`, async ({ page }) => {
                    const context = await boot(page);
                    await startTemporary(page, context);
                    await sendUserMessage(page, 'Hello there');

                    const result = await page.evaluate(async (text) => {
                        const { isError, errorMessage, pipe } = await window.SillyTavern.getContext().executeSlashCommandsWithOptions(text, { handleExecutionErrors: true });
                        return { isError, errorMessage, pipe };
                    }, command);

                    expect(result.isError).toBe(true);
                    expect(result.errorMessage).toContain('TODO(copy)');
                    await expect(page.locator(BANNER)).toBeVisible();
                    expect(writesSince(context)).toEqual([]);
                });
            }
        });

        test.describe('saving', () => {
            test('Save as New Chat writes one chat file and records it, the banner goes, and the next message saves normally', async ({ page }) => {
                const context = await boot(page);
                const { requests, settingsSaves } = context;
                await connectStubModel(page);
                const { avatar } = await startTemporary(page, context);
                await sendAndWaitForReply(page, 'Hello there', 3);
                const beforeSave = requests.length;
                expect(writesSince(context, context.since, beforeSave)).toEqual([]);

                await page.locator(`${BANNER} button`).click();
                await expect(page.locator(BANNER)).toHaveCount(0);

                await expect.poll(() => countOf(requests.slice(beforeSave), '/api/characters/last-chat')).toBe(1);
                const saves = requests.slice(beforeSave).filter(({ path }) => path === '/api/chats/save');
                expect(saves).toHaveLength(1);
                const { file_name: fileName, chat: saved, avatar_url: savedAvatar } = saves[0].body;
                expect(fileName).toMatch(/^Seraphina - /);
                expect(savedAvatar).toBe(avatar);
                expect(saved[0].chat_metadata.integrity).toBeTruthy();
                expect(saved.slice(1).map(message => message.mes)).toEqual([expect.stringContaining(GREETING_START), 'Hello there', REPLY]);
                expect(requests.slice(beforeSave).find(({ path }) => path === '/api/characters/last-chat').body).toEqual({ avatar, chat: fileName });
                expect(writesSince(context, beforeSave).sort()).toEqual(['/api/characters/last-chat', '/api/chats/save']);

                expect((await chatState(page)).chatId).toBe(fileName);
                await expect.poll(() => settingsSaves.at(-1)?.active_character).toBe(avatar);
                await expect(page.locator('html')).not.toHaveAttribute('data-sb-temporary-chat', 'true');

                // The chat is a normal chat now: the next message saves into the same file.
                const afterSave = requests.length;
                await sendAndWaitForReply(page, 'And another', 5);
                await expect.poll(() => countOf(requests.slice(afterSave), '/api/chats/save')).toBeGreaterThan(0);
                expect(requests.slice(afterSave).filter(({ path }) => path === '/api/chats/save').every(({ body }) => body.file_name === fileName)).toBe(true);
            });

            test('a failed Save as New Chat keeps the chat temporary and its banner, with one error toast and the tab warning armed', async ({ page }) => {
                const context = await boot(page);
                const { requests } = context;
                await startTemporary(page, context);
                await sendUserMessage(page, 'Hello there');
                const beforeSave = requests.length;
                expect(writesSince(context, context.since, beforeSave)).toEqual([]);
                await page.route('**/api/chats/save', route => route.fulfill({ status: 500, json: { error: 'disk full' } }));

                await page.locator(`${BANNER} button`).click();

                await expect.poll(() => countOf(requests.slice(beforeSave), '/api/chats/save')).toBe(1);
                // The chat leaves the temporary state while the save is in flight, and returns to it when the save fails.
                await expect.poll(async () => (await chatState(page)).chatId).toMatch(RESERVED_CHAT_ID);
                await expect(page.locator(BANNER)).toBeVisible();
                expect(countOf(requests.slice(beforeSave), '/api/characters/last-chat')).toBe(0);
                expect(countOf(requests.slice(beforeSave), '/api/chats/save')).toBe(1);
                expect((await toastCalls(page)).filter(([level]) => level === 'error')).toHaveLength(1);
                expect(await tabWarningArmed(page)).toBe(true);
            });
        });

        test.describe('leaving', () => {
            async function openWrittenTemporaryChat(page, options) {
                const context = await boot(page, options);
                const realChatName = await realChatNameOf(page, 'Seraphina');
                const target = await startTemporary(page, context);
                await sendUserMessage(page, 'Hello there');
                context.sent = context.requests.length;
                expect(writesSince(context)).toEqual([]);
                return { ...context, ...target, realChatName };
            }

            const expectHome = page => expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: 20_000 });
            const clickHome = page => page.locator('#sb-home-toggle').evaluate(button => button.click());

            test('a chat with only the greeting closes silently', async ({ page }) => {
                const context = await boot(page);
                await startTemporary(page, context);

                await clickHome(page);

                await expectHome(page);
                await expect(alertOf(page)).toHaveCount(0);
                await expect(page.locator(BANNER)).toHaveCount(0);
                expect(writesSince(context)).toEqual([]);
            });

            test('asks once the user sent a message, with Cancel, Discard and Save as New Chat, and the copy slots', async ({ page }) => {
                await openWrittenTemporaryChat(page);

                await clickHome(page);

                const alert = alertOf(page);
                await expect(alert).toBeVisible();
                await expect(alert.getByRole('button')).toHaveText(['Cancel', 'Discard', 'Save as New Chat']);
                await expect(alert.locator('.sb-dialog__heading')).toHaveAttribute('data-sb-copy-slot', 'TC-LEAVE-HEAD');
                await expect(alert.locator('.sb-dialog__message')).toHaveAttribute('data-sb-copy-slot', 'TC-LEAVE-BODY');
                await expect(alert.locator('.sb-dialog__heading')).toHaveText('TODO(copy)');
            });

            test('Cancel keeps the user in the temporary chat, unsaved', async ({ page }) => {
                const context = await openWrittenTemporaryChat(page);
                await clickHome(page);

                await alertOf(page).getByRole('button', { name: 'Cancel' }).click();

                await expect(alertOf(page)).toHaveCount(0);
                await expect(page.locator(BANNER)).toBeVisible();
                const state = await chatState(page);
                expect(state.chatId).toMatch(RESERVED_CHAT_ID);
                expect(state.messages.map(message => message.mes)).toContain('Hello there');
                await expect(page.locator('#sheld')).not.toHaveAttribute('data-sb-home', 'on');
                expect(writesSince(context)).toEqual([]);
            });

            test('Cancel at the Home button leaves an open settings page where it was', async ({ page }) => {
                await openWrittenTemporaryChat(page);
                await page.evaluate(() => window.SillyBunnyShell.openTab('left', 'api'));
                await expect(page.locator('#sb-settings-page')).toBeVisible();

                await clickHome(page);
                await alertOf(page).getByRole('button', { name: 'Cancel' }).click();

                await expect(alertOf(page)).toHaveCount(0);
                await expect(page.locator('#sb-settings-page')).toBeVisible();
                await expect(page.locator(BANNER)).toBeVisible();
            });

            test('Discard goes Home, gives the card its real chat back and writes nothing, and Recent Chats never lists it', async ({ page }) => {
                const context = await openWrittenTemporaryChat(page);
                const { id, realChatName, recentChats } = context;
                await clickHome(page);

                await alertOf(page).getByRole('button', { name: 'Discard' }).click();

                await expectHome(page);
                await expect(page.locator(BANNER)).toHaveCount(0);
                expect(await page.evaluate(characterId => window.SillyTavern.getContext().characters[characterId].chat, id)).toBe(realChatName);
                await expect(page.locator('#welcome-recent-chat-list')).not.toContainText('Temporary Chat');
                expect(recentChats.length).toBeGreaterThan(0);
                expect(JSON.stringify(recentChats)).not.toContain('Temporary Chat');
                await page.waitForTimeout(DEBOUNCED_SAVE_WINDOW_MS);
                expect(writesSince(context)).toEqual([]);
            });

            test('a Discard that the navigation did not follow does not excuse a message that is edited afterwards', async ({ page }) => {
                const context = await openWrittenTemporaryChat(page);
                const leave = () => page.evaluate(async () => (await import('/scripts/sillybunny-temporary-chat.js')).leaveTemporaryChat());

                // The user agrees to discard, and the navigation that asked is refused afterwards (a send is running).
                const agreed = leave();
                await alertOf(page).getByRole('button', { name: 'Discard' }).click();
                expect(await agreed).toBe(true);
                expect(await leave()).toBe(true);
                await expect(alertOf(page)).toHaveCount(0);

                await page.evaluate(async () => {
                    (await import('/script.js')).chat[1].mes = 'Edited after the Discard';
                });
                const asked = leave();

                await expect(alertOf(page)).toBeVisible();
                await alertOf(page).getByRole('button', { name: 'Cancel' }).click();
                expect(await asked).toBe(false);
                await expect(page.locator(BANNER)).toBeVisible();
                expect(writesSince(context)).toEqual([]);
            });

            test('Save as New Chat writes the chat once and then goes Home', async ({ page }) => {
                const context = await openWrittenTemporaryChat(page);
                await clickHome(page);

                await alertOf(page).getByRole('button', { name: 'Save as New Chat' }).click();

                await expectHome(page);
                const after = context.requests.slice(context.sent);
                expect(countOf(after, '/api/chats/save')).toBe(1);
                expect(countOf(after, '/api/characters/last-chat')).toBe(1);
                await expect(page.locator(BANNER)).toHaveCount(0);
            });

            test('Discard, then New Chat with "delete current chat", deletes no chat file', async ({ page }) => {
                const context = await openWrittenTemporaryChat(page);

                const started = page.evaluate(async () => (await import('/script.js')).doNewChat({ deleteCurrentChat: true }));
                await expect(alertOf(page)).toBeVisible();
                await alertOf(page).getByRole('button', { name: 'Discard' }).click();
                await started;

                await expect(page.locator(BANNER)).toHaveCount(0);
                expect(context.requests.slice(context.sent).filter(({ path }) => path === '/api/chats/delete')).toEqual([]);
            });

            const LEAVES = {
                'selecting another character': async (page) => {
                    const other = await characterIdOf(page, 'Bunny Guide');
                    return page.evaluate(id => window.SillyTavern.getContext().selectCharacterById(id, { switchMenu: false }), other);
                },
                'starting a new chat': page => page.evaluate(async () => (await import('/script.js')).doNewChat()),
                'closing the chat': page => page.evaluate(() => window.SillyTavern.getContext().closeCurrentChat()),
                'starting another temporary chat': async (page) => {
                    const other = await characterIdOf(page, 'Bunny Guide');
                    return page.evaluate(async (id) => (await import('/scripts/sillybunny-temporary-chat.js')).startTemporaryChat(id), other);
                },
                'the /random command': page => page.evaluate(async () => (await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/random')).pipe),
                'the /go command': page => page.evaluate(async () => (await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/go Bunny Guide')).pipe),
                'selecting a group': page => page.evaluate(async () => {
                    const { groups, openGroupById } = await import('/scripts/group-chats.js');
                    groups.push({ id: 'tc-group', name: 'TC Group', members: [], chat_id: 'tc-group-chat', chats: ['tc-group-chat'] });
                    return openGroupById('tc-group', { switchMenu: false });
                }),
                'opening a chat from Recent Chats': async (page) => {
                    const avatar = await page.evaluate(() => window.SillyTavern.getContext().characters.find(character => character.name === 'Bunny Guide').avatar);
                    await page.route('**/api/chats/recent', route => route.fulfill({ json: [{ file_name: 'Bunny Guide - recent.jsonl', avatar, last_mes: new Date().toISOString(), mes: 'Hello', chat_items: 1 }] }));
                    return page.evaluate(async () => (await import('/scripts/welcome-screen.js')).resumeLatestRoleplayChat());
                },
            };

            for (const [name, leave] of Object.entries(LEAVES)) {
                test(`${name} asks first, and Cancel stays without a word`, async ({ page }) => {
                    const context = await openWrittenTemporaryChat(page);
                    const characterBefore = (await chatState(page)).characterId;

                    const left = leave(page);
                    await expect(alertOf(page)).toBeVisible();
                    await alertOf(page).getByRole('button', { name: 'Cancel' }).click();
                    await left;

                    await expect(page.locator(BANNER)).toBeVisible();
                    const state = await chatState(page);
                    expect(state.chatId).toMatch(RESERVED_CHAT_ID);
                    expect(state.characterId).toBe(characterBefore);
                    expect(await tabWarningArmed(page)).toBe(true);
                    expect(await toastCalls(page)).toEqual([]);
                    expect(writesSince(context)).toEqual([]);
                });
            }

            test('a rename of the open character asks first, and Cancel renames nothing', async ({ page }) => {
                const context = await openWrittenTemporaryChat(page);
                await page.route('**/api/characters/rename', route => route.fulfill({ status: 500, json: { error: 'stubbed' } }));
                const characterBefore = (await chatState(page)).characterId;

                const renamed = page.evaluate(async () => (await import('/script.js')).renameCharacter('Seraphina Renamed', { silent: true }));
                await expect(alertOf(page)).toBeVisible();
                await alertOf(page).getByRole('button', { name: 'Cancel' }).click();

                expect(await renamed).toBe(false);
                expect(countOf(context.requests, '/api/characters/rename')).toBe(0);
                await expect(page.locator(BANNER)).toBeVisible();
                const state = await chatState(page);
                expect(state.chatId).toMatch(RESERVED_CHAT_ID);
                expect(state.characterId).toBe(characterBefore);
                expect(writesSince(context)).toEqual([]);
            });

            test('Discard, then another character, stores the prompts of the temporary chat under no chat', async ({ page }) => {
                const context = await boot(page);
                await connectStubModel(page);
                await startTemporary(page, context);
                await sendAndWaitForReply(page, 'Hello there', 3);
                expect(await page.evaluate(async () => (await import('/scripts/itemized-prompts.js')).itemizedPrompts.length)).toBeGreaterThan(0);

                const other = await characterIdOf(page, 'Bunny Guide');
                const left = page.evaluate(id => window.SillyTavern.getContext().selectCharacterById(id, { switchMenu: false }), other);
                await alertOf(page).getByRole('button', { name: 'Discard' }).click();
                await left;
                await dismissOpenDialogIfPresent(page);
                await page.evaluate(async () => (await import('/script.js')).reloadCurrentChat());

                expect(Object.values(await storedPromptSets(page)).filter(count => count > 0)).toEqual([]);
            });

            test('a reload after the selection moved without leaving stores the prompts of the temporary chat under no chat', async ({ page }) => {
                const context = await boot(page);
                await connectStubModel(page);
                await startTemporary(page, context);
                await sendAndWaitForReply(page, 'Hello there', 3);
                expect(await page.evaluate(async () => (await import('/scripts/itemized-prompts.js')).itemizedPrompts.length)).toBeGreaterThan(0);

                const other = await characterIdOf(page, 'Bunny Guide');
                await page.evaluate(async (id) => {
                    const script = await import('/script.js');
                    script.setCharacterId(String(id));
                    await script.reloadCurrentChat();
                }, other);
                await expect(page.locator(BANNER)).toHaveCount(0);

                expect(Object.values(await storedPromptSets(page)).filter(count => count > 0)).toEqual([]);
            });

            test('closing the tab asks only after the user sent a message', async ({ page }) => {
                const context = await boot(page);
                await startTemporary(page, context);
                await page.locator('#send_textarea').click();
                const dialogs = [];
                page.on('dialog', (dialog) => {
                    dialogs.push(dialog.type());
                    return dialog.accept();
                });

                const closed = page.waitForEvent('close');
                await page.close({ runBeforeUnload: true });
                await closed;

                expect(dialogs.filter(type => type === 'beforeunload')).toEqual([]);
            });

            test('closing the tab asks after the user sent a message', async ({ page }) => {
                const context = await boot(page);
                await startTemporary(page, context);
                await sendUserMessage(page, 'Hello there');
                await page.locator('#send_textarea').click();

                const prompted = page.waitForEvent('dialog', { predicate: dialog => dialog.type() === 'beforeunload' });
                await page.close({ runBeforeUnload: true });
                const dialog = await prompted;
                await dialog.dismiss();

                expect(page.isClosed()).toBe(false);
            });
        });

        test.describe('reload, modes and reactions', () => {
            test('a reload drops the temporary chat and neither opens nor creates the real chat of the character', async ({ page }) => {
                const context = await boot(page);
                const { requests, settingsSaves } = context;
                const realChatName = await realChatNameOf(page, 'Seraphina');
                const { id, avatar } = await startTemporary(page, context);
                await sendUserMessage(page, 'Hello there');
                page.on('dialog', dialog => dialog.accept());
                const beforeReload = requests.length;

                await page.reload();
                await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
                await testSetup.waitForAppReady({ page });
                await dismissOpenDialogIfPresent(page);
                await expect(page.locator('#sheld')).toHaveAttribute('data-sb-home', 'on', { timeout: 20_000 });

                const after = await chatState(page);
                expect(after.chatId ?? '').not.toMatch(/^Temporary Chat/);
                expect(await page.evaluate(characterId => window.SillyTavern.getContext().characters[characterId].chat, id)).toBe(realChatName);
                expect(writesSince(context, context.since, beforeReload)).toEqual([]);
                expect(requests.slice(beforeReload).filter(({ path }) => CHAT_WRITE_PATHS.some(pattern => pattern.test(path)))).toEqual([]);
                expect(requests.slice(beforeReload).filter(({ path, body }) => path === '/api/chats/get' && body?.allow_create === true)).toEqual([]);
                expect(settingsSaves.filter(save => save.active_character === avatar)).toEqual([]);
            });

            test('starting from Conversation mode opens the chat in Roleplay', async ({ page }) => {
                const context = await boot(page);
                const avatar = await page.evaluate(() => window.SillyTavern.getContext().characters.find(character => character.name === 'Bunny Guide').avatar);
                await page.evaluate(async (target) => {
                    const { openConversationWorkspaceForAvatar } = await import('/scripts/sillybunny-conversation.js');
                    openConversationWorkspaceForAvatar(target, { showToast: false });
                }, avatar);
                await expect(page.locator('#sheld[data-sb-conversation-mode="on"]')).toBeAttached({ timeout: 20_000 });
                const beforeStart = context.requests.length;

                await startTemporary(page, context);

                await expect(page.locator('#sheld[data-sb-conversation-mode="on"]')).toHaveCount(0);
                await expect(page.locator('#form_sheld')).toBeVisible();
                expect(writesSince(context, beforeStart)).toEqual([]);
            });


            /** A request that asks the model for a character's private reaction to a roleplay that contains `text` (sillybunny-conversation/auto-engine.js). */
            const reactionsTo = (generations, text) => generations.filter(({ body }) => JSON.stringify(body).includes('private direct message (DM)') && JSON.stringify(body).includes(text));

            /** Turns on "React to current roleplay" for a character and makes the reaction roll always succeed. */
            async function enableReactions(page, name) {
                await page.evaluate(async (characterName) => {
                    const { saveSettings, getSettings } = await import('/scripts/sillybunny-conversation/settings-store.js');
                    const context = window.SillyTavern.getContext();
                    const avatar = context.characters.find(character => character.name === characterName).avatar;
                    const options = { groupId: '', personaId: String(context.userAvatar ?? '') };
                    saveSettings(avatar, { ...getSettings(avatar, options), enabled: true, roleplay_reactions: true }, options);
                    Math.random = () => 0;
                }, name);
            }

            test('Conversation reactions to a normal roleplay generate a message, and none do while the chat is temporary', async ({ page }) => {
                const context = await boot(page);
                const { generations } = context;
                await connectStubModel(page);
                await enableReactions(page, 'Seraphina');

                // Control: a normal chat makes the reply and then asks the model for the reaction.
                const id = await characterIdOf(page, 'Seraphina');
                await page.evaluate(characterId => window.SillyTavern.getContext().selectCharacterById(characterId, { switchMenu: false }), id);
                await dismissOpenDialogIfPresent(page);
                const before = (await chatState(page)).messages.length;
                await sendAndWaitForReply(page, 'Hello control', before + 2);
                await expect.poll(() => reactionsTo(generations, 'Hello control').length, { timeout: 15_000 }).toBeGreaterThan(0);

                await startTemporary(page, context);
                await sendAndWaitForReply(page, 'Hello again', 3);
                await page.waitForTimeout(REACTION_WINDOW_MS);

                expect(generations.some(({ body }) => JSON.stringify(body).includes('Hello again'))).toBe(true);
                expect(reactionsTo(generations, 'Hello again')).toEqual([]);
                expect(writesSince(context)).toEqual([]);
            });
        });
    });
}
