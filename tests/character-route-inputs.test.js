import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { createCardPng, createV2Card } from './util/card-corpus.js';
import { startCharacterRouter } from './util/character-router-harness.js';

// A request that a route never answers fails at this deadline instead of at the test timeout.
const REQUEST_TIMEOUT_MS = 3_000;
const CARD = createCardPng(createV2Card());
const CHAT = '{"user_name":"User","character_name":"Probe"}\n';
// JSON gives an object whose own toString is not a function, and converting that object to a string throws.
const UNCONVERTIBLE = { toString: 1 };

describe('character routes and request fields of an unexpected type', () => {
    let harness;

    const cardPath = (fileName = 'Probe.png') => path.join(harness.directories.characters, fileName);
    const chatsFolder = () => path.join(harness.directories.chats, 'Probe');
    const cardIsUnchanged = () => fs.readFileSync(cardPath()).equals(CARD);
    const post = (route, body) => harness.postJson(`/api/characters/${route}`, body);
    const editBody = fields => ({ avatar_url: 'Probe.png', ch_name: 'Probe', allow_empty_definition_save: 'true', ...fields });
    const readDescription = async () => (await post('get', { avatar_url: 'Probe.png' })).body.description;

    beforeAll(async () => {
        harness = await startCharacterRouter('sillybunny-character-route-inputs-', { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    });

    beforeEach(() => {
        harness.reset();
        for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
        fs.writeFileSync(cardPath(), CARD);
        fs.mkdirSync(chatsFolder());
        fs.writeFileSync(path.join(chatsFolder(), 'first.jsonl'), CHAT);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        harness.remove();
    });

    afterAll(async () => {
        await harness.close();
    });

    test.each([
        ['a number', 5],
        ['a list', ['Renamed']],
        ['an object that cannot become a string', UNCONVERTIBLE],
    ])('POST /rename refuses a new_name that is %s, and still renames the card to a string name', async (_label, newName) => {
        expect((await post('rename', { avatar_url: 'Probe.png', new_name: newName })).status).toBe(400);
        expect(cardIsUnchanged()).toBe(true);

        expect(await post('rename', { avatar_url: 'Probe.png', new_name: 'Renamed' })).toEqual({ status: 200, body: { avatar: 'Renamed.png' } });
        expect(fs.existsSync(cardPath('Renamed.png'))).toBe(true);
    });

    test.each([
        ['a number', 5],
        ['a list', ['Probe.png']],
        ['an object that cannot become a string', UNCONVERTIBLE],
    ])('POST /rename refuses an avatar_url that is %s, and leaves the card as it was', async (_label, avatarUrl) => {
        expect((await post('rename', { avatar_url: avatarUrl, new_name: 'Renamed' })).status).toBe(400);
        expect(cardIsUnchanged()).toBe(true);
        expect(fs.existsSync(cardPath('Renamed.png'))).toBe(false);
    });

    test.each([
        ['missing', undefined],
        ['a number', 5],
    ])('POST /edit refuses an avatar_url that is %s, and still edits the card that a string avatar_url names', async (_label, avatarUrl) => {
        expect((await post('edit', editBody({ avatar_url: avatarUrl, description: 'Edited.' }))).status).toBe(400);
        expect(cardIsUnchanged()).toBe(true);

        expect((await post('edit', editBody({ description: 'Edited.' }))).status).toBe(200);
        expect(await readDescription()).toBe('Edited.');
    });

    test.each(['5', 'true', '"text"'])('POST /edit refuses a json_data of %s, which is JSON but not an object, and leaves the card as it was', async (jsonData) => {
        expect((await post('edit', editBody({ json_data: jsonData, description: 'Edited.' }))).status).toBe(400);
        expect(cardIsUnchanged()).toBe(true);
    });

    test.each(['ch_name', 'fav', 'depth_prompt_depth', 'world', 'extensions'])('POST /edit refuses a body whose %s field cannot become a string, and leaves the card as it was', async (field) => {
        expect((await post('edit', editBody({ [field]: UNCONVERTIBLE, description: 'Edited.' }))).status).toBe(400);
        expect(cardIsUnchanged()).toBe(true);
    });

    test('POST /delete refuses a delete_chats that cannot become a string, and keeps the card and its chats', async () => {
        expect((await post('delete', { avatar_url: 'Probe.png', delete_chats: UNCONVERTIBLE })).status).toBe(400);
        expect(cardIsUnchanged()).toBe(true);
        expect(fs.readdirSync(chatsFolder())).toEqual(['first.jsonl']);

        expect((await post('delete', { avatar_url: 'Probe.png', delete_chats: true })).status).toBe(200);
        expect(fs.existsSync(cardPath())).toBe(false);
        expect(fs.existsSync(chatsFolder())).toBe(false);
    });

    test('POST /delete deletes the card and answers 200 when the card\'s thumbnail cannot be removed', async () => {
        fs.mkdirSync(path.join(harness.directories.thumbnailsAvatar, 'Probe.png'));

        expect((await post('delete', { avatar_url: 'Probe.png' })).status).toBe(200);
        expect(fs.existsSync(cardPath())).toBe(false);
    });

    test('POST /import answers 500 and leaves the card as it was when the card it replaces has a damaged write-recovery record, and replaces the card once the record is gone', async () => {
        const recordPath = `${cardPath()}.sillybunny-write-recovery`;
        fs.writeFileSync(recordPath, 'not json');
        const replacementCard = createV2Card();
        replacementCard.data.description = 'Replaced.';
        const replacement = createCardPng(replacementCard);

        expect((await harness.importCard(replacement, 'png', { preserved_name: 'Probe.png' })).status).toBe(500);
        expect(cardIsUnchanged()).toBe(true);
        expect(fs.readFileSync(recordPath, 'utf8')).toBe('not json');

        fs.rmSync(recordPath);
        expect(await harness.importCard(replacement, 'png', { preserved_name: 'Probe.png' })).toEqual({ status: 200, body: { file_name: 'Probe' } });
        expect(await readDescription()).toBe('Replaced.');
    });
});
