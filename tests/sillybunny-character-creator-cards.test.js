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
const { createCreatorCard, saveCreatorChanges } = await import('../public/scripts/sillybunny-character-creator/cards.js');

globalThis.document = { getElementById: id => elements.get(id) ?? null };

function storeCard(avatar, fields) {
    const data = { name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', alternate_greetings: [], ...fields };
    const { alternate_greetings, ...scalars } = data;
    const card = { avatar, ...scalars, data: { ...data, alternate_greetings: [...alternate_greetings] } };
    cards.set(avatar, card);
    return card;
}

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
    create: jest.fn(form => {
        const avatar = `${form.get('ch_name')}.png`;
        const fields = Object.fromEntries(['description', 'personality', 'scenario', 'first_mes', 'mes_example'].map(field => [field, form.get(field)]));
        storeCard(avatar, { ...fields, name: form.get('ch_name'), alternate_greetings: form.getAll('alternate_greetings') });
        return new Response(avatar, { status: 200 });
    }),
};
const serveCard = server.get.getMockImplementation();
globalThis.fetch = jest.fn(async (url, { body }) => {
    if (url === '/api/characters/get') return server.get(JSON.parse(body));
    if (url === '/api/characters/merge-attributes') return server.merge(JSON.parse(body));
    if (url === '/api/characters/create') return server.create(body);
    throw new Error(`Unexpected request: ${url}`);
});

