/* global globalThis */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    collectEntitySearchEntries,
    getWorldInfoEntrySearchText,
    primeWorldInfoSearchCache,
    resetSearchContextAccessor,
    setSearchContextAccessor,
} from '../public/scripts/sillybunny-search-entities.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entityModuleUrl = pathToFileURL(path.join(repoRoot, 'public/scripts/sillybunny-search-entities.js')).href;
const restoreGlobals = [];

function replaceGlobal(name, value) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restoreGlobals.push(() => {
        if (original) {
            Object.defineProperty(globalThis, name, original);
        } else {
            delete globalThis[name];
        }
    });
}

afterEach(() => {
    resetSearchContextAccessor();
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const restore of restoreGlobals.splice(0).reverse()) restore();
});

describe('universal search entity entries', () => {
    test('matches characters by name and card metadata with stable namespaced keys', () => {
        const context = {
            characters: [{
                name: 'Alice',
                avatar: 'Alice.png',
                data: {
                    creator: 'TLD',
                    tags: ['detective', 'mystery'],
                    creator_notes: 'A careful investigator',
                },
            }],
            groups: [],
            getWorldInfoNames: () => [],
        };
        setSearchContextAccessor(() => context);

        const byName = collectEntitySearchEntries('alice');
        const byTag = collectEntitySearchEntries('detective');

        expect(byName).toHaveLength(1);
        expect(byTag).toHaveLength(1);
        expect(byName[0]).toMatchObject({
            element: null,
            displayText: 'Alice',
            headingMatch: true,
            tabId: 'characters',
            tabLabel: 'Characters',
        });
        expect(byName[0].searchText).toContain('alice');
        expect(byName[0].searchText).toContain('tld');
        expect(byName[0].dedupeKey).toBe('charentity::Alice.png');
        expect(byName[0].dedupeKey).toBe(byTag[0].dedupeKey);
        expect(collectEntitySearchEntries('  ALICE\n mystery  ')).toHaveLength(1);
        expect(collectEntitySearchEntries('alice nonexistent')).toEqual([]);
    });

    test('matches groups by group name and member name', () => {
        const context = {
            characters: [
                { name: 'Alice', avatar: 'card-42.png' },
                { name: 'Bob', avatar: 'card-73.png' },
            ],
            groups: [{
                id: 'mystery-group',
                name: 'The Investigators',
                members: ['card-42.png', 'card-73.png'],
                disabled_members: ['card-73.png'],
                chats: ['main'],
                chat_id: 'main',
            }],
            getWorldInfoNames: () => [],
        };
        setSearchContextAccessor(() => context);

        const byGroup = collectEntitySearchEntries('investigators');
        const byMember = collectEntitySearchEntries('alice');
        const byDisabledHint = collectEntitySearchEntries('disabled members');

        expect(byGroup).toHaveLength(1);
        expect(byMember.some(entry => entry.dedupeKey === 'grpentity::mystery-group')).toBe(true);
        expect(byDisabledHint).toHaveLength(1);
        expect(byGroup[0]).toMatchObject({
            displayText: 'The Investigators',
            dedupeKey: 'grpentity::mystery-group',
            headingMatch: true,
            tabId: 'groups',
            tabLabel: 'Groups',
        });
    });

    test('makes world names searchable through world-info aliases', () => {
        const context = {
            characters: [],
            groups: [],
            getWorldInfoNames: () => ['The Veiled City'],
        };
        setSearchContextAccessor(() => context);

        expect(collectEntitySearchEntries('lorebook')).toHaveLength(1);
        expect(collectEntitySearchEntries('world info')).toHaveLength(1);
        expect(collectEntitySearchEntries('world info book')[0]).toMatchObject({
            displayText: 'The Veiled City',
            dedupeKey: 'wibook::The Veiled City',
            tabId: 'world-info',
            headingMatch: true,
        });
    });

    test('returns no entries for an empty query', () => {
        const getContext = jest.fn(() => ({ characters: [] }));
        setSearchContextAccessor(getContext);

        expect(collectEntitySearchEntries('   ')).toEqual([]);
        expect(getContext).not.toHaveBeenCalled();
    });

    test('supports synchronous character accessors without refreshing the server', () => {
        const card = { name: 'The Archivist', avatar: 'record-09.png', data: { tags: ['history'] } };
        const getCharacters = jest.fn(() => [card]);
        setSearchContextAccessor(() => ({ getCharacters }));

        expect(collectEntitySearchEntries('archivist history')).toHaveLength(1);
        expect(getCharacters).toHaveBeenCalledTimes(1);

        setSearchContextAccessor(() => ({ get characters() { return [card]; } }));
        expect(collectEntitySearchEntries('archivist')).toHaveLength(1);

        const refresh = jest.fn();
        setSearchContextAccessor(() => ({ getCharacters: async () => refresh() }));
        expect(collectEntitySearchEntries('archivist')).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();
    });

    test('excludes group pseudo-characters and bounds entity scans', () => {
        setSearchContextAccessor(() => ({
            characters: [
                { name: 'Shared Name', avatar: 'group.png', is_group: true },
                { name: 'Shared Name', avatar: 'group-only.png', type: 'group', members: [] },
                { name: 'Shared Name', avatar: 'real-card.png' },
                { name: 'Shared Name', avatar: 'other-card.png' },
            ],
        }));

        expect(collectEntitySearchEntries('shared name').map(entry => entry.dedupeKey)).toEqual([
            'charentity::real-card.png',
            'charentity::other-card.png',
        ]);
        expect(collectEntitySearchEntries('shared name', { limit: 3 })).toHaveLength(1);
        expect(collectEntitySearchEntries('shared name', { limit: 0 })).toEqual([]);
    });

    test('opens the matching group chat or falls back to the groups page', async () => {
        const group = { id: 'group-action', name: 'Investigation Team', chat_id: 'case-one', members: [] };
        const openGroupChat = jest.fn().mockResolvedValue();
        const openTab = jest.fn();
        replaceGlobal('SillyBunnyShell', { openTab });
        setSearchContextAccessor(() => ({ groups: [group], openGroupChat }));

        await collectEntitySearchEntries('investigation')[0].action();

        expect(openGroupChat).toHaveBeenCalledWith('group-action', 'case-one');
        expect(openTab).not.toHaveBeenCalled();

        setSearchContextAccessor(() => ({ groups: [group] }));
        await collectEntitySearchEntries('investigation')[0].action();
        expect(openTab).toHaveBeenCalledWith('characters', 'groups');
    });

    test('opens a character through the app selection path, which starts the editor session', async () => {
        const selectCharacterById = jest.fn().mockResolvedValue(true);
        const openTab = jest.fn();
        replaceGlobal('SillyBunnyShell', { openTab });
        setSearchContextAccessor(() => ({
            characters: [
                { name: 'Other Card', avatar: 'other.png' },
                { name: 'Editor Target', avatar: 'target.png' },
            ],
            selectCharacterById,
        }));

        await collectEntitySearchEntries('editor target')[0].action();

        // selectCharacterById populates the editor form and opens the session, so the action must not
        // open a second session on top of it.
        expect(selectCharacterById).toHaveBeenCalledWith(1);
        expect(openTab).toHaveBeenCalledWith('characters', 'editor');
    });

    test('honours a selection the app refuses', async () => {
        const selectCharacterById = jest.fn().mockResolvedValue(false);
        const openTab = jest.fn();
        replaceGlobal('SillyBunnyShell', { openTab });
        setSearchContextAccessor(() => ({
            characters: [{ name: 'Editor Target', avatar: 'target.png' }],
            selectCharacterById,
        }));

        await collectEntitySearchEntries('editor target')[0].action();

        expect(selectCharacterById).toHaveBeenCalledWith(0);
        expect(openTab).not.toHaveBeenCalled();
    });

    test('waits for the world picker to mount and selects the book by its original index', async () => {
        jest.useFakeTimers();
        const dispatchEvent = jest.fn();
        const select = { value: '', dispatchEvent };
        const getElementById = jest.fn().mockReturnValueOnce(null).mockReturnValue(select);
        const openTab = jest.fn();
        replaceGlobal('document', { getElementById });
        replaceGlobal('SillyBunnyShell', { openTab });
        setSearchContextAccessor(() => ({ getWorldInfoNames: () => ['', 'Other Book', 'Mounting Book'] }));

        const open = collectEntitySearchEntries('mounting')[0].action();
        await jest.advanceTimersByTimeAsync(40);
        await open;

        expect(openTab).toHaveBeenCalledWith('characters', 'world-info');
        expect(getElementById).toHaveBeenCalledWith('world_editor_select');
        expect(select.value).toBe('2');
        expect(dispatchEvent).toHaveBeenCalledTimes(1);
        expect(dispatchEvent.mock.calls[0][0]).toMatchObject({ type: 'change', bubbles: true });
    });

    test('gives up silently when the world picker never mounts', async () => {
        jest.useFakeTimers();
        const getElementById = jest.fn().mockReturnValue(null);
        replaceGlobal('document', { getElementById });
        replaceGlobal('SillyBunnyShell', { openTab: jest.fn() });
        setSearchContextAccessor(() => ({ getWorldInfoNames: () => ['Unmounted Book'] }));

        const open = collectEntitySearchEntries('unmounted')[0].action();
        await jest.advanceTimersByTimeAsync(2000);
        await expect(open).resolves.toBeUndefined();

        expect(jest.getTimerCount()).toBe(0);
    });

    test('never throws when priming rejects or returns null and records failed names', async () => {
        const skippedWorlds = new Set();
        const loadWorldInfo = jest.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(null);
        setSearchContextAccessor(() => ({ loadWorldInfo }));

        await expect(primeWorldInfoSearchCache({
            names: ['Rejected Book', 'Missing Book'],
            budgetMs: 100,
            skippedWorlds,
        })).resolves.toBe(skippedWorlds);

        expect(loadWorldInfo).toHaveBeenCalledTimes(2);
        expect(skippedWorlds).toEqual(new Set(['Rejected Book', 'Missing Book']));
        expect(getWorldInfoEntrySearchText('Rejected Book')).toBe('');

        await primeWorldInfoSearchCache({ names: ['Rejected Book', 'Missing Book'], skippedWorlds });
        expect(loadWorldInfo).toHaveBeenCalledTimes(2);
    });

    test('reads loaded world metadata without loading during collection', async () => {
        const loadWorldInfo = jest.fn().mockResolvedValue({
            entries: {
                0: { comment: 'Hidden district', key: ['canal'], keysecondary: ['old city'] },
            },
        });
        const context = {
            loadWorldInfo,
            getWorldInfoNames: () => ['The Veiled City'],
            characters: [],
            groups: [],
        };
        setSearchContextAccessor(() => context);
        const skippedWorlds = new Set();

        expect(collectEntitySearchEntries('canal')).toEqual([]);
        expect(loadWorldInfo).not.toHaveBeenCalled();
        await primeWorldInfoSearchCache({ names: ['The Veiled City'], budgetMs: 100, skippedWorlds });
        expect(loadWorldInfo).toHaveBeenCalledTimes(1);
        expect(getWorldInfoEntrySearchText('The Veiled City')).toBe('hidden district canal old city');
        expect(skippedWorlds).toEqual(new Set(['The Veiled City']));
        expect(collectEntitySearchEntries('canal city', { skippedWorlds })[0].displayText).toBe('The Veiled City');
        expect(loadWorldInfo).toHaveBeenCalledTimes(1);
    });

    test('primes no more than two books at a time', async () => {
        jest.useFakeTimers();
        const releases = [];
        const loadWorldInfo = jest.fn(() => new Promise(resolve => releases.push(() => resolve({ entries: {} }))));
        setSearchContextAccessor(() => ({ loadWorldInfo }));
        const names = ['Parallel Book A', 'Parallel Book B', 'Parallel Book C'];

        const prime = primeWorldInfoSearchCache({ names, budgetMs: 100 });
        await jest.advanceTimersByTimeAsync(0);
        expect(loadWorldInfo).toHaveBeenCalledTimes(2);

        releases.shift()();
        await jest.advanceTimersByTimeAsync(0);
        expect(loadWorldInfo).toHaveBeenCalledTimes(3);

        for (const release of releases) release();
        await expect(prime).resolves.toEqual(new Set(names));
        expect(jest.getTimerCount()).toBe(0);
    });

    test('honors the priming budget even if the loader never settles', async () => {
        jest.useFakeTimers();
        const loadWorldInfo = jest.fn(() => new Promise(() => {}));
        const skippedWorlds = new Set();
        setSearchContextAccessor(() => ({ loadWorldInfo }));

        const prime = primeWorldInfoSearchCache({
            names: ['Hanging Book A', 'Hanging Book B', 'Untouched Book'],
            budgetMs: 30,
            skippedWorlds,
        });
        await jest.advanceTimersByTimeAsync(30);
        await expect(prime).resolves.toBe(skippedWorlds);

        expect(loadWorldInfo).toHaveBeenCalledTimes(2);
        expect(skippedWorlds).toEqual(new Set(['Hanging Book A', 'Hanging Book B']));
        expect(getWorldInfoEntrySearchText('Hanging Book A')).toBe('');
        expect(jest.getTimerCount()).toBe(0);
    });

    test('imports without context or DOM work and does not call the context at import time', async () => {
        resetSearchContextAccessor();
        replaceGlobal('SillyTavern', undefined);
        const fetch = jest.fn();
        replaceGlobal('fetch', fetch);
        const module = await import(`${entityModuleUrl}?no-context`);
        expect(module.collectEntitySearchEntries('anything')).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });

    test('does not acquire an available context until collection is requested', async () => {
        const getContext = jest.fn(() => ({ characters: [] }));
        replaceGlobal('SillyTavern', { getContext });
        const module = await import(`${entityModuleUrl}?lazy-context`);

        expect(getContext).not.toHaveBeenCalled();
        expect(module.collectEntitySearchEntries('anything')).toEqual([]);
        expect(getContext).toHaveBeenCalledTimes(1);
    });
});
