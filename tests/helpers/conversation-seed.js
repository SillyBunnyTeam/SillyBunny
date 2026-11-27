/**
 * Puts conversations on the server for a spec, through the routes of conversation storage (`/create`, `/chat/create`,
 * `/chat/save`), so that a spec starts from what the store writes and does not use the client module that it tests to
 * make its data. The routes refuse a ready-made record, so a conversation is made first and its chats are saved after.
 *
 * The server's user is shared by every spec that runs against it, in parallel. Three things keep specs from touching each
 * other's conversations: a spec that edits the settings of its page gives the page its own persona (`uniquePersona()`),
 * because a page lists only the conversations of its persona; `resetConversations()` removes only the conversations of the
 * persona of the page; and seeding is idempotent, so two workers that seed the same conversation write the same thing.
 *
 * Call the functions on a page that has loaded the app (the requests carry its headers). `seedConversation()` ends by
 * asking the page's data module to read the list again, so the conversation is there for the page when it returns.
 */

import { randomUUID } from 'node:crypto';

const ROUTE_PREFIX = '/api/sillybunny-conversation';

/**
 * A persona file name that no other page has. Put it in `settings.user_avatar` of a page whose `/api/settings/get` the spec
 * answers itself, and the page sees none of the conversations that other specs make on the same server.
 * @returns {string}
 */
export function uniquePersona() {
    return `qa-persona-${randomUUID().slice(0, 8)}.png`;
}

/**
 * Removes the conversations of the persona of the page, and reads the list again in the page.
 * @param {import('@playwright/test').Page} page
 */