function seed(avatar, fields) {
    const card = storeCard(avatar, fields);
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

function requests(url) {
    return globalThis.fetch.mock.calls.filter(([requestUrl]) => requestUrl === url);
}

beforeEach(() => {
    cards.clear();
    characters.length = 0;
    elements.clear();
    jest.clearAllMocks();
});

describe('Creator card saves', () => {
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

    test('a save writes only the selected changed fields after the pending editor save', async () => {
        seed('mara.png', { name: 'Mara', description: 'Old', scenario: 'Old scenario' });
        const draft = polishDraft('mara.png');
        setDraftTarget(draft, 'description', 'New');
        setDraftTarget(draft, 'scenario', 'Unselected scenario');
        const result = await saveCreatorChanges(draft, ['description']);
        expect(script.flushCharacterSaveDebounced).toHaveBeenCalledTimes(1);
        expect(requests('/api/characters/merge-attributes').map(([, { body }]) => JSON.parse(body))).toEqual([
            { avatar: 'mara.png', description: 'New', data: { description: 'New' } },
        ]);
        expect(result).toMatchObject({ status: 'saved', savedFields: { description: 'New' }, conflicts: [] });
        expect(cards.get('mara.png').data).toMatchObject({ description: 'New', scenario: 'Old scenario' });
        expect(draft.baseline).toMatchObject({ description: 'New', scenario: 'Old scenario' });
        expect(draft.working.scenario).toBe('Unselected scenario');
    });

    test('a field changed elsewhere since the draft loaded blocks the write', async () => {
        seed('mara.png', { name: 'Mara', description: 'Old' });
        const draft = polishDraft('mara.png');
        setDraftTarget(draft, 'description', 'Draft text');
        cards.get('mara.png').data.description = 'Edited in the classic editor';
        const result = await saveCreatorChanges(draft, ['description']);
        expect(result).toMatchObject({
            status: 'conflict',
            conflicts: [{ field: 'description', baseline: 'Old', current: 'Edited in the classic editor', proposed: 'Draft text' }],
            savedFields: {},
        });
        expect(requests('/api/characters/merge-attributes')).toHaveLength(0);
        expect(draft.baseline.description).toBe('Old');
        expect(cards.get('mara.png').data.description).toBe('Edited in the classic editor');
    });

    test('a value that is already saved elsewhere is acknowledged without a write', async () => {
        seed('mara.png', { name: 'Mara', description: 'Old' });
        const draft = polishDraft('mara.png');
        setDraftTarget(draft, 'description', 'Same text');
        cards.get('mara.png').data.description = 'Same text';
        await expect(saveCreatorChanges(draft, ['description'])).resolves.toMatchObject({ status: 'unchanged', savedFields: { description: 'Same text' } });
        expect(requests('/api/characters/merge-attributes')).toHaveLength(0);
        expect(draft.baseline.description).toBe('Same text');
    });

    test('a failed write keeps the draft ready for another attempt', async () => {
        seed('mara.png', { name: 'Mara', description: 'Old' });
        const draft = polishDraft('mara.png');
        setDraftTarget(draft, 'description', 'New');
        server.merge.mockImplementationOnce(() => new Response('Disk full', { status: 500 }));
        await expect(saveCreatorChanges(draft, ['description'])).rejects.toThrow('Saving the character failed (500): Disk full');
        expect(draft.baseline.description).toBe('Old');
        expect(script.eventSource.emit).not.toHaveBeenCalled();
        await expect(saveCreatorChanges(draft, ['description'])).resolves.toMatchObject({ status: 'saved' });
        expect(cards.get('mara.png').data.description).toBe('New');
    });

    test('a committed write stays committed when the reload after it fails', async () => {
        seed('mara.png', { name: 'Mara', description: 'Old' });
        const draft = polishDraft('mara.png');
        setDraftTarget(draft, 'description', 'New');
        server.get.mockImplementationOnce(serveCard).mockImplementationOnce(() => new Response('Unavailable', { status: 503 }));
        const result = await saveCreatorChanges(draft, ['description']);
        expect(result.status).toBe('saved');
        expect(result.refreshError.message).toBe('Loading the character failed (503): Unavailable');
        expect(draft.baseline.description).toBe('New');
        await expect(saveCreatorChanges(draft, ['description'])).resolves.toMatchObject({ status: 'unchanged' });
        expect(requests('/api/characters/merge-attributes')).toHaveLength(1);
    });

    test('a card missing from the roster reports a refresh failure after the write', async () => {
        storeCard('mara.png', { name: 'Mara', description: 'Old' });
        const draft = polishDraft('mara.png');
        setDraftTarget(draft, 'description', 'New');
        const result = await saveCreatorChanges(draft, ['description']);
        expect(result.status).toBe('saved');
        expect(result.refreshError.message).toBe('The character was saved, but its roster entry could not be refreshed.');
        expect(cards.get('mara.png').data.description).toBe('New');
        expect(script.eventSource.emit).not.toHaveBeenCalled();
    });

    test('a running chat generation blocks the save before any request', async () => {
        seed('mara.png', { name: 'Mara', description: 'Old' });
        const draft = polishDraft('mara.png');
        setDraftTarget(draft, 'description', 'New');
        script.isGenerating.mockReturnValueOnce(true);
        await expect(saveCreatorChanges(draft, ['description'])).rejects.toThrow('Stop the active chat generation before saving a character.');
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(script.flushCharacterSaveDebounced).not.toHaveBeenCalled();
    });
});

describe('Creator card creation', () => {
    const fields = {
        name: 'Nova',
        description: 'A pilot.',
        personality: 'Calm',
        scenario: 'A dock.',
        first_mes: 'Hello.',
        mes_example: '<START>',
        alternate_greetings: ['Hi.', 'Welcome back.'],
    };

    test('a create posts the seven card fields and refreshes the roster without opening the editor', async () => {
        const result = await createCreatorCard(fields);
        const [[, { body }]] = requests('/api/characters/create');
        expect(Object.fromEntries(['ch_name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'].map(key => [key, body.get(key)]))).toEqual({
            ch_name: 'Nova', description: 'A pilot.', personality: 'Calm', scenario: 'A dock.', first_mes: 'Hello.', mes_example: '<START>',
        });
        expect(body.getAll('alternate_greetings')).toEqual(['Hi.', 'Welcome back.']);
        expect(result).toEqual({ avatar: 'Nova.png', fields, refreshError: null });
        expect(script.getCharacters).toHaveBeenCalledWith({ refreshEditor: false });
        expect(characters.map(character => character.avatar)).toEqual(['Nova.png']);
    });

    test('a create needs a name and sends nothing without one', async () => {
        await expect(createCreatorCard({ ...fields, name: '  ' })).rejects.toThrow('A character name is required.');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('a lost create request marks the outcome unknown', async () => {
        globalThis.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const error = await createCreatorCard(fields).catch(failure => failure);
        expect(error.creationOutcomeUnknown).toBe(true);
        expect(error.cause).toBeInstanceOf(TypeError);
    });

    test('an accepted create without an identity marks the outcome unknown', async () => {
        server.create.mockImplementationOnce(() => new Response('', { status: 200 }));
        const error = await createCreatorCard(fields).catch(failure => failure);
        expect(error.creationOutcomeUnknown).toBe(true);
    });

    test('a rejected create reports the server error and leaves the outcome known', async () => {
        server.create.mockImplementationOnce(() => new Response('Bad card', { status: 400 }));
        const error = await createCreatorCard(fields).catch(failure => failure);
        expect(error.message).toBe('Creating the character failed (400): Bad card');
        expect(error.creationOutcomeUnknown).toBeUndefined();
    });

    test('a created card that the roster does not list is still reported as created', async () => {
        script.getCharacters.mockImplementationOnce(async () => {});
        const result = await createCreatorCard(fields);
        expect(result.avatar).toBe('Nova.png');
        expect(result.refreshError.message).toBe('The character was created, but its roster entry could not be refreshed.');
    });
});
