/* eslint-disable playwright/no-duplicate-hooks, playwright/no-standalone-expect */
/* global globalThis */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

let mockSettings;

await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
    isPathfinderSubmoduleEnabled: jest.fn(() => true),
}));

await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: () => null }));

const { getSettings, replaceSettings, setBookPermission, getBookPermission, isLorebookEnabled, canReadBook, canWriteBook, canDeleteBook } = await import('../public/scripts/extensions/in-chat-agents/pathfinder/tree-store.js');

const {
    getActiveTunnelVisionBooks,
    getContextualLorebookDetails,
    getAllEntriesWithContent,
    getEntryContent,
    getReadableBooks,
    getWritableBooks,
    getDeletableBooks,
} = await import('../public/scripts/extensions/in-chat-agents/pathfinder/pathfinder-tool-bridge.js');

describe('Pathfinder lorebook source selection', () => {
    beforeEach(() => {
        replaceSettings({
            enabledLorebooks: ['Manual Book'],
            includeContextualLorebooks: true,
        });
        mockSettings = getSettings();
        globalThis.window = {
            SillyTavern: {
                getContext: () => ({
                    chatMetadata: { world_info: 'Chat Book' },
                    powerUserSettings: { persona_description_lorebook: 'Persona Book' },
                    worldInfoSettings: {
                        charLore: [{ name: 'hero', extraBooks: ['Extra Book', 'Manual Book'] }],
                    },
                    characters: [{ avatar: 'hero.png', data: { extensions: { world: 'Primary Book' } } }],
                    characterId: 0,
                    groupId: null,
                    groups: [],
                }),
            },
        };
    });

    afterEach(() => {
        delete globalThis.window;
    });

    test('merges manual, chat, character, and persona lorebooks by default', () => {
        expect(getActiveTunnelVisionBooks()).toEqual([
            'Manual Book',
            'Chat Book',
            'Persona Book',
            'Primary Book',
            'Extra Book',
        ]);
    });

    test('can preserve manual-only behavior when contextual lorebooks are disabled', () => {
        mockSettings.includeContextualLorebooks = false;

        expect(getActiveTunnelVisionBooks()).toEqual(['Manual Book']);
    });

    test('reads a settings copy without changing live selections or independent permissions', () => {
        const live = structuredClone(mockSettings);
        const copy = {
            enabledLorebooks: ['Draft Book', 'Manual Book'],
            includeContextualLorebooks: false,
            autoUseAttachedLorebook: true,
            bookPermissions: {
                'Manual Book': { enabled: false, read: true, write: true, delete: true },
                'Chat Book': { enabled: false },
                'Draft Book': { read: 'none', write: true, delete: 0 },
                'Persona Book': { read: true, write: 'off', delete: 'readwrite' },
            },
        };
        const before = structuredClone(copy);
        expect(getActiveTunnelVisionBooks(copy)).toEqual(['Draft Book', 'Persona Book', 'Primary Book', 'Extra Book']);
        expect(getReadableBooks(copy)).toEqual(['Persona Book', 'Primary Book', 'Extra Book']);
        expect(getWritableBooks(copy)).toEqual(['Draft Book', 'Primary Book', 'Extra Book']);
        expect(getDeletableBooks(copy)).toEqual(['Persona Book', 'Primary Book', 'Extra Book']);
        expect(isLorebookEnabled('Manual Book', copy)).toBe(false);
        expect(getBookPermission('Manual Book', 'write', copy)).toBe(true);
        for (const check of [canReadBook, canWriteBook, canDeleteBook]) {
            expect(check('Manual Book', copy)).toBe(false);
            expect(check('Manual Book')).toBe(true);
        }
        expect(getSettings()).toEqual(live);
        expect(copy).toEqual(before);
    });

    test('explicit exclusions block contextual inclusion and direct content reads', async () => {
        setBookPermission('Chat Book', 'enabled', false);
        const load = jest.fn();
        const context = globalThis.window.SillyTavern.getContext();
        globalThis.window.SillyTavern.getContext = () => ({ ...context, loadWorldInfo: load });
        expect(getActiveTunnelVisionBooks()).not.toContain('Chat Book');
        expect(await getEntryContent('Chat Book', 0)).toBeNull();
        expect(await getAllEntriesWithContent('Chat Book')).toEqual([]);
        expect(load).not.toHaveBeenCalled();
    });

    test.each([
        [undefined, true], [null, true], ['readwrite', true], [true, true], [1, true],
        [false, false], [0, false], ['none', false], [' FALSE ', false], ['off', false],
        ['deny', false], ['denied', false], ['no', false], ['0', false], ['disabled', false],
    ])('preserves legacy permission value %p as %p', (value, allowed) => {
        const copy = { bookPermissions: { Book: { read: value, write: value, delete: value } } };
        expect(canReadBook('Book', copy)).toBe(allowed);
        expect(canWriteBook('Book', copy)).toBe(allowed);
        expect(canDeleteBook('Book', copy)).toBe(allowed);
    });

    test('includes group member lorebooks, chat metadata aliases, and embedded card book names', () => {
        globalThis.window.SillyTavern.getContext = () => ({
            chat_metadata: { world_info: 'Group Chat Book' },
            powerUserSettings: { persona_description_lorebook: 'Persona Book' },
            worldInfoSettings: {
                charLore: [
                    { name: 'hero', extraBooks: ['Hero Extra'] },
                    { name: 'mage', extraBooks: ['Mage Extra'] },
                ],
            },
            characters: [
                { avatar: 'hero.png', data: { extensions: { world: 'Hero Primary' } } },
                { avatar: 'mage.png', data: { character_book: { name: 'Mage Card Book' } } },
            ],
            characterId: 0,
            groupId: 'party',
            groups: [{ id: 'party', members: ['hero.png', 'mage.png'] }],
        });

        expect(getActiveTunnelVisionBooks()).toEqual([
            'Manual Book',
            'Group Chat Book',
            'Persona Book',
            'Hero Primary',
            'Hero Extra',
            'Mage Card Book',
            'Mage Extra',
        ]);
        expect(getContextualLorebookDetails()).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Hero Primary', types: ['group'] }),
            expect.objectContaining({ name: 'Mage Card Book', types: ['group'] }),
        ]));
    });

    test('single and bulk reads both recheck disabled and agent-blacklisted entries', async () => {
        const load = jest.fn(async () => ({ entries: {
            0: { uid: 0, comment: 'Visible', content: 'allowed' },
            1: { uid: 1, comment: 'Disabled secret', content: 'hidden', disable: true },
            2: { uid: 2, comment: 'Blacklisted secret', content: 'private', agentBlacklisted: true },
        } }));
        globalThis.window.SillyTavern.getContext = () => ({ loadWorldInfo: load });
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect((await getAllEntriesWithContent('Manual Book')).map(entry => entry.uid)).toEqual([0]);
            expect(await getEntryContent('Manual Book', 0)).toMatchObject({ content: 'allowed' });
            expect(await getEntryContent('Manual Book', 1)).toBeNull();
            expect(await getEntryContent('Manual Book', 2)).toBeNull();
            setBookPermission('Manual Book', 'read', false);
            load.mockClear();
            expect(await getAllEntriesWithContent('Manual Book')).toEqual([]);
            expect(await getEntryContent('Manual Book', 0)).toBeNull();
            expect(load).not.toHaveBeenCalled();
        } finally {
            warning.mockRestore();
        }
    });
});
