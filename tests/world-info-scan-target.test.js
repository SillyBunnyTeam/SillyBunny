import { describe, expect, test } from '@jest/globals';

import { event_types } from '../public/scripts/events.js';
import { createHarness as createScanHarness } from './util/world-info-harness.js';

function entry(uid, fields) {
    return { uid, key: [], keysecondary: [], content: '', position: 0, order: 100, ...fields };
}

function createBooks() {
    return {
        'Aster Book': {
            entries: {
                1: entry(1, { key: ['moon'], content: 'Aster sees the moon with {{user}}.' }),
                2: entry(2, { constant: true, position: 1, order: 90, content: 'Aster constant for {{char}}.' }),
                3: entry(3, { key: ['{{user}}'], position: 4, depth: 2, role: 1, content: 'Keyed on the user name.' }),
                4: entry(4, { key: ['never said'], content: 'Forced by an extension.' }),
                5: entry(5, { key: ['moon'], sticky: 2, position: 1, order: 80, content: 'Sticky moon lore.' }),
            },
        },
        'Aster Extra': {
            entries: {
                1: entry(1, { key: ['tea'], position: 2, content: 'Tea before the note.' }),
                2: entry(2, { key: ['tea'], position: 3, content: 'Tea after the note.' }),
            },
        },
        'Shared Book': {
            entries: {
                1: entry(1, { constant: true, position: 5, content: 'Shared example.' }),
            },
        },
        'Global Book': {
            entries: {
                1: entry(1, { key: ['moon'], characterFilter: { names: ['bram'], tags: [], isExclude: false }, content: 'Only for Bram.' }),
                2: entry(2, { key: ['star'], content: 'Global star lore.' }),
                3: entry(3, { key: ['moon'], characterFilter: { names: [], tags: ['tag-bram'], isExclude: true }, content: 'Hidden from Bram by tag.' }),
                4: entry(4, { key: ['{{char}}'], position: 1, order: 50, content: 'Keyed on the character name.' }),
            },
        },
        'Chat Book': {
            entries: {
                1: entry(1, { key: ['moon'], position: 1, order: 70, content: 'Chat moon lore.' }),
            },
        },
        'Persona Book': {
            entries: {
                1: entry(1, { constant: true, order: 60, content: 'Roleplay persona lore.' }),
            },
        },
        'Bram Book': {
            entries: {
                1: entry(1, { constant: true, content: 'Bram constant for {{char}} and {{user}}.' }),
                2: entry(2, { key: ['moon'], position: 1, content: 'Bram sees the moon.' }),
            },
        },
        'Bram Override': {
            entries: {
                1: entry(1, { key: ['tea'], position: 1, order: 40, content: 'Override tea lore.' }),
            },
        },
        'Bram Persona': {
            entries: {
                1: entry(1, { constant: true, order: 30, content: 'Conversation persona lore.' }),
            },
        },
    };
}

const createHarness = ({ books = createBooks() } = {}) => createScanHarness({ books });

const CHAT = ['Aster: Good evening.', 'Roleplay User: We watched the moon and drank tea.'];

describe('World Info scan of the active chat', () => {
    test('keeps the Roleplay scan output, side effects and events', async () => {
        const context = createHarness();
        context.WorldInfoBuffer.externalActivations.set('Aster Book.4', { ...createBooks()['Aster Book'].entries[4], world: 'Aster Book' });

        const result = await context.checkWorldInfo([...CHAT].reverse(), 4000, false, context.defaultGlobalScanData);

        expect(result.worldInfoBefore).toBe([
            'Roleplay persona lore.',
            'Hidden from Bram by tag.',
            'Global star lore.',
            'Aster sees the moon with Roleplay User.',
            'Forced by an extension.',
        ].join('\n'));
        expect(result.worldInfoAfter).toBe([
            'Keyed on the character name.',
            'Chat moon lore.',
            'Sticky moon lore.',
            'Aster constant for Aster.',
        ].join('\n'));
        expect(result.EMEntries).toEqual([{ position: 0, content: 'Shared example.' }]);
        expect(result.WIDepthEntries).toEqual([{ depth: 2, entries: ['Keyed on the user name.'], role: 1 }]);
        expect(result.ANBeforeEntries).toEqual(['Tea before the note.']);
        expect(result.ANAfterEntries).toEqual(['Tea after the note.']);
        expect(context.setExtensionPrompt).toHaveBeenCalledWith('note', 'Tea before the note.\nRoleplay note mentions a star.\nTea after the note.', 1, 4, true, 0);
        expect(context.WorldInfoBuffer.externalActivations.size).toBe(0);
        expect(Object.keys(context.chat_metadata.timedWorldInfo.sticky)).toEqual(['Aster Book.5']);
        expect(context.eventSource.emit.mock.calls.map(([name]) => name)).toEqual([event_types.WORLDINFO_ENTRIES_LOADED, event_types.WORLDINFO_SCAN_DONE]);
        expect(context.loadWorldInfo.mock.calls.map(([name]) => name).sort()).toEqual(['Aster Book', 'Aster Extra', 'Chat Book', 'Global Book', 'Persona Book', 'Shared Book']);
    });

    test('scans entries keyed on the user name at their depth', async () => {
        const context = createHarness();

        const result = await context.checkWorldInfo(['Aster: Hello, Roleplay User.'], 4000, true, context.defaultGlobalScanData);

        expect(result.WIDepthEntries).toEqual([{ depth: 2, entries: ['Keyed on the user name.'], role: 1 }]);
        expect(context.chat_metadata.timedWorldInfo).toEqual({ sticky: {}, cooldown: {} });
    });
});

