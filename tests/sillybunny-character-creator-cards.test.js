/* global globalThis */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const characters = [];
const cards = new Map();
const elements = new Map();
const script = {
    characters,
    eventSource: { emit: jest.fn(async () => {}) },
    event_types: { CHARACTER_EDITED: 'character_edited' },
    flushCharacterSaveDebounced: jest.fn(async () => {}),
    getCharacters: jest.fn(async () => {
        characters.splice(0, characters.length, ...Array.from(cards.values(), card => structuredClone(card)));
    }),
    getOneCharacter: jest.fn(async avatar => {
        const index = characters.findIndex(character => character.avatar === avatar);
        if (index >= 0 && cards.has(avatar)) characters[index] = structuredClone(cards.get(avatar));
    }),
    getRequestHeaders: jest.fn(() => ({})),
    isGenerating: jest.fn(() => false),
    select_selected_character: jest.fn(),
};
await jest.unstable_mockModule('../public/script.js', () => script);
const { createDraft, setDraftTarget } = await import('../public/scripts/sillybunny-character-creator/model.js');
const { saveCreatorChanges } = await import('../public/scripts/sillybunny-character-creator/cards.js');

globalThis.document = { getElementById: id => elements.get(id) ?? null };

const server = {
    get: jest.fn(({ avatar_url }) => cards.has(avatar_url)
        ? Response.json(cards.get(avatar_url))
        : new Response('Not found', { status: 404 })),
    merge: jest.fn(({ avatar, data, ...topLevel }) => {
        const card = cards.get(avatar);
        Object.assign(card, topLevel);
        Object.assign(card.data, data);
        return new Response('', { status: 200 });
    }),
};
globalThis.fetch = jest.fn(async (url, { body }) => {
    if (url === '/api/characters/get') return server.get(JSON.parse(body));
    if (url === '/api/characters/merge-attributes') return server.merge(JSON.parse(body));
    throw new Error(`Unexpected request: ${url}`);
});

function seed(avatar, fields) {
    const data = { name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', alternate_greetings: [], ...fields };
    const { alternate_greetings, ...scalars } = data;
    const card = { avatar, ...scalars, data: { ...data, alternate_greetings: [...alternate_greetings] } };
    cards.set(avatar, card);
    characters.push(structuredClone(card));
    return card;
}

function showForm(actiontype, avatar) {
    elements.set('form_create', { getAttribute: name => name === 'actiontype' ? actiontype : null });
    elements.set('avatar_url_pole', { value: avatar });
}

function polishDraft(avatar) {
    return createDraft({ sourceAvatar: avatar, fields: cards.get(avatar) });
}

describe('Creator card saves', () => {
    beforeEach(() => {
        cards.clear();
        characters.length = 0;
        elements.clear();
        jest.clearAllMocks();
    });

    test('a save refreshes the editor that shows the saved card', async () => {
        seed('mara.png', { name: 'Mara', description: 'Old' });
        showForm('editcharacter', 'mara.png');
        const draft = polishDraft('mara.png');
        setDraftTarget(draft, 'description', 'New');
        await expect(saveCreatorChanges(draft, ['description'])).resolves.toMatchObject({ status: 'saved', refreshError: null });
        expect(script.select_selected_character).toHaveBeenCalledWith(0, { switchMenu: false });
        expect(script.eventSource.emit).toHaveBeenCalledWith('character_edited', { detail: { id: 0, character: characters[0] } });
    });

    test('a save leaves the create form alone when the form still holds the saved card avatar', async () => {
        seed('mara.png', { name: 'Mara', description: 'Old' });
        showForm('createcharacter', 'mara.png');
        const draft = polishDraft('mara.png');
        setDraftTarget(draft, 'description', 'New');
        await expect(saveCreatorChanges(draft, ['description'])).resolves.toMatchObject({ status: 'saved', refreshError: null });
        expect(script.select_selected_character).not.toHaveBeenCalled();
        expect(script.eventSource.emit).toHaveBeenCalledWith('character_edited', { detail: { id: 0, character: characters[0] } });
    });
});
