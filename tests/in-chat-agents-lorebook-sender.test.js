import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    isLorebookAgent,
    parseLorebookEntries,
    sendCompanionResultToLorebook,
} from '../public/scripts/extensions/in-chat-agents/companion/lorebook-sender.js';

function createContext({ attachedBook = '', existingTitles = [] } = {}) {
    const names = attachedBook ? [attachedBook] : [];
    const books = {};
    if (attachedBook) {
        books[attachedBook] = {
            entries: Object.fromEntries(existingTitles.map((comment, uid) => [uid, { uid, comment }])),
        };
    }

    const context = {
        chatMetadata: attachedBook ? { world_info: attachedBook } : {},
        getWorldInfoNames: jest.fn(() => [...names]),
        createNewWorldInfo: jest.fn(async name => {
            names.push(name);
            books[name] = { entries: {} };
            return true;
        }),
        updateChatMetadata: jest.fn(values => Object.assign(context.chatMetadata, values)),
        saveMetadata: jest.fn(async () => {}),
        loadWorldInfo: jest.fn(async name => books[name] ?? null),
        createWorldInfoEntry: jest.fn((_name, data) => {
            const uid = Object.keys(data.entries).length;
            const entry = { uid };
            data.entries[uid] = entry;
            return entry;
        }),
        saveWorldInfo: jest.fn(async () => {}),
    };

    return { books, context };
}

describe('Lorebook Scout sender', () => {
    let notifier;

    beforeEach(() => {
        notifier = {
            info: jest.fn(),
            success: jest.fn(),
            warning: jest.fn(),
            error: jest.fn(),
        };
    });

    test('recognises the opt-in tag case-insensitively', () => {
        expect(isLorebookAgent({ tags: ['notes', 'LoreBook'] })).toBe(true);
        expect(isLorebookAgent({ tags: ['notes', 'world info'] })).toBe(false);
    });

    test('parses multiple drafts, bold Keys labels, and title key fallbacks', () => {
        const entries = parseLorebookEntries([
            '**The Ember Gate**',
            '**Keys:** Ember Gate, ash gate, Cinder Road',
            'The Ember Gate seals the Cinder Road whenever its braziers go dark.',
            '',
            '**Moon Well:**',
            'The Moon Well reflects the sky of the next clear night.',
        ].join('\n'));

        expect(entries).toEqual([
            {
                title: 'The Ember Gate',
                keys: ['Ember Gate', 'ash gate', 'Cinder Road'],
                content: 'The Ember Gate seals the Cinder Road whenever its braziers go dark.',
            },
            {
                title: 'Moon Well',
                keys: ['Moon Well'],
                content: 'The Moon Well reflects the sky of the next clear night.',
            },
        ]);
        expect(parseLorebookEntries('Lorebook has nothing durable this turn.')).toEqual([]);
        expect(() => parseLorebookEntries('A plain paragraph without a title.')).toThrow('title');
        expect(() => parseLorebookEntries('**Gate**\nKeys: gate\nA gate.')).toThrow('2 to 5');
    });

    test('writes new entries once and skips normalized duplicate titles on repeat sends', async () => {
        const { books, context } = createContext({
            attachedBook: 'Campaign Lore',
            existingTitles: ['  the   ember gate  '],
        });
        const content = [
            '**The Ember Gate**',
            'Keys: Ember Gate, Cinder Road',
            'The Ember Gate seals the Cinder Road.',
            '',
            '**Moon Well**',
            'Keys: Moon Well, silver water',
            'The Moon Well reflects tomorrow night\'s sky.',
        ].join('\n');

        await expect(sendCompanionResultToLorebook(content, context, notifier)).resolves.toEqual({
            bookName: 'Campaign Lore',
            created: 1,
            duplicates: 1,
        });
        expect(books['Campaign Lore'].entries[1]).toEqual(expect.objectContaining({
            comment: 'Moon Well',
            key: ['Moon Well', 'silver water'],
            content: 'The Moon Well reflects tomorrow night\'s sky.',
            selective: false,
            constant: false,
            disable: false,
        }));
        expect(context.saveWorldInfo).toHaveBeenCalledWith('Campaign Lore', books['Campaign Lore'], true);

        await expect(sendCompanionResultToLorebook(content, context, notifier)).resolves.toEqual({
            bookName: 'Campaign Lore',
            created: 0,
            duplicates: 2,
        });
        expect(context.saveWorldInfo).toHaveBeenCalledTimes(1);
        expect(context.createNewWorldInfo).not.toHaveBeenCalled();
        expect(notifier.success).toHaveBeenCalledWith('Added 1 lorebook entry to "Campaign Lore". Skipped 1 duplicate.');
        expect(notifier.info).toHaveBeenCalledWith('No new entries added to "Campaign Lore"; 2 already exist.');
    });

    test('creates and attaches the fallback book when the chat has none', async () => {
        const { books, context } = createContext();

        await expect(sendCompanionResultToLorebook(
            '**Sun Dial**\nThe Sun Dial rings at noon when rain is coming.',
            context,
            notifier,
        )).resolves.toEqual({ bookName: 'Lorebook Scout', created: 1, duplicates: 0 });

        expect(context.createNewWorldInfo).toHaveBeenCalledWith('Lorebook Scout');
        expect(context.updateChatMetadata).toHaveBeenCalledWith({ world_info: 'Lorebook Scout' });
        expect(context.saveMetadata).toHaveBeenCalledTimes(1);
        expect(books['Lorebook Scout'].entries[0].key).toEqual(['Sun Dial']);
    });
});
