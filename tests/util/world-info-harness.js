import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { event_types } from '../../public/scripts/events.js';
import { normalizeWorldInfoPosition } from '../../public/scripts/world-info-character-book.js';
import { getTimedEffectWindow, getWorldInfoGroupNames, normalizeWorldInfoKey, normalizeWorldInfoProbability, passesWorldInfoProbability } from '../../public/scripts/world-info-scan-core.js';

const source = readFileSync(new URL('../../public/scripts/world-info.js', import.meta.url), 'utf8');

export function declarationSource(pattern, name, text = source) {
    const match = text.match(new RegExp(`^(?:export )?(${pattern}[\\s\\S]*?^})`, 'm'));
    if (!match) {
        throw new Error(`World Info harness: public/scripts/world-info.js has no declaration named "${name}". Update the declaration list in tests/util/world-info-harness.js to follow the rename or removal.`);
    }
    return match[1];
}

export const functionSource = (name, text) => declarationSource(`(?:async )?function ${name}\\(`, name, text);
export const classSource = (name, text) => declarationSource(`class ${name} \\{`, name, text);

export const SCAN_CLASSES = ['WorldInfoBuffer', 'WorldInfoTimedEffects'];
export const SCAN_FUNCTIONS = [
    'parseRegexFromString', 'getCharacterLore', 'getWorldEntries', 'getGlobalLore', 'getChatLore', 'getPersonaLore',
    'getSortedEntries', 'parseDecorators', 'checkWorldInfo', 'filterGroupsByScoring', 'filterGroupsByTimedEffects',
    'filterByInclusionGroups',
];

export function buildScanSource(text = source) {
    return [
        ...SCAN_CLASSES.map(name => classSource(name, text)),
        ...SCAN_FUNCTIONS.map(name => functionSource(name, text)),
    ].join('\n');
}

const SCAN_SOURCES = buildScanSource();

export function createHarness({ books = {} } = {}) {
    const context = vm.createContext({
        console: { debug() {}, log() {}, warn() {}, error() {} },
        structuredClone, Map, Set, Math, JSON, Number, String, Array, Object, RegExp, Promise,
        event_types,
        normalizeWorldInfoPosition, getTimedEffectWindow, getWorldInfoGroupNames, normalizeWorldInfoKey, normalizeWorldInfoProbability, passesWorldInfoProbability,
        world_info_insertion_strategy: { evenly: 0, character_first: 1, global_first: 2 },
        world_info_logic: { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 },
        scan_state: { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 },
        world_info_position: { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 },
        wi_anchor_position: { before: 0, after: 1 },
        extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        regex_placement: { WORLD_INFO: 5 },
        defaultGlobalScanData: Object.freeze({ trigger: 'normal', personaDescription: '', characterDescription: '', characterPersonality: '', characterDepthPrompt: '', scenario: '', creatorNotes: '' }),
        KNOWN_DECORATORS: ['@@activate', '@@dont_activate'],
        METADATA_KEY: 'world_info', NOTE_MODULE_NAME: 'note',
        DEFAULT_DEPTH: 4, DEFAULT_WEIGHT: 100, MAX_SCAN_DEPTH: 1000,
        sortFn: (a, b) => b.order - a.order,
        world_info_depth: 2, world_info_min_activations: 0, world_info_min_activations_depth_max: 0,
        world_info_budget: 25, world_info_budget_cap: 0, world_info_recursive: false, world_info_max_recursion_steps: 0,
        world_info_overflow_alert: false, world_info_case_sensitive: false, world_info_match_whole_words: false,
        world_info_use_group_scoring: false, world_info_character_strategy: 1,
        name1: 'Roleplay User', name2: 'Aster',
        characters: [
            { name: 'Aster', avatar: 'aster.png', data: { extensions: { world: 'Aster Book' } } },
            { name: 'Bram', avatar: 'bram.png', data: { extensions: { world: 'Bram Book' } } },
        ],
        this_chid: 0,
        world_info: { charLore: [{ name: 'aster', extraBooks: ['Aster Extra', 'Shared Book'] }] },
        selected_world_info: ['Global Book', 'Shared Book'],
        chat_metadata: { world_info: 'Chat Book' },
        power_user: { persona_description_lorebook: 'Persona Book' },
        extension_settings: { note: { allowWIScan: true } },
        shouldWIAddPrompt: true,
        tagMap: { 'aster.png': [], 'bram.png': ['tag-bram'] },
        extensionPrompts: {
            note: { value: 'Roleplay note mentions a star.', scan: true },
            hidden: { value: 'A star the scan cannot see.', scan: false },
        },
        toastr: { warning: jest.fn() },
        eventSource: { emit: jest.fn(async () => {}) },
        loadWorldInfo: jest.fn(async name => structuredClone(books[name] ?? null)),
        getRegexedString: jest.fn(text => text),
        getAuthorsNotePosition: () => 1, getAuthorsNoteDepth: () => 4, getAuthorsNoteRole: () => 0,
        getTokenCountAsync: async text => String(text).split(/\s+/).filter(Boolean).length,
        getStringHash: value => [...String(value)].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0),
        escapeRegex: value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    });
    Object.assign(context, {
        substituteParams: (content, options = {}) => String(content ?? '')
            .replace(/{{char}}/gi, options.name2Override ?? context.name2)
            .replace(/{{user}}/gi, options.name1Override ?? context.name1),
        getCharaFilename: (chid = null) => context.characters[chid ?? context.this_chid]?.avatar?.replace(/\.[^/.]+$/, '') ?? null,
        getTagKeyForEntity: chid => context.characters[chid]?.avatar,
        getExtensionPromptByName: async key => context.extensionPrompts[key]?.value ?? '',
        setExtensionPrompt: jest.fn(),
    });
    context.getContext = () => ({ extensionPrompts: context.extensionPrompts, tagMap: context.tagMap, setExtensionPrompt: context.setExtensionPrompt });
    vm.runInContext(`${SCAN_SOURCES}\nglobalThis.WorldInfoBuffer = WorldInfoBuffer;`, context);
    return context;
}
