/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const modeObject = { version: 2, localStorageMigrated: false, settings: {} };
const importLegacy = jest.fn();
const reloadPageOnce = jest.fn();
let storage;

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    clearLegacyConversationUnreadStorage: () => {
        const unread = [...storage.keys()].filter(key => key.startsWith('sb_conv_unread_'));
        unread.forEach(key => storage.delete(key));
        return unread.length;
    },
    getConversationPersonaId: () => 'persona-a.png',
    getConversationStore: () => modeObject,
    parsePositiveInt: (value, fallback, min = 1) => {
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
    },
    safeParseSettings: stored => ({ ...(typeof stored === 'string' ? JSON.parse(stored) : stored), parsed: true }),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
    conversationData: { importLegacy },
    reloadPageOnce,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/schedule.js', () => ({ getScheduleStorageKey: avatar => `sb_conv_schedule_${avatar}` }));

const { buildLegacyThread, importLegacyLocalStorage } = await import('../public/scripts/sillybunny-conversation/legacy-import.js');

const message = { id: 'm1', role: 'character', name: 'Nova', mes: 'old words', created_at: 5, send_date: new Date(5).toISOString(), extra: {} };

beforeEach(() => {
    storage = new Map();
    globalThis.localStorage = {
        get length() {
            return storage.size;
        },
        key: index => [...storage.keys()][index] ?? null,
        getItem: key => storage.get(key) ?? null,
        removeItem: key => storage.delete(key),
    };
    Object.assign(modeObject, { localStorageMigrated: false });
    importLegacy.mockReset();
    reloadPageOnce.mockReset();
});

afterEach(() => {
    delete globalThis.localStorage;
});

describe('buildLegacyThread', () => {
    test('puts what localStorage held for one character into a thread of the old store, with the 250-message cap gone', () => {
        const many = Array.from({ length: 300 }, (_, index) => ({ ...message, id: `m${index}`, created_at: 10 + index }));
        storage.set('sb_conv_thread_nova.png', JSON.stringify(many));
        storage.set('sb_conv_settings_nova.png', JSON.stringify({ availability: 'dnd' }));
        storage.set('sb_conv_unread_nova.png', '3');
        storage.set('sb_conv_last_user_activity_nova.png', '777');
        storage.set('sb_conv_followup_count_nova.png', '2');
        storage.set('sb_conv_last_auto_msg_nova.png', '555');
        storage.set('sb_conv_last_trigger_nova.png', '{"slot":1}');
        storage.set('sb_conv_schedule_nova.png', '{"days":{}}');
        storage.set('sb_conv_last_preview_nova.png', 'old preview');

        const thread = buildLegacyThread('nova.png');

        expect(thread).toMatchObject({ activeBranchId: 'main', schedule: { days: {} }, settings: { availability: 'dnd', parsed: true } });
        expect(thread.branches.main).toMatchObject({
            id: 'main',
            name: 'Main',
            preview: 'old preview',
            unread: 3,
            lastActivity: 777,
            followupCount: 2,
            lastAutoMessageAt: 555,
            scheduleTriggers: { slot: 1 },
        });
        expect(thread.branches.main.messages).toHaveLength(300);
    });

    test('is empty but valid for a character that has only some of the keys', () => {
        storage.set('sb_conv_thread_nova.png', '{not json');

        const thread = buildLegacyThread('nova.png');

        expect(thread.branches.main.messages).toEqual([]);
        expect(thread.schedule).toBeNull();
        expect(thread.branches.main).toMatchObject({ unread: 0, followupCount: 0, preview: 'Conversation ready' });
    });
});

describe('importLegacyLocalStorage', () => {
    test('sends nothing when localStorage holds none of the old keys', async () => {
        storage.set('theme', 'dark');

        expect(await importLegacyLocalStorage()).toBe('none');
        expect(importLegacy).not.toHaveBeenCalled();
    });

    test('sends the threads of every character that has an old key, once, with the persona', async () => {
        storage.set('sb_conv_thread_nova.png', JSON.stringify([message]));
        storage.set('sb_conv_settings_orion.png', JSON.stringify({}));
        storage.set('sb_conv_unrelated', 'x');
        importLegacy.mockResolvedValue({ state: 'imported', conversations: 2, chats: 2, messages: 1 });

        expect(await importLegacyLocalStorage()).toBe('imported');

        expect(importLegacy).toHaveBeenCalledTimes(1);
        const [payload] = importLegacy.mock.calls[0];
        expect(payload.personaId).toBe('persona-a.png');
        expect(Object.keys(payload.characters).sort()).toEqual(['nova.png', 'orion.png']);
        expect(payload.characters['nova.png'].branches.main.messages[0].id).toBe('m1');
    });

    test('reloads the page once after an import, because the server changed the settings, and keeps the old keys as a copy', async () => {
        storage.set('sb_conv_thread_nova.png', JSON.stringify([message]));
        storage.set('sb_conv_unread_nova.png', '1');
        importLegacy.mockResolvedValue({ state: 'imported' });

        await importLegacyLocalStorage();

        expect(reloadPageOnce).toHaveBeenCalledWith('sb_conversation_reloaded_after_import');
        expect(storage.has('sb_conv_thread_nova.png')).toBe(true);
        expect(storage.has('sb_conv_unread_nova.png')).toBe(false);
        expect(modeObject.localStorageMigrated).toBe(true);
    });

    test('does not reload when the server had imported it before, and still marks it done', async () => {
        storage.set('sb_conv_thread_nova.png', JSON.stringify([message]));
        importLegacy.mockResolvedValue({ state: 'already_imported' });

        expect(await importLegacyLocalStorage()).toBe('already_imported');

        expect(reloadPageOnce).not.toHaveBeenCalled();
        expect(modeObject.localStorageMigrated).toBe(true);
    });

    test('sends nothing once the settings say that the data was moved, and only clears the unread counts', async () => {
        modeObject.localStorageMigrated = true;
        storage.set('sb_conv_thread_nova.png', JSON.stringify([message]));
        storage.set('sb_conv_unread_nova.png', '2');

        expect(await importLegacyLocalStorage()).toBe('none');

        expect(importLegacy).not.toHaveBeenCalled();
        expect(storage.has('sb_conv_unread_nova.png')).toBe(false);
    });
});