export async function resetConversations(page) {
    await page.evaluate(async (prefix) => {
        const { getRequestHeaders } = await import('/script.js');
        const { user_avatar: personaId } = await import('/scripts/personas.js');
        const post = async (path, body) => {
            const response = await fetch(`${prefix}${path}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
            return { status: response.status, json: await response.json().catch(() => null) };
        };
        const list = await post('/list', {});
        for (const conversation of list.json?.conversations ?? []) {
            if (conversation.personaId === personaId) {
                await post('/delete', { id: conversation.id });
            }
        }
        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        await conversationData.whenReady();
        await conversationData.refresh();
    }, ROUTE_PREFIX);
}

/**
 * The messages of a thread from their texts: the character first, then the user, a minute apart from noon on 2026-01-01.
 * @param {string[]} texts
 * @param {{ character?: string, user?: string }} [names]
 * @returns {SeedMessage[]}
 */
export function alternatingMessages(texts, { character = 'Audit Character', user = 'Audit User' } = {}) {
    const day = Date.UTC(2026, 0, 1, 12, 0, 0);
    return texts.map((mes, number) => ({
        id: `audit-${number}`,
        role: number % 2 === 0 ? 'character' : 'user',
        name: number % 2 === 0 ? character : user,
        mes,
        created_at: day + number * 60_000,
    }));
}

/**
 * @typedef {object} SeedMessage
 * @property {string} [id]
 * @property {'user'|'character'|'member'|'system'} [role] `character` by default.
 * @property {string} [name]
 * @property {string} mes
 * @property {number} [created_at] Milliseconds since the epoch; messages without one follow each other by a minute.
 * @property {object} [extra]
 *
 * @typedef {object} SeedChat
 * @property {string} [id] The id of a chat after the first, which makes a seed that runs again find its chat; the first chat has the one that the conversation was made with.
 * @property {string} [name]
 * @property {SeedMessage[]} [messages]
 *
 * @typedef {object} SeedOptions
 * @property {string} avatar The avatar file of the character; the first one of a group.
 * @property {string[]} [members] Other characters, which makes the conversation a group.
 * @property {string} [name] The name of a group.
 * @property {string} [personaId] The persona of the page by default.
 * @property {SeedChat[]} [chats] One empty chat by default.
 * @property {number} [activeChat] The index of the chat that is active, 0 by default.
 * @property {boolean} [replace] Remove the conversation of the persona with these characters first, so the spec starts from exactly this. Without it a conversation that is there is kept and its chats are written again.
 */

/**
 * Makes a conversation with the given chats and messages, or writes them into the one that is there. Every chat is read
 * until its last message, so the conversation starts with no unread messages.
 * @param {import('@playwright/test').Page} page
 * @param {SeedOptions} options
 * @returns {Promise<{ conversationId: string, chatIds: string[] }>}
 */
export async function seedConversation(page, options) {
    return page.evaluate(async ({ options, prefix }) => {
        const { getRequestHeaders } = await import('/script.js');
        const { user_avatar: pageAvatar } = await import('/scripts/personas.js');
        const send = async (path, body) => {
            const response = await fetch(`${prefix}${path}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
            return { status: response.status, json: await response.json().catch(() => null) };
        };
        const post = async (path, body) => {
            const answer = await send(path, body);
            if (answer.status !== 200) {
                throw new Error(`${path} answered ${answer.status}: ${JSON.stringify(answer.json)}`);
            }
            return answer.json;
        };

        const characters = [options.avatar, ...(options.members ?? [])];
        const personaId = options.personaId ?? pageAvatar;
        const chats = options.chats?.length ? options.chats : [{ messages: [] }];
        const sameConversation = conversation => conversation.personaId === personaId && JSON.stringify(conversation.characters) === JSON.stringify(characters);

        let conversation = (await post('/list', {})).conversations.find(sameConversation) ?? null;
        if (conversation && options.replace) {
            await post('/delete', { id: conversation.id });
            conversation = null;
        }
        if (!conversation) {
            conversation = (await post('/create', {
                kind: characters.length > 1 ? 'group' : 'direct',
                personaId,
                characters,
                ...(options.name ? { name: options.name } : {}),
            })).conversation;
        }
        const conversationId = conversation.id;

        const chatIds = [];
        for (const [index, chat] of chats.entries()) {
            const known = index === 0 ? conversation.chats[0] : conversation.chats.find(entry => entry.id === chat.id) ?? (chat.id ? null : conversation.chats[index]);
            if (known) {
                chatIds.push(known.id);
                if (chat.name && chat.name !== known.name) {
                    await post('/chat/rename', { id: conversationId, chatId: known.id, name: chat.name });
                }
            } else {
                const created = await post('/chat/create', { id: conversationId, ...(chat.id ? { chatId: chat.id } : {}), name: chat.name ?? `Chat ${index + 1}` });
                chatIds.push(created.chat.id);
            }
        }

        const base = Date.UTC(2026, 8, 30, 12, 0, 0);
        const readThrough = {};
        for (const [chatIndex, chat] of chats.entries()) {
            const records = (chat.messages ?? []).map((message, index) => {
                const role = message.role ?? 'character';
                const at = message.created_at ?? base + index * 60_000;
                return {
                    id: message.id ?? `seed-${chatIndex}-${index}`,
                    role,
                    name: message.name ?? (role === 'user' ? 'Tester' : 'Character'),
                    is_user: role === 'user',
                    is_system: role === 'system',
                    send_date: new Date(at).toISOString(),
                    created_at: at,
                    mes: message.mes,
                    extra: message.extra ?? {},
                };
            });
            // The header of the chat as it is stored holds the integrity slug that a save has to carry. Another worker that
            // seeds the same chat can save between the read and the write, which answers 409, so the pair is tried again.
            for (let attempt = 0; ; attempt++) {
                const stored = await post('/chat/get', { id: conversationId, chatId: chatIds[chatIndex] });
                const answer = await send('/chat/save', { id: conversationId, chatId: chatIds[chatIndex], allowShrink: true, chat: [stored.chat[0], ...records] });
                if (answer.status === 200) {
                    break;
                }
                if (answer.status !== 409 || attempt >= 5) {
                    throw new Error(`/chat/save answered ${answer.status}: ${JSON.stringify(answer.json)}`);
                }
            }
            if (records.length) {
                readThrough[chatIds[chatIndex]] = { readThrough: records.at(-1).id };
            }
        }
        const patch = { ...(Object.keys(readThrough).length ? { chats: readThrough } : {}), ...(options.activeChat !== undefined || chats.length > 1 ? { activeChatId: chatIds[options.activeChat ?? 0] } : {}) };
        if (Object.keys(patch).length) {
            await post('/update', { id: conversationId, patch });
        }

        const { conversationData } = await import('/scripts/sillybunny-conversation/conversation-data-browser.js');
        await conversationData.whenReady();
        await conversationData.refresh();
        return { conversationId, chatIds };
    }, { options, prefix: ROUTE_PREFIX });
}
