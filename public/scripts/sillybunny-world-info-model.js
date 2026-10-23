// SillyBunny: data layer for the World Info editor rebuild. No DOM and no world-info.js import:
// persistence functions are injected so the model stays unit-testable and world-info.js keeps
// owning saves, caches and originalData bookkeeping.
//
// Entry edits follow the legacy per-field writers (world-info.js getWorldEntry handlers) rather than
// syncWIOriginalDataEntry, because the full CharacterBook serializer is not equivalent for imported
// books (it turns useGroupScoring/role null into false/0 and groupWeight into null).

import { serializeCharacterBookKeys } from './world-info-character-book.js';
import { GENERATION_TYPE_TRIGGERS } from './constants.js';

/** Mirrors `world_info_position` (world-info.js). */
export const WI_POSITION = Object.freeze({ before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 });
/** Mirrors `world_info_logic` (world-info.js). */
export const WI_LOGIC = Object.freeze({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 });
/** Mirrors `extension_prompt_roles` (script.js). */
export const WI_ROLE = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });

export const MAX_SCAN_DEPTH = 1000;
export const MAX_GROUP_WEIGHT = 999999;

// Labels are the legacy option text; `i18n` is the existing data-i18n key the UI translates with.
export const POSITION_OPTIONS = Object.freeze([
    { value: '0', label: '↑Char', i18n: 'Before Char Defs' },
    { value: '1', label: '↓Char', i18n: 'After Char Defs' },
    { value: '5', label: '↑EM', i18n: 'Before EM' },
    { value: '6', label: '↓EM', i18n: 'After EM' },
    { value: '2', label: '↑AN', i18n: 'Before AN' },
    { value: '3', label: '↓AN', i18n: 'After AN' },
    { value: '4:0', label: '@D ⚙️', i18n: 'at Depth System' },
    { value: '4:1', label: '@D 👤', i18n: 'at Depth User' },
    { value: '4:2', label: '@D 🤖', i18n: 'at Depth AI' },
    { value: '7', label: '➡️ Outlet', i18n: 'Outlet' },
]);

export const LOGIC_OPTIONS = Object.freeze([
    { value: '0', label: 'AND ANY', i18n: 'AND ANY' },
    { value: '3', label: 'AND ALL', i18n: 'AND ALL' },
    { value: '1', label: 'NOT ALL', i18n: 'NOT ALL' },
    { value: '2', label: 'NOT ANY', i18n: 'NOT ANY' },
]);

export const STRATEGY_OPTIONS = Object.freeze([
    { value: 'normal', label: 'Normal', i18n: 'Normal' },
    { value: 'constant', label: 'Constant', i18n: 'Constant' },
    { value: 'vectorized', label: 'Vectorized', i18n: 'Vectorized' },
]);

export const TRI_STATE_OPTIONS = Object.freeze([
    { value: 'null', label: 'Use global', i18n: 'Use global' },
    { value: 'true', label: 'Yes', i18n: 'Yes' },
    { value: 'false', label: 'No', i18n: 'No' },
]);

const TRIGGER_LABELS = { normal: 'Normal', continue: 'Continue', impersonate: 'Impersonate', swipe: 'Swipe', regenerate: 'Regenerate', quiet: 'Quiet' };
export const TRIGGER_OPTIONS = Object.freeze(GENERATION_TYPE_TRIGGERS.map(value => ({ value, label: TRIGGER_LABELS[value] ?? value, i18n: TRIGGER_LABELS[value] ?? value })));

// HUMAN: replace — section titles without an existing i18n key use the copy placeholder.
export const SECTIONS = Object.freeze([
    { id: 'entry', title: null, expander: false },
    { id: 'keywords', title: 'lorum ipsum', expander: false },
    { id: 'content', title: 'Content', i18n: 'Content', expander: false },
    { id: 'insertion', title: 'lorum ipsum', expander: false },
    { id: 'matching', title: 'lorum ipsum', expander: true },
    { id: 'sources', title: 'Additional Matching Sources', i18n: 'Additional Matching Sources', expander: true },
    { id: 'timed', title: 'lorum ipsum', expander: true },
    { id: 'group', title: 'Inclusion Group', i18n: 'Inclusion Group', expander: true },
    { id: 'recursion', title: 'lorum ipsum', expander: true },
    { id: 'filters', title: 'lorum ipsum', expander: true },
    { id: 'advanced', title: 'lorum ipsum', expander: true },
]);

// ---------------------------------------------------------------------------------------------
// Parsers: UI value → native value, reproducing the legacy handlers.

const isBlank = value => value === null || value === undefined || String(value).trim() === '';

/** `order`: empty or invalid → 0, no clamping (world-info.js order handler). */
export function parseOrder(raw) {
    if (typeof raw === 'number') return Number.isNaN(raw) ? 0 : raw;
    const value = Number(raw);
    return Number.isNaN(value) ? 0 : value;
}

/** Nullable numbers: empty or invalid → null; optional clamp (legacy `handleOptionalSelect`/numeric helper). */
export function parseNullableNumber(raw, { min = -Infinity, max = Infinity, clamp = false } = {}) {
    if (isBlank(raw)) return null;
    const value = Number(raw);
    if (Number.isNaN(value)) return null;
    return clamp ? Math.min(max, Math.max(min, value)) : value;
}

