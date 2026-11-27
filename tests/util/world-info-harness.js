/* global globalThis */
import { jest } from '@jest/globals';

import { event_types } from '../../public/scripts/events.js';
import { importWorldInfoModule } from './world-info-module-harness.js';

export const DEFAULT_GLOBAL_SCAN_DATA = Object.freeze({
    trigger: 'normal',
    personaDescription: '',
    characterDescription: '',
    characterPersonality: '',
    characterDepthPrompt: '',
    scenario: '',
    creatorNotes: '',
});

const DEFAULT_SETTINGS = Object.freeze({
    world_info_depth: 2,
    world_info_min_activations: 0,
    world_info_min_activations_depth_max: 0,
    world_info_budget: 25,
    world_info_budget_cap: 0,
    world_info_recursive: false,
    world_info_max_recursion_steps: 0,
    world_info_overflow_alert: false,
    world_info_case_sensitive: false,
    world_info_match_whole_words: false,
    world_info_use_group_scoring: false,
    world_info_character_strategy: 1,
});

function defaultCharacters() {
    return [
        { name: 'Aster', avatar: 'aster.png', data: { extensions: { world: 'Aster Book' } } },
        { name: 'Bram', avatar: 'bram.png', data: { extensions: { world: 'Bram Book' } } },
    ];
}

function replaceObject(target, next) {
    for (const key of Object.keys(target)) {
        delete target[key];
    }
    Object.assign(target, next);
}

/**
 * Caches live `public/scripts/world-info.js` instances keyed by primitive `script.js` bindings
 * (`this_chid`, `name1`, `name2`) so large parameterised scan suites execute real ESM logic quickly
 * while isolating mutable books, cache, settings, and metadata between tests.
 */
let cachedInstance = null;
let cachedKey = null;

export async function createHarness({
    books = {},
    state: stateOverrides = {},
    settings = {},
    selectedWorldInfo = ['Global Book', 'Shared Book'],
    charLore = [{ name: 'aster', extraBooks: ['Aster Extra', 'Shared Book'] }],
    getTokenCountAsync = null,
    fresh = false,
} = {}) {
    const thisChid = stateOverrides.this_chid ?? 0;
    const name1 = stateOverrides.name1 ?? 'Roleplay User';
    const name2 = stateOverrides.name2 ?? 'Aster';
    const key = `${thisChid}|${name1}|${name2}`;

    const loadedBooks = [];
    const fetchMock = jest.fn(async (url, init) => {
        if (url === '/api/worldinfo/get') {
            const { name } = JSON.parse(init.body);
            loadedBooks.push(name);
            const book = currentBooks[name] ?? null;
            return { ok: Boolean(book), json: async () => structuredClone(book) };
        }
        if (url === '/api/settings/get') {
            return { ok: true, json: async () => ({ world_names: Object.keys(currentBooks) }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    });
    let currentBooks = books;

    if (fresh || !cachedInstance || cachedKey !== key) {
        cachedInstance = await importWorldInfoModule({
            this_chid: thisChid,
            name1,
            name2,
            noteModuleName: 'note',
            shouldWIAddPrompt: true,
            authorsNotePosition: 1,
            authorsNoteDepth: 4,
            authorsNoteRole: 0,
            fetch: fetchMock,
        });
        cachedInstance.worldInfo.setWorldInfoSettings(
            { ...DEFAULT_SETTINGS, world_info: { charLore } },
            { world_names: Object.keys(books) },
        );
        cachedKey = key;
    }

    const { worldInfo, state, mocks } = cachedInstance;
    globalThis.fetch = fetchMock;
    worldInfo.worldInfoCache.clear();

    const nextCharacters = stateOverrides.characters
        ? structuredClone(stateOverrides.characters)
        : defaultCharacters();
    state.characters.splice(0, state.characters.length, ...nextCharacters);

    replaceObject(state.chat_metadata, stateOverrides.chat_metadata
        ? structuredClone(stateOverrides.chat_metadata)
        : { world_info: 'Chat Book' });

    replaceObject(state.power_user, stateOverrides.power_user
        ? structuredClone(stateOverrides.power_user)
        : { persona_description_lorebook: 'Persona Book' });

    replaceObject(state.extension_settings, stateOverrides.extension_settings
        ? structuredClone(stateOverrides.extension_settings)
        : { note: { allowWIScan: true } });

    replaceObject(state.extensionPrompts, stateOverrides.extensionPrompts
        ? structuredClone(stateOverrides.extensionPrompts)
        : {
            note: { value: 'Roleplay note mentions a star.', scan: true },
            hidden: { value: 'A star the scan cannot see.', scan: false },
        });

    replaceObject(state.tagMap, stateOverrides.tagMap
        ? structuredClone(stateOverrides.tagMap)
        : { 'aster.png': [], 'bram.png': ['tag-bram'] });

    state.name1 = name1;
    state.name2 = name2;
    state.this_chid = thisChid;

    replaceObject(worldInfo.world_info, { charLore: structuredClone(charLore) });
    worldInfo.updateWorldInfoSettings(
        { ...DEFAULT_SETTINGS, ...settings },
        [...selectedWorldInfo],
    );

    if (getTokenCountAsync) {
        mocks.getTokenCountAsync.mockImplementation(getTokenCountAsync);
    } else {
        mocks.getTokenCountAsync.mockImplementation(async text => String(text ?? '').split(/\s+/).filter(Boolean).length);
    }

    mocks.eventSource.emit.mockClear();
    mocks.setExtensionPrompt.mockClear();
    mocks.getRegexedString.mockClear();
    mocks.toastr.warning.mockClear();

    return {
        worldInfo,
        state,
        mocks,
        loadedBooks,
        defaultGlobalScanData: DEFAULT_GLOBAL_SCAN_DATA,
        checkWorldInfo: worldInfo.checkWorldInfo,
        updateSettings(nextSettings, nextSelected) {
            worldInfo.updateWorldInfoSettings(nextSettings, nextSelected);
        },
        setBooks(nextBooks) {
            currentBooks = nextBooks;
            worldInfo.worldInfoCache.clear();
        },
        async forceActivate(entries) {
            await mocks.eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, entries);
            mocks.eventSource.emit.mockClear();
        },
    };
}

export function resetCachedHarness() {
    cachedInstance = null;
    cachedKey = null;
}
