/* global globalThis */
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createDraft } from '../public/scripts/sillybunny-character-creator/model.js';

const userHandle = 'alice';
const records = new Map();
const database = {
    getItem: jest.fn(async key => records.has(key) ? structuredClone(records.get(key)) : null),
    setItem: jest.fn(async (key, value) => { records.set(key, structuredClone(value)); }),
    removeItem: jest.fn(async key => { records.delete(key); }),
};
const event_types = {
    APP_READY: 'app_ready',
    CHARACTER_EDITOR_OPENED: 'character_editor_opened',
    CHARACTER_EDITED: 'character_edited',
    CHAT_CHANGED: 'chat_id_changed',
    CHARACTER_RENAMED: 'character_renamed',
    CHARACTER_DELETED: 'characterDeleted',
};
const listeners = new Map();
const eventSource = {
    on: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    async emit(type, ...args) {
        for (const listener of listeners.get(type) ?? []) await listener(...args);
    },
};
const element = () => ({
    dataset: {}, setAttribute() {}, addEventListener() {}, append() {},
    replaceChildren() {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [],
});
const sheld = element();
const windowListeners = new Map();
globalThis.document = { createElement: element, getElementById: id => id === 'sheld' ? sheld : null };
globalThis.window = { addEventListener: (type, listener) => windowListeners.set(type, listener), dispatchEvent() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ name: 'Mara' }) });

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [],
    eventSource,
    event_types,
    flushCharacterSaveDebounced: async () => {},
    getCharacters: async () => {},
    getOneCharacter: async () => {},
    getRequestHeaders: () => ({}),
    isGenerating: () => false,
    select_selected_character: () => {},
}));
await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: () => ({ extensionSettings: {} }) }));
await jest.unstable_mockModule('../public/scripts/popup.js', () => ({ Popup: class {}, POPUP_TYPE: {}, POPUP_RESULT: {} }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/profile-utils.js', () => ({
    getConnectionManagerRequestService: () => null,
    listConnectionProfiles: () => [],
    populateConnectionProfileSelect: () => {},
}));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/llm-utils.js', () => ({ extractProfileResponseText: () => '' }));
await jest.unstable_mockModule('../public/lib.js', () => ({ localforage: { createInstance: () => database }, yaml: {} }));
await jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => userHandle }));
await import('../public/scripts/sillybunny-character-creator.js');

const keyFor = avatar => JSON.stringify([userHandle, avatar]);

function storeDraft(avatar) {
    records.set(keyFor(avatar), createDraft({ sourceAvatar: avatar, fields: { name: 'Mara' } }));
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** Opens the workspace for a card with a stored draft, as Polish in the editor does, and waits until it shows the draft. */
async function showStoredDraft(avatar) {
    storeDraft(avatar);
    windowListeners.get('sb:open-creator-workspace')({ detail: { avatar } });
    await settle();
    expect(sheld.dataset.sbCreatorMode).toBe('on');
}

describe('Creator controller card events', () => {
    beforeAll(() => eventSource.emit(event_types.APP_READY));
    beforeEach(() => records.clear());

    test('a rename moves the stored draft of a card that is not open in the workspace', async () => {
        storeDraft('old.png');
        await eventSource.emit(event_types.CHARACTER_RENAMED, 'old.png', 'new.png');
        expect(records.has(keyFor('old.png'))).toBe(false);
        expect(records.get(keyFor('new.png'))).toMatchObject({ sourceAvatar: 'new.png', working: { name: 'Mara' } });
    });

    test('a delete removes the stored draft of a card that is not open in the workspace', async () => {
        storeDraft('gone.png');
        storeDraft('kept.png');
        await eventSource.emit(event_types.CHARACTER_DELETED, { id: 0, character: { avatar: 'gone.png' } });
        expect([...records.keys()]).toEqual([keyFor('kept.png')]);
    });

    test('a delete event without a card avatar leaves every stored draft alone', async () => {
        storeDraft('kept.png');
        await eventSource.emit(event_types.CHARACTER_DELETED, { id: 0 });
        expect([...records.keys()]).toEqual([keyFor('kept.png')]);
    });

    test('a delete keeps the stored draft that the workspace shows', async () => {
        await showStoredDraft('shown.png');
        await eventSource.emit(event_types.CHARACTER_DELETED, { id: 0, character: { avatar: 'shown.png' } });
        expect([...records.keys()]).toEqual([keyFor('shown.png')]);
    });

    test('a delete keeps the stored draft that the workspace showed when the delete changed the chat', async () => {
        await showStoredDraft('shown.png');
        storeDraft('other.png');
        // A card delete closes the current chat first, and that chat change closes the workspace.
        await eventSource.emit(event_types.CHAT_CHANGED);
        await settle();
        expect(sheld.dataset.sbCreatorMode).toBeUndefined();

        await eventSource.emit(event_types.CHARACTER_DELETED, { id: 0, character: { avatar: 'shown.png' } });
        await eventSource.emit(event_types.CHARACTER_DELETED, { id: 1, character: { avatar: 'other.png' } });
        expect([...records.keys()]).toEqual([keyFor('shown.png')]);
    });

    test('a delete removes the stored draft that the workspace stopped showing at an earlier chat change', async () => {
        await showStoredDraft('shown.png');
        await eventSource.emit(event_types.CHAT_CHANGED);
        await settle();
        expect(sheld.dataset.sbCreatorMode).toBeUndefined();

        await eventSource.emit(event_types.CHAT_CHANGED);
        await eventSource.emit(event_types.CHARACTER_DELETED, { id: 0, character: { avatar: 'shown.png' } });
        expect(records.has(keyFor('shown.png'))).toBe(false);
    });
});