/** `scanDepth`: empty/invalid → null (global), else floored into 0…1000. */
export function parseScanDepth(raw) {
    const value = parseNullableNumber(raw);
    if (value === null) return null;
    return Math.floor(Math.min(MAX_SCAN_DEPTH, Math.max(0, value)));
}

/** `probability`: empty/invalid → null, else clamped 0…100 (decimals kept). */
export function parseProbability(raw) {
    return parseNullableNumber(raw, { min: 0, max: 100, clamp: true });
}

/** Tri-state selects: 'null' → null, 'true' → true, anything else → false. */
export function parseTriState(raw) {
    if (raw === null || raw === 'null') return null;
    return raw === true || raw === 'true';
}

export function triStateValue(value) {
    return value === null || value === undefined ? 'null' : String(Boolean(value));
}

/** `selectiveLogic`: Number, NaN → AND ANY. No enum membership check (legacy). */
export function parseLogic(raw) {
    const value = Number(raw);
    return Number.isNaN(value) ? WI_LOGIC.AND_ANY : value;
}

/** Position combo value ('4:1', '7', …) → `{ position, role }`; role is null off @D (legacy). */
export function parsePosition(raw) {
    const [positionText, roleText] = String(raw).split(':');
    const position = Number(positionText);
    if (Number.isNaN(position)) return { position: 0, role: null };
    if (position !== WI_POSITION.atDepth) return { position, role: null };
    const role = Number(roleText ?? WI_ROLE.SYSTEM);
    return { position, role: Number.isNaN(role) ? WI_ROLE.SYSTEM : role };
}

export function positionValue(entry) {
    const position = Number(entry?.position ?? 0);
    if (position === WI_POSITION.atDepth) return `${position}:${Number(entry?.role ?? WI_ROLE.SYSTEM)}`;
    return String(position);
}

/** Recursion level text → stored `delayUntilRecursion` (legacy level handler, verbatim rules). */
export function parseRecursionLevel(raw, current) {
    const content = raw === null || raw === undefined ? '' : String(raw);
    if (content === '') return typeof current === 'boolean' ? current : true;
    const level = Number(content);
    if (level === 1) return true;
    return Number.isInteger(level) && level > 1 ? level : false;
}

export function recursionLevelValue(value) {
    return typeof value === 'number' && value > 1 ? String(value) : '';
}

/** Inclusion groups are one comma-joined string; chips show its parts. */
export function splitGroups(value) {
    return String(value ?? '').split(/,\s*/).map(part => part.trim()).filter(Boolean);
}

