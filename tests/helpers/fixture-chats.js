import { gunzipSync } from 'node:zlib';
import { stubGettingStarted } from './getting-started-state.js';

/**
 * Chats that exist only in the browser, so a spec that opens a character's chat does not depend on what the
 * server has saved. Call `installFixtureChats` after `protectMaintainerServer`: a request for a chat that is
 * not a fixture falls through to the routes below it. It also gives the account a shown Getting Started checklist.
 */

const FIXTURE_EPOCH = Date.UTC(2026, 0, 1);
const chatsByPage = new WeakMap();

/** @typedef {{ avatar: string, name: string, chat: string }} FixtureChat */

function readPayload(request) {
    const buffer = request.postDataBuffer();
    if (!buffer) {
        return {};
    }
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(buffer) : buffer).toString());
}

function fixtureChatsOf(page, avatar) {
    return (chatsByPage.get(page) ?? []).filter(fixture => fixture.avatar === avatar);
}

function describeChatFile({ chat, name }, index) {
    const savedAt = FIXTURE_EPOCH - index * 60_000;
    return {
        file_name: `${chat}.jsonl`,
        file_id: chat,
        file_size: '1kb',
        chat_items: 1,
        mes: `Fixture message from ${name}`,
        last_mes: savedAt,
    };
}

function buildChatRecords({ name }) {
    return [
        { chat_metadata: {}, user_name: 'User', character_name: name, create_date: '2026-01-01@00h00m00s000ms' },
        { name, is_user: false, is_system: false, send_date: FIXTURE_EPOCH, mes: `Fixture message from ${name}`, extra: {} },
    ];
}

/**
 * Makes the page answer for the chats that `pickFixtureCharacters` and `registerFixtureChat` hand out: the chat
 * file, the list of a character's chat files that the app reads before it opens one, and the note of the last
 * opened chat, which would otherwise be written next to the character on the server.
 * @param {import('@playwright/test').Page} page
 * @param {{ bundledCardsOnly?: boolean }} [options] `bundledCardsOnly` limits the library to the cards that ship with
 *   SillyBunny, for a spec that asserts a count of finished Getting Started steps (see `stubGettingStarted`).
 */
export async function installFixtureChats(page, { bundledCardsOnly = false } = {}) {
    if (chatsByPage.has(page)) {
        return;
    }
    chatsByPage.set(page, []);

    await page.route(/\/api\/chats\/get$/, async (route) => {
        const { avatar_url: avatar, file_name: chat } = readPayload(route.request());
        const fixture = fixtureChatsOf(page, avatar).find(candidate => candidate.chat === chat);
        return fixture ? route.fulfill({ json: buildChatRecords(fixture) }) : route.fallback();
    });
    await page.route(/\/api\/characters\/chats$/, async (route) => {
        const fixtures = fixtureChatsOf(page, readPayload(route.request()).avatar_url);
        return fixtures.length ? route.fulfill({ json: fixtures.map(describeChatFile) }) : route.fallback();
    });
    await page.route('**/api/characters/last-chat', route => route.fulfill({ json: {} }));
    // The account of a spec has no stored checklist, so it would count as an old account whose checklist is hidden.
    await stubGettingStarted(page, { bundledCardsOnly });
}

/**
 * A chat that the app named itself, such as the one it opened for a character, becomes a fixture so that a later
 * request to open it again finds it.
 * @param {import('@playwright/test').Page} page
 * @param {FixtureChat} fixture
 */
export function registerFixtureChat(page, fixture) {
    const fixtures = chatsByPage.get(page);
    if (!fixtures) {
        throw new Error('installFixtureChats must run before registerFixtureChat.');
    }
    if (!fixtures.some(known => known.avatar === fixture.avatar && known.chat === fixture.chat)) {
        fixtures.push(fixture);
    }
}

/**
 * Picks characters that have an avatar, whatever the server saved for them, and gives each a synthetic chat
 * file. With fewer characters than asked for, the characters repeat with chats of their own.
 * @param {import('@playwright/test').Page} page
 * @param {number} count
 * @returns {Promise<FixtureChat[]>}
 */
export async function pickFixtureCharacters(page, count) {
    const characters = await page.evaluate(() => window.SillyTavern.getContext().characters
        .filter(character => character?.avatar && character.name)
        .map(character => ({ avatar: character.avatar, name: character.name })));
    if (characters.length === 0) {
        throw new Error('The server has no character with an avatar to build a fixture chat on.');
    }

    return Array.from({ length: count }, (_, index) => {
        const fixture = { ...characters[index % characters.length], chat: `qa-fixture-${index + 1}` };
        registerFixtureChat(page, fixture);
        return fixture;
    });
}