const BRAM_TARGET = Object.freeze({ characterId: 1, chatWorld: 'Bram Override', personaWorld: 'Bram Persona', userName: 'Conversation User' });

describe('World Info scan of a scan target', () => {
    test('reads the target character, global, override and persona books with the target names', async () => {
        const context = createHarness();

        const result = await context.checkWorldInfo(['Conversation User: The moon over tea, Bram.'], 4000, true, context.defaultGlobalScanData, BRAM_TARGET);

        expect(context.loadWorldInfo.mock.calls.map(([name]) => name).sort()).toEqual(['Bram Book', 'Bram Override', 'Bram Persona', 'Global Book', 'Shared Book']);
        expect(result.worldInfoBefore.split('\n')).toEqual(['Conversation persona lore.', 'Only for Bram.', 'Bram constant for Bram and Conversation User.']);
        expect(result.worldInfoAfter.split('\n')).toEqual(['Override tea lore.', 'Keyed on the character name.', 'Bram sees the moon.']);
        expect(result.EMEntries).toEqual([{ position: 0, content: 'Shared example.' }]);
        expect(result.ANBeforeEntries).toEqual([]);
        expect(context.getRegexedString).toHaveBeenCalledWith('Bram sees the moon.', 5, expect.objectContaining({ characterOverride: 'Bram' }));
    });

    test('leaves the active chat prompts, timed effects, forced activations and listeners alone', async () => {
        const books = createBooks();
        books['Bram Book'].entries[2].sticky = 3;
        const context = createHarness({ books });
        const forcedEntry = { ...books['Global Book'].entries[2], world: 'Global Book' };
        context.WorldInfoBuffer.externalActivations.set('Global Book.2', forcedEntry);
        context.chat_metadata.timedWorldInfo = { sticky: {}, cooldown: {} };

        const result = await context.checkWorldInfo(['Conversation User: The moon is out.'], 4000, false, context.defaultGlobalScanData, BRAM_TARGET);

        expect(result.worldInfoAfter).toContain('Bram sees the moon.');
        expect(result.worldInfoBefore).not.toContain('Global star lore.');
        expect(context.setExtensionPrompt).not.toHaveBeenCalled();
        expect(context.eventSource.emit).not.toHaveBeenCalled();
        expect([...context.WorldInfoBuffer.externalActivations.values()]).toEqual([forcedEntry]);
        expect(context.chat_metadata.timedWorldInfo).toEqual({ sticky: {}, cooldown: {} });
    });

    test('stops adding entries at the World Info budget', async () => {
        const context = createHarness({
            books: {
                'Bram Book': {
                    entries: {
                        1: entry(1, { constant: true, order: 30, content: 'Low priority lore.' }),
                        2: entry(2, { constant: true, order: 90, content: 'High priority lore.' }),
                    },
                },
            },
        });
        context.selected_world_info = [];

        // 25% of 20 tokens leaves 5 tokens, and the harness counts one token per word.
        const result = await context.checkWorldInfo([], 20, true, context.defaultGlobalScanData, { characterId: 1, userName: 'Conversation User' });

        expect(result.worldInfoBefore).toBe('High priority lore.');
    });

    test('returns no entries when the target has no books', async () => {
        const context = createHarness();
        context.characters.push({ name: 'Cora', avatar: 'cora.png', data: { extensions: {} } });
        context.selected_world_info = [];

        const result = await context.checkWorldInfo(['Conversation User: The moon and tea.'], 4000, true, context.defaultGlobalScanData, { characterId: 2, userName: 'Conversation User' });

        expect(result).toEqual({ worldInfoBefore: '', worldInfoAfter: '', WIDepthEntries: [], EMEntries: [], ANBeforeEntries: [], ANAfterEntries: [], outletEntries: {}, allActivatedEntries: new Set() });
        expect(context.loadWorldInfo).not.toHaveBeenCalled();
    });

    test('scans a linked book once when it is also the target override', async () => {
        const context = createHarness();
        context.selected_world_info = [];

        const result = await context.checkWorldInfo(['Conversation User: The moon.'], 4000, true, context.defaultGlobalScanData, { ...BRAM_TARGET, chatWorld: 'Bram Book', personaWorld: '' });

        expect(context.loadWorldInfo.mock.calls.map(([name]) => name)).toEqual(['Bram Book']);
        expect(result.worldInfoBefore).toBe('Bram constant for Bram and Conversation User.');
        expect(result.worldInfoAfter).toBe('Bram sees the moon.');
    });
});