export function joinGroups(parts) {
    return (parts ?? []).map(part => String(part).trim()).filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------------------------
// Keywords. Legacy plaintext parsing (splitKeywordsAndRegexes) has tokenizer quirks (it skips the
// character after each consumed comma). Chips only need a predictable splitter: a token is a regex
// only when it starts with `/`, commas inside an open or valid regex stay, and an invalid closed
// regex falls back to comma splitting like the legacy tokenizer.

/** Same acceptance rules as world-info.js `parseRegexFromString`. */
export function parseKeywordRegex(input) {
    const match = String(input).match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return null;
    let [, pattern, flags] = match;
    if (pattern.match(/(^|[^\\])\//)) return null;
    pattern = pattern.replace('\\/', '/');
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

export const isRegexKeyword = value => parseKeywordRegex(value) !== null;

/**
 * Splits typed keyword text into tokens for `createChipEntry`. The last token is returned even when
 * unfinished (an open regex keeps its trailing comma) so the chip entry can keep it pending.
 * @param {string} text
 * @returns {string[]}
 */
export function splitKeywords(text) {
    const tokens = [];
    let buffer = '';
    let regex = 'none'; // none | open | closed
    const flush = () => {
        const token = buffer.trim();
        buffer = '';
        regex = 'none';
        if (!token) return;
        if (token.startsWith('/') && !isRegexKeyword(token) && /\/[^/]*$/.test(token.slice(1))) {
            tokens.push(...token.split(',').map(part => part.trim()).filter(Boolean));
            return;
        }
        tokens.push(token);
    };
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (regex === 'none' && char === '/' && buffer.trim() === '') {
            regex = 'open';
        } else if (regex === 'open' && char === '/' && !isEscaped(text, index)) {
            regex = 'closed';
        } else if (char === ',' && regex !== 'open') {
            flush();
            continue;
        }
        buffer += char;
    }
    const tail = buffer.trim();
    if (tail) {
        if (regex === 'open') tokens.push(tail);
        else flush();
    }
    return tokens;
}

function isEscaped(text, index) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes++;
    return slashes % 2 === 1;
}

// ---------------------------------------------------------------------------------------------
// Field schema. Each field reads a UI value from a draft and writes one back; `keys` lists the
// native entry keys it owns. `coverage` below maps every `newWorldInfoEntryDefinition` key.

const strategyOf = entry => entry?.constant === true ? 'constant' : entry?.vectorized === true ? 'vectorized' : 'normal';
const hasFilter = entry => {
    const filter = entry?.characterFilter;
    return Boolean(filter && (filter.isExclude || filter.names?.length || filter.tags?.length));
};
const arrayOf = value => Array.isArray(value) ? [...value] : [];

function bool(id, section, label, i18n = label) {
    return { id, section, control: 'switch', label, i18n, keys: [id], read: entry => Boolean(entry[id]), write: (entry, value) => { entry[id] = Boolean(value); } };
}

function triState(id, section, label) {
    return { id, section, control: 'combo', options: TRI_STATE_OPTIONS, label, i18n: label, keys: [id], read: entry => triStateValue(entry[id]), write: (entry, value) => { entry[id] = parseTriState(value); } };
}

function nullableSpin(id, section, label, { placeholder, placeholderI18n = placeholder, min = 0, max } = {}) {
    return {
        id, section, control: 'spin', nullable: true, label, i18n: label, placeholder, placeholderI18n, min, max, keys: [id],
        read: entry => entry[id] ?? null,
        write: (entry, value) => { entry[id] = parseNullableNumber(value); },
    };
}

function text(id, section, label, { control = 'entry', placeholder, placeholderI18n = placeholder } = {}) {
    return { id, section, control, label, i18n: label, placeholder, placeholderI18n, keys: [id], read: entry => String(entry[id] ?? ''), write: (entry, value) => { entry[id] = String(value ?? ''); } };
}

/** @type {ReadonlyArray<object>} */
export const FIELDS = Object.freeze([
    // Entry
    { ...text('comment', 'entry', 'Title', { placeholder: 'Entry Title/Memo' }), i18n: 'Title', header: true },
    {
        id: 'enabled', section: 'entry', placement: 'list', control: 'switch', label: 'Enabled', i18n: 'Enabled', keys: ['disable'],
        read: entry => !entry.disable,
        write: (entry, value) => { entry.disable = !value; },
    },
    {
        id: 'strategy', section: 'entry', placement: 'bar', control: 'combo', options: STRATEGY_OPTIONS, label: 'Strategy', i18n: 'Strategy', keys: ['constant', 'vectorized'],
        read: strategyOf,
        write: (entry, value) => {
            if (!STRATEGY_OPTIONS.some(option => option.value === value)) return;
            entry.constant = value === 'constant';
            entry.vectorized = value === 'vectorized';
        },
    },
    // Keywords
    {
        id: 'key', section: 'keywords', control: 'chips', split: 'keywords', label: 'Primary Keywords', i18n: 'Primary Keywords',
        placeholder: 'Keywords or Regexes', placeholderI18n: 'Keywords or Regexes', keys: ['key'],
        read: entry => arrayOf(entry.key), write: (entry, value) => { entry.key = arrayOf(value).map(String); },
    },
    {
        id: 'keysecondary', section: 'keywords', control: 'chips', split: 'keywords', label: 'Optional Filter', i18n: 'Optional Filter',
        placeholder: 'Keywords or Regexes (ignored if empty)', placeholderI18n: 'Keywords or Regexes (ignored if empty)', keys: ['keysecondary'],
        // The scanner ignores secondary keys unless `selective` (world-info.js checkWorldInfo); legacy hides them too.
        visibleWhen: entry => entry.selective !== false,
        read: entry => arrayOf(entry.keysecondary), write: (entry, value) => { entry.keysecondary = arrayOf(value).map(String); },
    },
    {
        id: 'selectiveLogic', section: 'keywords', control: 'combo', options: LOGIC_OPTIONS, label: 'Logic', i18n: 'Logic', keys: ['selectiveLogic'],
        visibleWhen: entry => entry.selective !== false && arrayOf(entry.keysecondary).length > 0,
        read: entry => String(parseLogic(entry.selectiveLogic ?? WI_LOGIC.AND_ANY)),
        write: (entry, value) => { entry.selectiveLogic = parseLogic(value); },
    },
    // Content
    { ...text('content', 'content', 'Content', { control: 'content', placeholder: 'What this keyword should mean to the AI, sent verbatim' }) },
    // Insertion
    {
        id: 'position', section: 'insertion', placement: 'bar', control: 'combo', options: POSITION_OPTIONS, label: 'Position', i18n: 'Position', keys: ['position', 'role'],
        read: positionValue,
        write: (entry, value) => Object.assign(entry, parsePosition(value)),
    },
    {
        ...nullableSpin('depth', 'insertion', 'Depth', { max: 9999 }),
        placement: 'bar',
        visibleWhen: entry => Number(entry.position) === WI_POSITION.atDepth,
    },
    {
        ...text('outletName', 'insertion', 'Outlet Name', { placeholder: 'Outlet Name' }),
        placement: 'bar',
        visibleWhen: entry => Number(entry.position) === WI_POSITION.outlet,
    },
    {
        id: 'order', section: 'insertion', placement: 'bar', control: 'spin', nullable: false, min: 0, max: 9999, label: 'Order', i18n: 'Order', keys: ['order'],
        read: entry => parseOrder(entry.order ?? 0),
        write: (entry, value) => { entry.order = parseOrder(value); },
    },
    {
        // Legacy probability edits always switch useProbability on, even when the value becomes null.
        id: 'probability', section: 'insertion', placement: 'bar', control: 'spin', nullable: true, min: 0, max: 100, label: 'Trigger %', i18n: 'Trigger %:', keys: ['probability', 'useProbability'],
        read: entry => entry.probability ?? null,
        write: (entry, value) => {
            entry.probability = parseProbability(value);
            entry.useProbability = true;
        },
    },
    // Matching
    {
        id: 'scanDepth', section: 'matching', control: 'spin', nullable: true, min: 0, max: MAX_SCAN_DEPTH, label: 'Scan Depth', i18n: 'Scan Depth',
        placeholder: 'Use global setting', placeholderI18n: 'Use global setting', keys: ['scanDepth'],
        read: entry => entry.scanDepth ?? null,
        write: (entry, value) => { entry.scanDepth = parseScanDepth(value); },
    },
    triState('caseSensitive', 'matching', 'Case-Sensitive'),
    triState('matchWholeWords', 'matching', 'Whole Words'),
    triState('useGroupScoring', 'matching', 'Group Scoring'),
    text('automationId', 'matching', 'Automation ID', { placeholder: '( None )' }),
    // Additional matching sources
    bool('matchPersonaDescription', 'sources', 'Persona Description'),
    bool('matchCharacterDescription', 'sources', 'Character Description'),
    bool('matchCharacterPersonality', 'sources', 'Character Personality'),
    bool('matchCharacterDepthPrompt', 'sources', 'Character\'s Note'),
    bool('matchScenario', 'sources', 'Scenario'),
    bool('matchCreatorNotes', 'sources', 'Creator\'s Notes'),
    // Timed effects
    nullableSpin('sticky', 'timed', 'Sticky', { placeholder: 'Non-sticky', max: 999999 }),
    nullableSpin('cooldown', 'timed', 'Cooldown', { placeholder: 'No cooldown', max: 999999 }),
    nullableSpin('delay', 'timed', 'Delay', { placeholder: 'No delay', max: 999999 }),
    // Inclusion group
    {
        id: 'group', section: 'group', control: 'chips', split: 'comma', label: 'Inclusion Group', i18n: 'Inclusion Group', keys: ['group'],
        read: entry => splitGroups(entry.group),
        write: (entry, value) => { entry.group = Array.isArray(value) ? joinGroups(value) : String(value ?? '').trim(); },
    },
    bool('groupOverride', 'group', 'Prioritize'),
    {
        id: 'groupWeight', section: 'group', control: 'spin', nullable: true, min: 1, max: MAX_GROUP_WEIGHT, placeholder: '100', label: 'Group Weight', i18n: 'Group Weight', keys: ['groupWeight'],
        read: entry => entry.groupWeight ?? null,
        write: (entry, value) => { entry.groupWeight = parseNullableNumber(value, { min: 1, max: MAX_GROUP_WEIGHT, clamp: true }); },
    },
    // Recursion
    bool('excludeRecursion', 'recursion', 'Non-recursable'),
    bool('preventRecursion', 'recursion', 'Prevent further recursion'),
    {
        id: 'delayUntilRecursion', section: 'recursion', control: 'switch', label: 'Delay until recursion', i18n: 'Delay until recursion', keys: ['delayUntilRecursion'],
        read: entry => Boolean(entry.delayUntilRecursion),
        write: (entry, value) => { entry.delayUntilRecursion = value ? (entry.delayUntilRecursion || true) : false; },
    },
    {
        id: 'recursionLevel', section: 'recursion', control: 'spin', nullable: true, min: 1, placeholder: '1', label: 'Recursion Level', i18n: 'Recursion Level', keys: ['delayUntilRecursion'],
        visibleWhen: entry => Boolean(entry.delayUntilRecursion),
        read: entry => recursionLevelValue(entry.delayUntilRecursion),
        write: (entry, value) => { entry.delayUntilRecursion = parseRecursionLevel(value, entry.delayUntilRecursion); },
    },
    // Filters (D10)
    {
        id: 'characterFilter', section: 'filters', control: 'character-filter', label: 'Filter to Characters or Tags', i18n: 'Filter to Characters or Tags', keys: ['characterFilter'],
        read: entry => ({
            enabled: hasFilter(entry),
            isExclude: Boolean(entry.characterFilter?.isExclude),
            names: arrayOf(entry.characterFilter?.names),
            tags: arrayOf(entry.characterFilter?.tags),
        }),
        write: (entry, value) => { writeCharacterFilter(entry, value); },
    },
    {
        id: 'triggers', section: 'filters', control: 'chips', suggestions: TRIGGER_OPTIONS, label: 'Filter to Generation Triggers', i18n: 'Filter to Generation Triggers', keys: ['triggers'],
        read: entry => arrayOf(entry.triggers),
        write: (entry, value) => { entry.triggers = arrayOf(value); },
    },
    // Advanced
    bool('ignoreBudget', 'advanced', 'Ignore budget'),
    bool('agentBlacklisted', 'advanced', 'Agent blacklisted'),
    { id: 'uid', section: 'advanced', control: 'property', label: 'UID', i18n: 'UID', keys: [], read: entry => String(entry.uid ?? ''), write: null },
]);

export const FIELD_BY_ID = new Map(FIELDS.map(field => [field.id, field]));

/**
 * Every `newWorldInfoEntryDefinition` key → the field that edits it, or `preserve` when the editor
 * never writes it. Tests fail when upstream adds a definition key missing here.
 */
export const DEFINITION_COVERAGE = Object.freeze({
    key: 'key', keysecondary: 'keysecondary', comment: 'comment', content: 'content',
    constant: 'strategy', vectorized: 'strategy',
    // Hidden in the legacy template (index.html entry template): kept as stored, never edited.
    selective: 'preserve', addMemo: 'preserve',
    selectiveLogic: 'selectiveLogic', order: 'order', position: 'position', role: 'position',
    disable: 'enabled', ignoreBudget: 'ignoreBudget', agentBlacklisted: 'agentBlacklisted',
    excludeRecursion: 'excludeRecursion', preventRecursion: 'preventRecursion',
    matchPersonaDescription: 'matchPersonaDescription', matchCharacterDescription: 'matchCharacterDescription',
    matchCharacterPersonality: 'matchCharacterPersonality', matchCharacterDepthPrompt: 'matchCharacterDepthPrompt',
    matchScenario: 'matchScenario', matchCreatorNotes: 'matchCreatorNotes',
    delayUntilRecursion: 'delayUntilRecursion',
    probability: 'probability', useProbability: 'probability',
    depth: 'depth', outletName: 'outletName', group: 'group', groupOverride: 'groupOverride', groupWeight: 'groupWeight',
    scanDepth: 'scanDepth', caseSensitive: 'caseSensitive', matchWholeWords: 'matchWholeWords', useGroupScoring: 'useGroupScoring',
    automationId: 'automationId', sticky: 'sticky', cooldown: 'cooldown', delay: 'delay',
    // Slash-command aliases for the stored `characterFilter` object.
    characterFilterNames: 'characterFilter', characterFilterTags: 'characterFilter', characterFilterExclude: 'characterFilter',
    triggers: 'triggers',
});

/** Native entry keys the editor can change. Everything else on an entry is carried through untouched. */
export const EDITABLE_KEYS = Object.freeze([...new Set(FIELDS.flatMap(field => field.keys))]);

/**
 * Legacy character-filter rules: an empty, non-excluding filter is deleted; otherwise the whole
 * `{ isExclude, names, tags }` object is replaced.
 */
export function writeCharacterFilter(entry, { enabled = true, isExclude = false, names = [], tags = [] } = {}) {
    const filter = { isExclude: Boolean(isExclude), names: arrayOf(names), tags: arrayOf(tags) };
    if (!enabled || (!filter.isExclude && !filter.names.length && !filter.tags.length)) {
        delete entry.characterFilter;
        return;
    }
    entry.characterFilter = filter;
}

// ---------------------------------------------------------------------------------------------
// Drafts

/** Detached copy of a native entry. UID 0 is a valid key; unknown properties are kept. */
export function entryToDraft(entry) {
    return structuredClone(entry ?? {});
}

/** UI value of a field for a draft. */
export function readField(draft, id) {
    const field = FIELD_BY_ID.get(id);
    if (!field) throw new RangeError(`Unknown World Info field: ${id}`);
    return field.read(draft);
}

/** Applies a UI value to a draft through the field's legacy write rules. Returns the draft. */
export function writeField(draft, id, value) {
    const field = FIELD_BY_ID.get(id);
    if (!field?.write) throw new RangeError(`World Info field is not editable: ${id}`);
    field.write(draft, value);
    return draft;
}

export function isFieldVisible(draft, id) {
    const field = FIELD_BY_ID.get(id);
    return Boolean(field) && (!field.visibleWhen || field.visibleWhen(draft));
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);

/**
 * Native keys whose values differ between two entry snapshots. Absent and `undefined` compare equal,
 * matching JSON persistence.
 * @returns {string[]}
 */
export function changedKeys(before, after, keys = EDITABLE_KEYS) {
    return keys.filter(key => !sameValue(before?.[key], after?.[key]));
}

/**
 * Writes a draft's changed keys into the tracked entry from `loadWorldInfo` (never a clone, so the
 * tracked-merge save keeps working) and mirrors them into imported `originalData`.
 * Keys edited elsewhere since `baseline` was taken survive unless this draft also changed them.
 * @param {object} data Tracked book data.
 * @param {number|string} uid
 * @param {object} baseline Draft snapshot taken when the entry was opened or last rebased.
 * @param {object} draft
 * @param {{ setOriginal: (data: object, uid: number|string, path: string, value: any) => void }} deps
 * @returns {string[]} Native keys written.
 */
export function applyDraft(data, uid, baseline, draft, { setOriginal }) {
    const entry = data?.entries?.[uid];
    if (!entry) throw new Error(`World Info entry ${uid} no longer exists`);
    const keys = changedKeys(baseline, draft);
    for (const key of keys) {
        if (!hasOwn(draft, key) || draft[key] === undefined) delete entry[key];
        else entry[key] = structuredClone(draft[key]);
    }
    mirrorKeys(data, uid, keys, setOriginal);
    return keys;
}

/**
 * Re-bases one native key of an open draft after a list-level action (D1) changed the live entry.
 * The draft follows only when the user had not changed that key, so dirty state is unchanged.
 * @returns {boolean} Whether the draft value was replaced.
 */
export function rebaseKey(entry, baseline, draft, key) {
    const clean = sameValue(baseline[key], draft[key]);
    const live = entry?.[key] === undefined ? undefined : structuredClone(entry[key]);
    const assign = (target, value) => { if (value === undefined) delete target[key]; else target[key] = structuredClone(value); };
    assign(baseline, live);
    if (clean) assign(draft, live);
    return clean;
}

/** Keys an external writer changed on the live entry since the draft was opened (B.6 banner). */
export function externalChanges(entry, baseline) {
    return changedKeys(baseline, entry);
}

// ---------------------------------------------------------------------------------------------
// originalData mirroring — same paths and values as the legacy per-field writers.

const ORIGINAL_PATHS = Object.freeze({
    comment: 'comment',
    content: 'content',
    selectiveLogic: 'extensions.selectiveLogic',
    order: 'insertion_order',
    depth: 'extensions.depth',
    role: 'extensions.role',
    ignoreBudget: 'extensions.ignore_budget',
    agentBlacklisted: 'extensions.agent_blacklisted',
    excludeRecursion: 'extensions.exclude_recursion',
    preventRecursion: 'extensions.prevent_recursion',
    matchPersonaDescription: 'extensions.match_persona_description',
    matchCharacterDescription: 'extensions.match_character_description',
    matchCharacterPersonality: 'extensions.match_character_personality',
    matchCharacterDepthPrompt: 'extensions.match_character_depth_prompt',
    matchScenario: 'extensions.match_scenario',
    matchCreatorNotes: 'extensions.match_creator_notes',
    delayUntilRecursion: 'extensions.delay_until_recursion',
    probability: 'extensions.probability',
    useProbability: 'extensions.useProbability',
    outletName: 'extensions.outlet_name',
    group: 'extensions.group',
    groupOverride: 'extensions.group_override',
    groupWeight: 'extensions.group_weight',
    scanDepth: 'extensions.scan_depth',
    caseSensitive: 'case_sensitive',
    matchWholeWords: 'extensions.match_whole_words',
    useGroupScoring: 'extensions.use_group_scoring',
    automationId: 'extensions.automation_id',
    sticky: 'extensions.sticky',
    cooldown: 'extensions.cooldown',
    delay: 'extensions.delay',
    triggers: 'extensions.triggers',
    vectorized: 'extensions.vectorized',
    constant: 'constant',
    displayIndex: 'extensions.display_index',
    characterFilter: 'character_filter',
});

/** Exposed for parity tests against world-info.js `originalWIDataKeyMap`. */
export const ORIGINAL_DATA_PATHS = ORIGINAL_PATHS;

/**
 * Mirrors native keys of one entry into its imported CharacterBook record.
 * @param {object} data
 * @param {number|string} uid
 * @param {string[]} keys
 * @param {(data: object, uid: number|string, path: string, value: any) => void} setOriginal
 */
export function mirrorKeys(data, uid, keys, setOriginal) {
    const entry = data.entries[uid];
    const done = new Set();
    for (const key of keys) {
        if (key === 'key' || key === 'keysecondary') {
            if (done.has('keys')) continue;
            done.add('keys');
            const serialized = serializeCharacterBookKeys(entry.key, entry.keysecondary);
            setOriginal(data, uid, 'keys', serialized.keys);
            setOriginal(data, uid, 'secondary_keys', serialized.secondaryKeys);
            setOriginal(data, uid, 'use_regex', serialized.useRegex);
        } else if (key === 'position') {
            setOriginal(data, uid, 'position', entry.position == 0 ? 'before_char' : 'after_char');
            setOriginal(data, uid, 'extensions.position', entry.position);
        } else if (key === 'disable') {
            setOriginal(data, uid, 'enabled', !entry.disable);
        } else if (ORIGINAL_PATHS[key]) {
            setOriginal(data, uid, ORIGINAL_PATHS[key], entry[key]);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Persistence. `deps` wraps world-info.js exports:
// { saveWorldInfo, setOriginal, deleteOriginal, createEntry, duplicateEntry, deleteEntry, moveEntry }

/**
 * Immediate save. Success requires a committed name: `saveWorldInfo(…, true)` returns null for
 * invalid or discarded data and may follow an in-flight rename to a different name.
 * @returns {Promise<{ ok: boolean, name: string|null, error?: unknown }>}
 */
export async function commit(deps, name, data) {
    try {
        const saved = await deps.saveWorldInfo(name, data, true);
        return typeof saved === 'string' && saved ? { ok: true, name: saved } : { ok: false, name: null };
    } catch (error) {
        return { ok: false, name: null, error };
    }
}

const entriesOf = (data, uids) => uids.map(uid => [uid, data?.entries?.[uid]]).filter(([, entry]) => entry);

function originalEntryState(data, uid) {
    const originals = data.originalData?.entries;
    const mapped = data.originalDataUidMap?.[uid];
    const index = Number.isInteger(mapped) && originals?.[mapped]
        ? mapped : originals?.findIndex(entry => String(entry.id ?? entry.uid) === String(uid)) ?? -1;
    const entry = originals?.[index];
    return { originals, index, entry, snapshot: entry && structuredClone(entry), mapped: hasOwn(data.originalDataUidMap, uid) };
}

const mutationKeyOwners = new WeakMap();
const mutationEntryOwners = new WeakMap();

function revertOwnedValues(live, previous, submitted, owns = () => true, prefix = '') {
    for (const key of new Set([...Object.keys(previous), ...Object.keys(submitted)])) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (!owns(path)) continue;
        if (sameValue(previous[key], submitted[key])) continue;
        if (sameValue(live[key], submitted[key])) {
            if (hasOwn(previous, key)) live[key] = structuredClone(previous[key]);
            else delete live[key];
        } else if (live[key] && submitted[key]
            && !Array.isArray(live[key]) && typeof live[key] === 'object'
            && (previous[key] === undefined || (!Array.isArray(previous[key]) && previous[key] && typeof previous[key] === 'object'))
            && !Array.isArray(submitted[key]) && typeof submitted[key] === 'object') {
            revertOwnedValues(live[key], previous[key] ?? {}, submitted[key], owns, path);
            if (!hasOwn(previous, key) && !Object.keys(live[key]).length) delete live[key];
        }
    }
}

/** In-memory compare-and-revert receipt; tracked book and entry identities are never replaced. */
export function captureWorldInfoMutation(data, uids, nativeKeys = null) {
    const owner = { failed: false, previousValues: new WeakMap() };
    const capture = uid => {
        const entry = data.entries[uid];
        return { entry, snapshot: entry && structuredClone(entry), original: originalEntryState(data, uid) };
    };
    const before = new Map([...new Set(uids.map(String))].map(uid => [uid, capture(uid)]));
    let submitted;
    return {
        created(uid) {
            before.set(String(uid), { entry: undefined, original: {} });
        },
        capture() {
            submitted = new Map([...before.keys()].map(uid => [uid, capture(uid)]));
            for (const [uid, written] of submitted) {
                if (!written.entry) continue;
                const owners = mutationKeyOwners.get(written.entry) ?? new Map();
                written.previousKeyOwners = new Map(owners);
                written.previousEntryOwner = mutationEntryOwners.get(written.entry);
                owner.previousValues.set(written.entry, { previous: before.get(uid), owners: written.previousKeyOwners });
                const keys = nativeKeys ?? Object.keys(written.snapshot).filter(key => !sameValue(before.get(uid).snapshot?.[key], written.snapshot[key]));
                for (const key of keys) owners.set(key, owner);
                mutationKeyOwners.set(written.entry, owners);
                mutationEntryOwners.set(written.entry, owner);
            }
        },
        acknowledge() {
            owner.previousValues = null;
        },
        rollback() {
            if (!submitted) throw new Error('World Info mutation has no submitted snapshot.');
            owner.failed = true;
            // One restored imported ID can match another native UID; compare all owners before undoing any.
            const current = new Map([...before.keys()].map(uid => [uid, capture(uid)]));
            for (const [uid, previous] of before) {
                const written = submitted.get(uid);
                const { entry: live, original } = current.get(uid);
                if (live !== written.entry) continue;
                if (!previous.entry) {
                    if (!live || !sameValue(live, written.snapshot)) continue;
                    if (mutationEntryOwners.get(live) !== owner) continue;
                    if (original.entry !== written.original.entry || !sameValue(original.snapshot, written.original.snapshot)) continue;
                    delete data.entries[uid];
                    if (original.entry && original.entry !== previous.original.entry) {
                        const index = original.originals.indexOf(original.entry);
                        original.originals.splice(index, 1);
                        if (data.originalDataUidMap) {
                            delete data.originalDataUidMap[uid];
                            for (const key of Object.keys(data.originalDataUidMap)) {
                                if (data.originalDataUidMap[key] > index) data.originalDataUidMap[key]--;
                            }
                        }
                    }
                    continue;
                }
                if (live) {
                    const owners = mutationKeyOwners.get(live);
                    for (const key of owners.keys()) {
                        if (owners.get(key) !== owner) continue;
                        let baseline = previous;
                        let previousOwner = written.previousKeyOwners.get(key);
                        // A later failure must not restore an earlier operation that has also failed.
                        while (previousOwner?.failed) {
                            const earlier = previousOwner.previousValues?.get(live);
                            if (!earlier?.previous.entry) break;
                            baseline = earlier.previous;
                            previousOwner = earlier.owners.get(key);
                        }
                        revertOwnedValues(live, baseline.snapshot, written.snapshot, path => path === key || path.startsWith(`${key}.`));
                        if (original.entry && original.entry === written.original.entry) {
                            const originalPath = key === 'disable' ? 'enabled' : ORIGINAL_PATHS[key];
                            const ownsOriginal = path => originalPath && (path === originalPath || originalPath.startsWith(`${path}.`) || path.startsWith(`${originalPath}.`));
                            revertOwnedValues(original.entry, baseline.original.snapshot ?? {}, written.original.snapshot ?? {}, ownsOriginal);
                        }
                        if (previousOwner) owners.set(key, previousOwner);
                        else owners.delete(key);
                    }
                    if (mutationEntryOwners.get(live) === owner) {
                        if (written.previousEntryOwner) mutationEntryOwners.set(live, written.previousEntryOwner);
                        else mutationEntryOwners.delete(live);
                    }
                    continue;
                }
                if (original.entry !== written.original.entry || original.mapped !== written.original.mapped
                    || data.originalData?.entries !== previous.original.originals) continue;
                data.entries[uid] = previous.entry;
                if (!previous.original.entry) continue;
                const existingIndex = previous.original.originals.indexOf(previous.original.entry);
                if (existingIndex >= 0) {
                    if (previous.original.mapped && data.originalDataUidMap) data.originalDataUidMap[uid] = existingIndex;
                    continue;
                }
                const index = Math.min(previous.original.index, previous.original.originals.length);
                previous.original.originals.splice(index, 0, previous.original.entry);
                if (data.originalDataUidMap) {
                    for (const key of Object.keys(data.originalDataUidMap)) {
                        if (data.originalDataUidMap[key] >= index) data.originalDataUidMap[key]++;
                    }
                    if (previous.original.mapped) data.originalDataUidMap[uid] = index;
                }
            }
        },
    };
}

async function commitMutation(deps, name, data, receipt) {
    receipt.capture();
    const result = await commit(deps, name, data);
    if (result.ok) receipt.acknowledge();
    else receipt.rollback();
    return result;
}

/** Row and bulk enable switch (D1). */
export async function setEnabled(deps, name, data, uids, enabled) {
    const targets = entriesOf(data, [uids].flat());
    if (!targets.length) return { ok: false, name: null };
    const receipt = captureWorldInfoMutation(data, targets.map(([uid]) => uid), ['disable']);
    for (const [uid, entry] of targets) {
        entry.disable = !enabled;
        mirrorKeys(data, uid, ['disable'], deps.setOriginal);
    }
    return commitMutation(deps, name, data, receipt);
}

/**
 * Drag reorder: assigns consecutive displayIndex values in list order, starting from the lowest
 * existing index among the listed entries.
 */
export async function reorder(deps, name, data, orderedUids) {
    const targets = entriesOf(data, orderedUids);
    if (!targets.length) return { ok: false, name: null };
    const receipt = captureWorldInfoMutation(data, targets.map(([uid]) => uid), ['displayIndex']);
    const start = Math.min(...targets.map(([uid, entry]) => Number.isFinite(entry.displayIndex) ? entry.displayIndex : Number(uid)));
    targets.forEach(([uid, entry], index) => {
        entry.displayIndex = start + index;
        mirrorKeys(data, uid, ['displayIndex'], deps.setOriginal);
    });
    return commitMutation(deps, name, data, receipt);
}

/** @returns {Promise<{ ok: boolean, name: string|null, entry?: object }>} */
export async function createEntry(deps, name, data, fields = {}) {
    const entry = deps.createEntry(name, data);
    if (!entry) return { ok: false, name: null };
    const keys = Object.keys(fields).filter(key => EDITABLE_KEYS.includes(key));
    for (const key of keys) entry[key] = structuredClone(fields[key]);
    mirrorKeys(data, entry.uid, keys, deps.setOriginal);
    return { ...await commit(deps, name, data), entry };
}

export async function duplicate(deps, name, data, uid) {
    const receipt = captureWorldInfoMutation(data, []);
    const entry = deps.duplicateEntry(data, uid);
    if (!entry) return { ok: false, name: null };
    receipt.created(entry.uid);
    return { ...await commitMutation(deps, name, data, receipt), entry };
}

/**
 * Deletes entries without the legacy per-entry confirmation (the caller confirms once) and removes
 * their originalData records.
 */
export async function remove(deps, name, data, uids) {
    const receipt = captureWorldInfoMutation(data, [uids].flat());
    let removed = 0;
    for (const uid of [uids].flat()) {
        if (await deps.deleteEntry(data, uid, { silent: true }) === true) {
            deps.deleteOriginal(data, uid);
            removed++;
        }
    }
    if (!removed) return { ok: false, name: null, removed };
    return { ...await commitMutation(deps, name, data, receipt), removed };
}

/** Move or copy entries; `moveWorldInfoEntry` loads and saves both books itself. */
export async function move(deps, sourceName, targetName, uids, { copy = false } = {}) {
    let moved = 0;
    for (const uid of [uids].flat()) {
        if (await deps.moveEntry(sourceName, targetName, uid, { deleteOriginal: !copy })) moved++;
    }
    return { ok: moved > 0, moved };
}

// ---------------------------------------------------------------------------------------------
// Row display helpers

/** Desktop title rule: comment, else all primary keys, else `fallback` ("Untitled entry"). */
export function entryTitle(entry, fallback = 'Untitled entry') {
    if (entry?.comment) return String(entry.comment);
    const keys = arrayOf(entry?.key);
    return keys.length ? keys.join(', ') : fallback;
}

export function entryKeyPreview(entry, limit = 100) {
    return arrayOf(entry?.key).join(', ').slice(0, limit);
}

export const entryStrategy = strategyOf;

/** Compact position·order badge, e.g. "@D 🤖 4 · 100" or "↑Char · 100". */
export function entryBadge(entry) {
    const value = positionValue(entry);
    const option = POSITION_OPTIONS.find(item => item.value === value);
    const position = option ? option.label : value;
    const depth = Number(entry?.position) === WI_POSITION.atDepth && entry?.depth !== null && entry?.depth !== undefined ? ` ${entry.depth}` : '';
    return `${position}${depth} · ${parseOrder(entry?.order ?? 0)}`;
}
