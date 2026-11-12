/* eslint-disable playwright/no-standalone-expect -- These are parameterised Jest tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import lodash from 'lodash';

import * as model from '../public/scripts/sillybunny-world-info-model.js';

const worldInfoSource = readFileSync(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function functionSource(name) {
    const match = worldInfoSource.match(new RegExp(`^(?:export )?((?:async )?function ${name}\\([\\s\\S]*?^})`, 'm'));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[1];
}

function objectLiteralSource(name) {
    const match = worldInfoSource.match(new RegExp(`export const ${name} = (\\{[\\s\\S]*?^\\});`, 'm'));
    if (!match) throw new Error(`Missing object literal ${name}`);
    return match[1];
}

function evaluateObjectLiteral(name) {
    return vm.runInNewContext(`(${objectLiteralSource(name)})`);
}

function definitionKeys() {
    const source = objectLiteralSource('newWorldInfoEntryDefinition');
    return [...source.matchAll(/^[ ]{4}([A-Za-z_$][\w$]*): \{/gm)].map(([, key]) => key);
}

function selectOptionAttributes(name) {
    const select = indexSource.match(new RegExp(`<select\\b(?=[^>]*\\bname=["']${name}["'])[^>]*>([\\s\\S]*?)<\\/select>`));
    if (!select) throw new Error(`Missing select[name="${name}"]`);
    return [...select[1].matchAll(/<option\b([^>]*)>/g)].map(([, attributes]) => {
        const value = attributes.match(/\bvalue="([^"]*)"/);
        const role = attributes.match(/\bdata-role="([^"]*)"/);
        return { value: value?.[1], role: role?.[1] };
    });
}

function createLegacyHelpers() {
    const context = vm.createContext({ setValueByPath: lodash.set });
    const helpers = ['getWIOriginalDataIndex', 'setWIOriginalDataValue', 'deleteWIOriginalDataValue', 'parseRegexFromString'];
    vm.runInContext(helpers.map(functionSource).join('\n'), context);
    return context;
}

function importedBook() {
    return {
        entries: {
            0: {
                uid: 0,
                key: ['old'],
                keysecondary: [],
                comment: 'Old title',
                content: 'Old content',
                constant: false,
                vectorized: false,
                disable: false,
                position: 0,
                role: null,
                probability: 100,
                useProbability: false,
                caseSensitive: null,
                useGroupScoring: null,
                groupWeight: 100,
                delayUntilRecursion: 0,
            },
            3: { uid: 3, comment: 'Second entry', content: 'Other content' },
        },
        originalData: {
            entries: [
                { id: 7, keys: ['old'], extensions: {} },
                { id: 9, content: 'Other content', extensions: {} },
            ],
        },
        originalDataUidMap: { 0: 0, 3: 1 },
    };
}

function applyField(data, uid, field, value, setOriginal) {
    const entry = data.entries[uid];
    const baseline = model.entryToDraft(entry);
    const draft = model.entryToDraft(entry);
    model.writeField(draft, field, value);
    return model.applyDraft(data, uid, baseline, draft, { setOriginal });
}

function createDeps(overrides = {}) {
    return {
        saveWorldInfo: jest.fn(async name => name),
        setOriginal: jest.fn(),
        deleteOriginal: jest.fn(),
        createEntry: jest.fn(),
        duplicateEntry: jest.fn(),
        deleteEntry: jest.fn(),
        moveEntry: jest.fn(),
        ...overrides,
    };
}

describe('World Info schema parity', () => {
    test('placement metadata keeps bar fields and the list switch out of the body without changing key coverage', () => {
        expect(model.FIELDS.filter(field => field.placement === 'bar').map(field => field.id)).toEqual(['strategy', 'position', 'depth', 'outletName', 'order', 'probability']);
        expect(model.FIELD_BY_ID.get('enabled').placement).toBe('list');
        expect(model.FIELD_BY_ID.get('position').keys).toEqual(['position', 'role']);
        expect(model.FIELD_BY_ID.get('probability').keys).toEqual(['probability', 'useProbability']);
    });

    test('definition coverage contains every upstream definition key and no extras', () => {
        const upstreamKeys = definitionKeys().sort();
        const coveredKeys = Object.keys(model.DEFINITION_COVERAGE).sort();
        expect(coveredKeys).toEqual(upstreamKeys);

        const fieldCoverage = Object.values(model.DEFINITION_COVERAGE).filter(coverage => coverage !== 'preserve');
        expect(fieldCoverage.every(coverage => model.FIELD_BY_ID.has(coverage))).toBe(true);

        const definitionKeySet = new Set(upstreamKeys);
        for (const key of model.EDITABLE_KEYS) {
            expect(definitionKeySet.has(key) || key === 'characterFilter').toBe(true);
        }
    });

    test('World Info enums and legacy select options stay in parity', () => {
        expect(model.WI_POSITION).toEqual(evaluateObjectLiteral('world_info_position'));
        expect(model.WI_LOGIC).toEqual(evaluateObjectLiteral('world_info_logic'));

        const htmlPositionValues = selectOptionAttributes('position').map(option => option.value);
        const modelPositionValues = model.POSITION_OPTIONS.map(option => option.value.split(':')[0]);
        expect([...new Set(modelPositionValues)].sort()).toEqual([...new Set(htmlPositionValues)].sort());

        const htmlDepthRoles = selectOptionAttributes('position')
            .filter(option => option.value === '4')
            .map(option => option.role);
        const modelDepthRoles = model.POSITION_OPTIONS
            .filter(option => option.value.startsWith('4:'))
            .map(option => option.value.split(':')[1]);
        expect(modelDepthRoles).toEqual(htmlDepthRoles);

        expect(model.LOGIC_OPTIONS.map(option => option.value)).toEqual(
            selectOptionAttributes('entryLogicType').map(option => option.value),
        );
    });

    test('originalData paths match the upstream key map wherever both define a key', () => {
        const upstreamMap = evaluateObjectLiteral('originalWIDataKeyMap');
        const sharedPaths = Object.fromEntries(Object.entries(model.ORIGINAL_DATA_PATHS)
            .filter(([key]) => Object.hasOwn(upstreamMap, key)));
        for (const [key, path] of Object.entries(sharedPaths)) {
            expect(path).toBe(upstreamMap[key]);
        }
    });
});

describe('legacy originalData mirroring', () => {
    const legacy = createLegacyHelpers();
    const setOriginal = legacy.setWIOriginalDataValue;

    test('edits mirror native fields to exact imported CharacterBook paths, including UID zero', () => {
        const data = importedBook();
        data.entries[0].vectorized = true;
        data.entries[0].useGroupScoring = true;

        applyField(data, 0, 'comment', 'New title', setOriginal);
        applyField(data, 0, 'content', 'New content', setOriginal);
        applyField(data, 0, 'strategy', 'constant', setOriginal);
        applyField(data, 0, 'position', '4:1', setOriginal);
        applyField(data, 0, 'enabled', false, setOriginal);
        applyField(data, 0, 'probability', '', setOriginal);
        applyField(data, 0, 'caseSensitive', 'true', setOriginal);
        applyField(data, 0, 'useGroupScoring', 'null', setOriginal);
        applyField(data, 0, 'groupWeight', '1e9', setOriginal);
        applyField(data, 0, 'delayUntilRecursion', true, setOriginal);
        applyField(data, 0, 'triggers', ['normal', 'continue'], setOriginal);

        expect(data.originalData.entries[0]).toEqual({
            id: 7,
            keys: ['old'],
            comment: 'New title',
            content: 'New content',
            constant: true,
            position: 'after_char',
            extensions: {
                vectorized: false,
                position: 4,
                role: 1,
                probability: null,
                useProbability: true,
                use_group_scoring: null,
                group_weight: 999999,
                delay_until_recursion: true,
                triggers: ['normal', 'continue'],
            },
            enabled: false,
            case_sensitive: true,
        });
        expect(data.originalData.entries[1]).toEqual({ id: 9, content: 'Other content', extensions: {} });
    });

    test('switching from constant to vectorized mirrors both strategy flags', () => {
        const data = importedBook();
        data.entries[0].constant = true;
        applyField(data, 0, 'strategy', 'vectorized', setOriginal);
        expect(data.originalData.entries[0]).toEqual({
            id: 7,
            keys: ['old'],
            constant: false,
            extensions: { vectorized: true },
        });
    });

    test('key fields serialize mixed and all-regex keyword modes', () => {
        const data = importedBook();
        const baseline = model.entryToDraft(data.entries[0]);
        const mixedDraft = model.entryToDraft(data.entries[0]);
        mixedDraft.key = ['plain', '/cat/i'];
        mixedDraft.keysecondary = ['/dog/'];
        model.applyDraft(data, 0, baseline, mixedDraft, { setOriginal });

        expect(data.originalData.entries[0]).toMatchObject({
            keys: ['plain', '/cat/i'],
            secondary_keys: ['/dog/'],
            use_regex: false,
        });

        const regexBaseline = model.entryToDraft(data.entries[0]);
        const regexDraft = model.entryToDraft(data.entries[0]);
        regexDraft.key = ['/cat/i'];
        regexDraft.keysecondary = ['/dog/'];
        model.applyDraft(data, 0, regexBaseline, regexDraft, { setOriginal });
        expect(data.originalData.entries[0]).toMatchObject({
            keys: ['/cat/i'],
            secondary_keys: ['dog'],
            use_regex: true,
        });
    });

    test('position returns to before-character and clears the role in originalData', () => {
        const data = importedBook();
        applyField(data, 0, 'position', '4:1', setOriginal);
        applyField(data, 0, 'position', '0', setOriginal);
        expect(data.originalData.entries[0]).toMatchObject({
            position: 'before_char',
            extensions: { position: 0, role: null },
        });
        expect(data.entries[0]).toMatchObject({ position: 0, role: null });
    });

    test('characterFilter is mirrored when populated and becomes undefined when cleared', () => {
        const data = importedBook();
        applyField(data, 0, 'characterFilter', {
            enabled: true,
            isExclude: false,
            names: ['Alice'],
            tags: ['friends'],
        }, setOriginal);
        expect(data.originalData.entries[0].character_filter).toEqual({
            isExclude: false,
            names: ['Alice'],
            tags: ['friends'],
        });

        applyField(data, 0, 'characterFilter', {
            enabled: false,
            isExclude: false,
            names: [],
            tags: [],
        }, setOriginal);
        expect(data.entries[0]).not.toHaveProperty('characterFilter');
        expect(data.originalData.entries[0].character_filter).toBeUndefined();
    });

    test('non-imported books are unchanged and deleting UID zero compacts the original UID map', () => {
        const native = { entries: { 0: { uid: 0, comment: 'Old' } } };
        applyField(native, 0, 'comment', 'New', setOriginal);
        expect(native).not.toHaveProperty('originalData');

        const data = importedBook();
        legacy.deleteWIOriginalDataValue(data, 0);
        expect(data.originalData.entries.map(entry => entry.id)).toEqual([9]);
        expect(data.originalDataUidMap).toEqual({ 3: 0 });
    });
});

describe('draft tracking and field writers', () => {
    test('drafts deep-clone known and unknown properties', () => {
        const entry = { uid: 0, comment: 'Title', extensions: { nested: { value: 1 } }, displayIndex: 2, foo: { bar: true } };
        const draft = model.entryToDraft(entry);
        draft.extensions.nested.value = 8;
        draft.foo.bar = false;

        expect(entry.extensions.nested.value).toBe(1);
        expect(entry.foo.bar).toBe(true);
        expect(draft).toMatchObject({ uid: 0, displayIndex: 2, foo: { bar: false } });
    });

    test('changedKeys ignores unchanged keys and equates absent with undefined', () => {
        expect(model.changedKeys({ comment: 'same', content: undefined }, { comment: 'same' }, ['comment', 'content']))
            .toEqual([]);
        expect(model.changedKeys({ comment: 'old' }, { comment: 'new' }, ['comment'])).toEqual(['comment']);
    });

    test('applyDraft mutates the tracked entry, writes only dirty keys, and preserves external edits', () => {
        const entry = { uid: 0, comment: 'Old', content: 'Original content', characterFilter: { names: ['A'] }, foo: 'kept' };
        const data = { entries: { 0: entry } };
        const baseline = model.entryToDraft(entry);
        const draft = model.entryToDraft(entry);
        model.writeField(draft, 'comment', 'New');
        model.writeField(draft, 'characterFilter', { enabled: false });
        entry.content = 'External update';

        const setOriginal = jest.fn();
        expect(model.applyDraft(data, 0, baseline, draft, { setOriginal }).sort()).toEqual(['characterFilter', 'comment']);
        expect(data.entries[0]).toBe(entry);
        expect(entry).toMatchObject({ comment: 'New', content: 'External update', foo: 'kept' });
        expect(entry).not.toHaveProperty('characterFilter');
        expect(setOriginal).toHaveBeenCalledWith(data, 0, 'character_filter', undefined);
    });

    test('applyDraft rejects a disappeared entry', () => {
        expect(() => model.applyDraft({ entries: {} }, 0, {}, {}, { setOriginal: jest.fn() }))
            .toThrow('World Info entry 0 no longer exists');
    });

    test('numeric and nullable field writers preserve their legacy parsing rules', () => {
        const entry = {};
        for (const [raw, expected] of [['', 0], ['x', 0], ['5.5', 5.5]]) {
            model.writeField(entry, 'order', raw);
            expect(entry.order).toBe(expected);
        }
        for (const [raw, expected] of [['', null], ['0', 0]]) {
            model.writeField(entry, 'depth', raw);
            expect(entry.depth).toBe(expected);
        }
        for (const [raw, expected] of [['-3', 0], ['2000', 1000], ['4.7', 4], ['', null]]) {
            model.writeField(entry, 'scanDepth', raw);
            expect(entry.scanDepth).toBe(expected);
        }
        for (const [raw, expected] of [['', null], ['150', 100], ['-1', 0]]) {
            model.writeField(entry, 'probability', raw);
            expect(entry.probability).toBe(expected);
            expect(entry.useProbability).toBe(true);
        }
        for (const [raw, expected] of [['0', 1], ['1e9', 999999], ['', null]]) {
            model.writeField(entry, 'groupWeight', raw);
            expect(entry.groupWeight).toBe(expected);
        }
        for (const field of ['sticky', 'cooldown', 'delay']) {
            model.writeField(entry, field, '');
            expect(entry[field]).toBeNull();
            model.writeField(entry, field, '0');
            expect(entry[field]).toBe(0);
        }
    });

    test('tri-state, logic, strategy, and position controls parse and read back legacy values', () => {
        const entry = {};
        for (const [raw, expected] of [['null', null], ['true', true], ['false', false], ['garbage', false]]) {
            model.writeField(entry, 'caseSensitive', raw);
            expect(entry.caseSensitive).toBe(expected);
        }
        expect(model.readField({}, 'caseSensitive')).toBe('null');

        model.writeField(entry, 'selectiveLogic', 'x');
        expect(entry.selectiveLogic).toBe(0);

        entry.constant = true;
        entry.vectorized = true;
        expect(model.readField(entry, 'strategy')).toBe('constant');
        model.writeField(entry, 'strategy', 'unknown');
        expect(entry).toMatchObject({ constant: true, vectorized: true });

        model.writeField(entry, 'position', '4:2');
        expect(entry).toMatchObject({ position: 4, role: 2 });
        model.writeField(entry, 'position', '7');
        expect(entry).toMatchObject({ position: 7, role: null });
        model.writeField(entry, 'position', 'garbage');
        expect(entry).toMatchObject({ position: 0, role: null });
    });

    test('recursion switches and level input keep the legacy value transitions', () => {
        const entry = { delayUntilRecursion: false };
        model.writeField(entry, 'delayUntilRecursion', true);
        expect(entry.delayUntilRecursion).toBe(true);
        entry.delayUntilRecursion = 3;
        model.writeField(entry, 'delayUntilRecursion', true);
        expect(entry.delayUntilRecursion).toBe(3);
        model.writeField(entry, 'delayUntilRecursion', false);
        expect(entry.delayUntilRecursion).toBe(false);

        for (const [current, raw, expected] of [
            [true, '', true],
            [3, '', true],
            [false, '1', true],
            [false, '1.0', true],
            [false, '3', 3],
            [false, '2.5', false],
            [false, '0', false],
            [false, '-2', false],
            [false, 'abc', false],
        ]) {
            entry.delayUntilRecursion = current;
            model.writeField(entry, 'recursionLevel', raw);
            expect(entry.delayUntilRecursion).toBe(expected);
        }
        expect(model.readField({ delayUntilRecursion: true }, 'recursionLevel')).toBe('');
        expect(model.readField({ delayUntilRecursion: 3 }, 'recursionLevel')).toBe('3');
    });

    test('groups and character filters use chip-compatible values and empty-filter rules', () => {
        const entry = {};
        model.writeField(entry, 'group', ['a', ' b ', '']);
        expect(entry.group).toBe('a, b');
        expect(model.readField({ group: 'a,b, c' }, 'group')).toEqual(['a', 'b', 'c']);

        model.writeField(entry, 'characterFilter', { enabled: false, names: ['A'] });
        expect(entry).not.toHaveProperty('characterFilter');
        model.writeField(entry, 'characterFilter', { enabled: true, isExclude: false, names: [], tags: [] });
        expect(entry).not.toHaveProperty('characterFilter');
        model.writeField(entry, 'characterFilter', { enabled: true, isExclude: true, names: [], tags: [] });
        expect(entry.characterFilter).toEqual({ isExclude: true, names: [], tags: [] });
        model.writeField(entry, 'characterFilter', { enabled: true, names: ['A'], tags: ['friend'] });
        expect(entry.characterFilter).toEqual({ isExclude: false, names: ['A'], tags: ['friend'] });
        expect(model.readField({ characterFilter: { isExclude: false, names: [], tags: [] } }, 'characterFilter').enabled)
            .toBe(false);
    });

    test('unknown field IDs and the read-only UID fail with RangeError', () => {
        expect(() => model.readField({}, 'missing')).toThrow(RangeError);
        expect(() => model.writeField({}, 'missing', 'value')).toThrow(RangeError);
        expect(() => model.writeField({ uid: 0 }, 'uid', '1')).toThrow(RangeError);
        expect(model.readField({ uid: 0 }, 'uid')).toBe('0');
    });

    test('conditional field visibility follows position, secondary keys, and recursion state', () => {
        expect(model.isFieldVisible({ position: 4 }, 'depth')).toBe(true);
        expect(model.isFieldVisible({ position: 0 }, 'depth')).toBe(false);
        expect(model.isFieldVisible({ position: 7 }, 'outletName')).toBe(true);
        expect(model.isFieldVisible({ position: 4 }, 'outletName')).toBe(false);
        expect(model.isFieldVisible({ selective: true }, 'keysecondary')).toBe(true);
        expect(model.isFieldVisible({}, 'keysecondary')).toBe(true);
        expect(model.isFieldVisible({ selective: false }, 'keysecondary')).toBe(false);
        expect(model.isFieldVisible({ keysecondary: ['optional'] }, 'selectiveLogic')).toBe(true);
        expect(model.isFieldVisible({ keysecondary: [] }, 'selectiveLogic')).toBe(false);
        expect(model.isFieldVisible({ selective: false, keysecondary: ['optional'] }, 'selectiveLogic')).toBe(false);
        expect(model.isFieldVisible({ delayUntilRecursion: 2 }, 'recursionLevel')).toBe(true);
        expect(model.isFieldVisible({ delayUntilRecursion: false }, 'recursionLevel')).toBe(false);
    });
});

describe('keyword parsing', () => {
    const parseLegacyRegex = createLegacyHelpers().parseRegexFromString;

    test.each(['/a/', '/a/gi', '//', '/a/d', '/a\\/b/', '/a/b/', 'plain', '/a,b/i', '/(/'])(
        'parseKeywordRegex matches legacy acceptance for %s', input => {
            const actual = model.parseKeywordRegex(input);
            const expected = parseLegacyRegex(input);
            expect(actual?.source ?? null).toBe(expected?.source ?? null);
            expect(actual?.flags ?? null).toBe(expected?.flags ?? null);
        },
    );

    test.each([
        ['a,b', ['a', 'b']],
        ['/a,b/, c', ['/a,b/', 'c']],
        ['a,/b,c/,d', ['a', '/b,c/', 'd']],
        ['a,,b', ['a', 'b']],
        ['/a,b', ['/a,b']],
        ['/a,b/x, y', ['/a', 'b/x', 'y']],
        ['x/y,z', ['x/y', 'z']],
        ['/a,', ['/a,']],
        ['a,', ['a']],
        ['/a\\/b,c/', ['/a\\/b,c/']],
    ])('splitKeywords(%s) returns pending/chip tokens', (input, expected) => {
        expect(model.splitKeywords(input)).toEqual(expected);
    });
});

describe('draft rebasing and external change detection', () => {
    test('a clean field follows live data while a dirty field stays in the draft', () => {
        const entry = { comment: 'live', content: 'new content' };
        const baseline = { comment: 'old', content: 'old content' };
        const draft = { comment: 'user edit', content: 'old content' };

        expect(model.rebaseKey(entry, baseline, draft, 'content')).toBe(true);
        expect(baseline.content).toBe('new content');
        expect(draft.content).toBe('new content');

        expect(model.rebaseKey(entry, baseline, draft, 'comment')).toBe(false);
        expect(baseline.comment).toBe('live');
        expect(draft.comment).toBe('user edit');
        expect(model.changedKeys(baseline, draft, ['comment'])).toEqual(['comment']);
    });

    test('rebasing an undefined live key removes it from baseline and clean draft', () => {
        const baseline = { comment: 'old' };
        const draft = { comment: 'old' };
        expect(model.rebaseKey({}, baseline, draft, 'comment')).toBe(true);
        expect(baseline).not.toHaveProperty('comment');
        expect(draft).not.toHaveProperty('comment');
    });

    test('externalChanges lists live editable values changed since the baseline', () => {
        const baseline = { comment: 'same', content: 'before', foo: 'old' };
        const live = { comment: 'same', content: 'after', foo: 'new' };
        expect(model.externalChanges(live, baseline)).toEqual(['content']);
    });
});

describe('persistence operations', () => {
    test('bulk delete rollback preserves imported/native ID collisions and original entry identities', async () => {
        const data = importedBook();
        data.originalData.entries[0].id = 3;
        data.originalData.entries[1].id = 0;
        const before = structuredClone(data);
        const first = data.originalData.entries[0];
        const second = data.originalData.entries[1];
        const legacy = createLegacyHelpers();
        const deps = createDeps({
            deleteOriginal: legacy.deleteWIOriginalDataValue,
            deleteEntry: async (book, uid) => { delete book.entries[uid]; return true; },
            saveWorldInfo: jest.fn().mockResolvedValue(null),
        });
        expect((await model.remove(deps, 'Lore', data, [0, 3])).ok).toBe(false);
        expect(data).toEqual(before);
        expect(data.originalData.entries[0]).toBe(first);
        expect(data.originalData.entries[1]).toBe(second);
    });

    test.each(['toggle', 'reorder', 'delete', 'duplicate'])('failed %s is absent from a later unrelated save, including imported data', async action => {
        const legacy = createLegacyHelpers();
        const data = importedBook();
        data.entries[0].displayIndex = 0;
        data.entries[3].displayIndex = 1;
        data.originalData.entries[0].enabled = true;
        data.originalData.entries[0].extensions.display_index = 0;
        data.originalData.entries[1].extensions.display_index = 1;
        const before = structuredClone(data);
        const deps = createDeps({
            setOriginal: legacy.setWIOriginalDataValue,
            deleteOriginal: legacy.deleteWIOriginalDataValue,
            deleteEntry: async (book, uid) => { delete book.entries[uid]; return true; },
            duplicateEntry: book => {
                const entry = { ...structuredClone(book.entries[0]), uid: 1 };
                book.entries[1] = entry;
                book.originalDataUidMap[1] = book.originalData.entries.length;
                book.originalData.entries.push({ id: 10, comment: entry.comment });
                return entry;
            },
            saveWorldInfo: jest.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue('Lore'),
        });
        const operations = {
            toggle: () => model.setEnabled(deps, 'Lore', data, 0, false),
            reorder: () => model.reorder(deps, 'Lore', data, [3, 0]),
            delete: () => model.remove(deps, 'Lore', data, [0, 3]),
            duplicate: () => model.duplicate(deps, 'Lore', data, 0),
        };
        expect((await operations[action]()).ok).toBe(false);
        expect(data).toEqual(before);
        applyField(data, 3, 'content', 'Unrelated saved edit', deps.setOriginal);
        expect((await model.commit(deps, 'Lore', data)).ok).toBe(true);
        before.entries[3].content = 'Unrelated saved edit';
        before.originalData.entries[1].content = 'Unrelated saved edit';
        expect(data).toEqual(before);
    });

    test('rollback preserves newer field writers and replacement entries', async () => {
        const legacy = createLegacyHelpers();
        const data = importedBook();
        let reject;
        const deps = createDeps({
            setOriginal: legacy.setWIOriginalDataValue,
            saveWorldInfo: jest.fn(() => new Promise((_resolve, fail) => { reject = fail; })),
        });
        const saving = model.setEnabled(deps, 'Lore', data, [0, 3], false);
        data.entries[0].disable = false;
        deps.setOriginal(data, 0, 'enabled', true);
        const replacement = { uid: 3, disable: true, content: 'New writer' };
        data.entries[3] = replacement;
        reject(new Error('Offline'));
        expect((await saving).ok).toBe(false);
        expect(data.entries[0].disable).toBe(false);
        expect(data.originalData.entries[0].enabled).toBe(true);
        expect(data.entries[3]).toBe(replacement);
    });

    test('a newer acknowledged switch owns even the same value while unrelated keys can still roll back', async () => {
        const data = importedBook();
        const legacy = createLegacyHelpers();
        let reject;
        const deps = createDeps({
            setOriginal: legacy.setWIOriginalDataValue,
            saveWorldInfo: jest.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
                .mockResolvedValue('Lore'),
        });
        const failing = model.setEnabled(deps, 'Lore', data, [0, 3], false);
        expect((await model.setEnabled(deps, 'Lore', data, 0, false)).ok).toBe(true);
        reject(new Error('Offline'));
        expect((await failing).ok).toBe(false);
        expect(data.entries[0].disable).toBe(true);
        expect(data.originalData.entries[0].enabled).toBe(false);
        expect(data.entries[3]).not.toHaveProperty('disable');
    });

    test('failed reorder removes only its newly created imported path beside a newer extension writer', async () => {
        const data = importedBook();
        delete data.originalData.entries[0].extensions;
        const legacy = createLegacyHelpers();
        let reject;
        const deps = createDeps({
            setOriginal: legacy.setWIOriginalDataValue,
            saveWorldInfo: () => new Promise((_resolve, fail) => { reject = fail; }),
        });
        const saving = model.reorder(deps, 'Lore', data, [0, 3]);
        legacy.setWIOriginalDataValue(data, 0, 'extensions.newer', 'preserved');
        reject(new Error('Offline'));
        expect((await saving).ok).toBe(false);
        expect(data.entries[0]).not.toHaveProperty('displayIndex');
        expect(data.originalData.entries[0].extensions).toEqual({ newer: 'preserved' });
    });

    test.each([true, false])('successive failed switches release ownership in either completion order (newest first=%s)', async newestFirst => {
        const data = importedBook();
        data.originalData.entries[0].enabled = true;
        const legacy = createLegacyHelpers();
        const failures = [];
        const deps = createDeps({
            setOriginal: legacy.setWIOriginalDataValue,
            saveWorldInfo: () => new Promise((_resolve, reject) => failures.push(reject)),
        });
        const first = model.setEnabled(deps, 'Lore', data, 0, false);
        const second = model.setEnabled(deps, 'Lore', data, 0, true);
        failures[newestFirst ? 1 : 0](new Error('Offline'));
        await (newestFirst ? second : first);
        failures[newestFirst ? 0 : 1](new Error('Offline'));
        await (newestFirst ? first : second);
        expect(data.entries[0].disable).toBe(false);
        expect(data.originalData.entries[0].enabled).toBe(true);
    });

    test.each(['delete', 'duplicate'])('failed %s preserves a newer entry writer and consistent imported UID mappings', async action => {
        const data = importedBook();
        const legacy = createLegacyHelpers();
        let reject;
        const deps = createDeps({
            deleteOriginal: legacy.deleteWIOriginalDataValue,
            deleteEntry: async (book, uid) => { delete book.entries[uid]; return true; },
            duplicateEntry: book => {
                const entry = { uid: 1, content: 'Copy' };
                book.entries[1] = entry;
                book.originalDataUidMap[1] = book.originalData.entries.length;
                book.originalData.entries.push({ id: 10, content: 'Copy' });
                return entry;
            },
            saveWorldInfo: () => new Promise((_resolve, fail) => { reject = fail; }),
        });
        const saving = action === 'delete' ? model.remove(deps, 'Lore', data, 0) : model.duplicate(deps, 'Lore', data, 0);
        for (let index = 0; index < 10; index++) await Promise.resolve();
        const uid = action === 'delete' ? 0 : 1;
        if (action === 'delete') {
            data.entries[uid] = { uid, content: 'Replacement' };
            data.originalDataUidMap[uid] = data.originalData.entries.length;
            data.originalData.entries.push({ id: 11, content: 'Replacement' });
        } else {
            data.entries[uid].content = 'Replacement';
            legacy.setWIOriginalDataValue(data, uid, 'content', 'Replacement');
        }
        reject(new Error('Offline'));
        expect((await saving).ok).toBe(false);
        expect(data.entries[uid].content).toBe('Replacement');
        expect(data.originalData.entries[data.originalDataUidMap[uid]].content).toBe('Replacement');
        expect(data.originalData.entries[data.originalDataUidMap[3]].id).toBe(9);
    });

    test.each([true, false])('failed transfer target rolls back copy=%s before an unrelated successful save', async copy => {
        const source = importedBook();
        const target = importedBook();
        const beforeSource = structuredClone(source);
        const beforeTarget = structuredClone(target);
        const legacy = createLegacyHelpers();
        const saveWorldInfo = jest.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue('Archive');
        const move = vm.runInNewContext(`${functionSource('moveWorldInfoEntry')}\nmoveWorldInfoEntry;`, {
            world_names: ['Lore', 'Archive'],
            loadWorldInfo: async name => name === 'Lore' ? source : target,
            structuredClone, captureWorldInfoMutation: model.captureWorldInfoMutation,
            getWIOriginalDataIndex: legacy.getWIOriginalDataIndex,
            deleteWIOriginalDataValue: legacy.deleteWIOriginalDataValue,
            getFreeWorldEntryUid: () => 1,
            appendWIOriginalDataEntry: (book, entry) => {
                book.originalDataUidMap[entry.uid] = book.originalData.entries.length;
                book.originalData.entries.push({ id: 10, content: entry.content });
            },
            saveWorldInfo, toastr: { error() {} }, console: { error() {} },
            t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), ''),
        });
        expect(await move('Lore', 'Archive', 0, { deleteOriginal: !copy })).toBe(false);
        expect(source).toEqual(beforeSource);
        expect(target).toEqual(beforeTarget);
        applyField(target, 3, 'content', 'Unrelated edit', legacy.setWIOriginalDataValue);
        expect((await model.commit({ saveWorldInfo }, 'Archive', target)).ok).toBe(true);
        expect(target.entries[1]).toBeUndefined();
        expect(target.originalData.entries).toHaveLength(2);
    });

    test('failed move source restores only its deletion after the target copy was acknowledged', async () => {
        const source = importedBook();
        const target = importedBook();
        const before = structuredClone(source);
        const legacy = createLegacyHelpers();
        const move = vm.runInNewContext(`${functionSource('moveWorldInfoEntry')}\nmoveWorldInfoEntry;`, {
            world_names: ['Lore', 'Archive'], loadWorldInfo: async name => name === 'Lore' ? source : target,
            structuredClone, captureWorldInfoMutation: model.captureWorldInfoMutation,
            getWIOriginalDataIndex: legacy.getWIOriginalDataIndex,
            deleteWIOriginalDataValue: legacy.deleteWIOriginalDataValue,
            getFreeWorldEntryUid: () => 1,
            appendWIOriginalDataEntry: (book, entry) => {
                book.originalDataUidMap[entry.uid] = book.originalData.entries.length;
                book.originalData.entries.push({ id: 10, content: entry.content });
            },
            saveWorldInfo: jest.fn().mockResolvedValueOnce('Archive').mockResolvedValueOnce(null),
            toastr: { error() {} }, console: { error() {} },
            t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (values[index] ?? ''), ''),
        });
        expect(await move('Lore', 'Archive', 0)).toBe(false);
        expect(source).toEqual(before);
        expect(target.entries[1].content).toBe(source.entries[0].content);
        expect(target.originalDataUidMap[1]).toBe(2);
    });

    test.each([
        ['Lore', { ok: true, name: 'Lore' }],
        ['Lore 2', { ok: true, name: 'Lore 2' }],
        [null, { ok: false, name: null }],
        [undefined, { ok: false, name: null }],
        ['', { ok: false, name: null }],
    ])('commit reports a string save result: %s', async (saved, expected) => {
        const deps = createDeps({ saveWorldInfo: jest.fn(async () => saved) });
        const data = { entries: {} };
        await expect(model.commit(deps, 'Lore', data)).resolves.toEqual(expected);
        expect(deps.saveWorldInfo).toHaveBeenCalledWith('Lore', data, true);
    });

    test('commit resolves a failed save result and preserves a rejection error', async () => {
        const error = new Error('Offline');
        const deps = createDeps({ saveWorldInfo: jest.fn().mockRejectedValue(error) });
        await expect(model.commit(deps, 'Lore', { entries: {} })).resolves.toEqual({ ok: false, name: null, error });
    });

    test('setEnabled supports one and many UIDs, mirrors enabled, and commits once', async () => {
        const data = { entries: { 0: { uid: 0, disable: true }, 3: { uid: 3, disable: false } } };
        const deps = createDeps();

        await expect(model.setEnabled(deps, 'Lore', data, 0, true)).resolves.toEqual({ ok: true, name: 'Lore' });
        expect(data.entries[0].disable).toBe(false);
        expect(deps.setOriginal).toHaveBeenCalledWith(data, 0, 'enabled', true);
        expect(deps.saveWorldInfo).toHaveBeenCalledTimes(1);

        deps.setOriginal.mockClear();
        deps.saveWorldInfo.mockClear();
        await model.setEnabled(deps, 'Lore', data, [0, 3, 99], false);
        expect(data.entries[0].disable).toBe(true);
        expect(data.entries[3].disable).toBe(true);
        expect(deps.setOriginal).toHaveBeenCalledTimes(2);
        expect(deps.setOriginal).toHaveBeenCalledWith(data, 0, 'enabled', false);
        expect(deps.setOriginal).toHaveBeenCalledWith(data, 3, 'enabled', false);
        expect(deps.saveWorldInfo).toHaveBeenCalledTimes(1);
    });

    test('setEnabled skips missing UIDs and avoids saving when all are missing', async () => {
        const data = { entries: { 0: { uid: 0, disable: false } } };
        const deps = createDeps();
        const result = await model.setEnabled(deps, 'Lore', data, [1, 2], true);
        expect(result).toEqual({ ok: false, name: null });
        expect(deps.saveWorldInfo).not.toHaveBeenCalled();
        expect(deps.setOriginal).not.toHaveBeenCalled();
    });

    test('reorder uses the lowest existing/fallback index and mirrors sequential display indexes', async () => {
        const data = { entries: {
            8: { uid: 8, displayIndex: 12 },
            3: { uid: 3, displayIndex: 4 },
            0: { uid: 0 },
        } };
        const deps = createDeps();
        await expect(model.reorder(deps, 'Lore', data, [8, 3, 0, 99])).resolves.toEqual({ ok: true, name: 'Lore' });
        expect([data.entries[8].displayIndex, data.entries[3].displayIndex, data.entries[0].displayIndex]).toEqual([0, 1, 2]);
        expect(deps.setOriginal).toHaveBeenNthCalledWith(1, data, 8, 'extensions.display_index', 0);
        expect(deps.setOriginal).toHaveBeenNthCalledWith(2, data, 3, 'extensions.display_index', 1);
        expect(deps.setOriginal).toHaveBeenNthCalledWith(3, data, 0, 'extensions.display_index', 2);
        expect(deps.saveWorldInfo).toHaveBeenCalledTimes(1);
    });

    test('createEntry applies only editable fields, mirrors them, and saves once', async () => {
        const entry = { uid: 0, key: [], comment: '' };
        const data = { entries: { 0: entry } };
        const deps = createDeps({ createEntry: jest.fn(() => entry) });
        const result = await model.createEntry(deps, 'Lore', data, { comment: 'x', key: ['a'], notEditable: 1 });

        expect(result).toEqual({ ok: true, name: 'Lore', entry });
        expect(entry).toMatchObject({ comment: 'x', key: ['a'] });
        expect(entry).not.toHaveProperty('notEditable');
        expect(deps.setOriginal).toHaveBeenCalledWith(data, 0, 'comment', 'x');
        expect(deps.setOriginal).toHaveBeenCalledWith(data, 0, 'keys', ['a']);
        expect(deps.setOriginal).toHaveBeenCalledWith(data, 0, 'secondary_keys', []);
        expect(deps.setOriginal).toHaveBeenCalledWith(data, 0, 'use_regex', false);
        expect(deps.saveWorldInfo).toHaveBeenCalledTimes(1);
    });

    test('createEntry does not save when the injected creator cannot create an entry', async () => {
        const deps = createDeps({ createEntry: jest.fn(() => undefined) });
        await expect(model.createEntry(deps, 'Lore', { entries: {} })).resolves.toEqual({ ok: false, name: null });
        expect(deps.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('duplicate returns the created entry and commits', async () => {
        const data = { entries: { 0: { uid: 0 } } };
        const entry = { uid: 1 };
        const deps = createDeps({ duplicateEntry: jest.fn(() => entry) });
        await expect(model.duplicate(deps, 'Lore', data, 0)).resolves.toEqual({ ok: true, name: 'Lore', entry });
        expect(deps.duplicateEntry).toHaveBeenCalledWith(data, 0);
        expect(deps.saveWorldInfo).toHaveBeenCalledTimes(1);
    });

    test('remove silently deletes originals only for successful removals and commits once', async () => {
        const data = { entries: {} };
        const deps = createDeps({ deleteEntry: jest.fn(async (_data, uid) => uid === 0 || uid === 3) });
        await expect(model.remove(deps, 'Lore', data, [0, 1, 3])).resolves.toEqual({ ok: true, name: 'Lore', removed: 2 });
        expect(deps.deleteEntry).toHaveBeenNthCalledWith(1, data, 0, { silent: true });
        expect(deps.deleteEntry).toHaveBeenNthCalledWith(2, data, 1, { silent: true });
        expect(deps.deleteEntry).toHaveBeenNthCalledWith(3, data, 3, { silent: true });
        expect(deps.deleteOriginal).toHaveBeenCalledTimes(2);
        expect(deps.deleteOriginal).toHaveBeenNthCalledWith(1, data, 0);
        expect(deps.deleteOriginal).toHaveBeenNthCalledWith(2, data, 3);
        expect(deps.saveWorldInfo).toHaveBeenCalledTimes(1);
    });

    test('remove avoids saving when no entry was removed', async () => {
        const deps = createDeps({ deleteEntry: jest.fn(async () => false) });
        await expect(model.remove(deps, 'Lore', { entries: {} }, [0, 1])).resolves.toEqual({ ok: false, name: null, removed: 0 });
        expect(deps.deleteOriginal).not.toHaveBeenCalled();
        expect(deps.saveWorldInfo).not.toHaveBeenCalled();
    });

    test('move passes copy/delete options and counts successful moves', async () => {
        const deps = createDeps({ moveEntry: jest.fn(async (_source, _target, uid) => uid !== 1) });
        await expect(model.move(deps, 'Lore', 'Archive', [0, 1, 3])).resolves.toEqual({ ok: true, moved: 2 });
        expect(deps.moveEntry).toHaveBeenNthCalledWith(1, 'Lore', 'Archive', 0, { deleteOriginal: true });
        expect(deps.moveEntry).toHaveBeenNthCalledWith(2, 'Lore', 'Archive', 1, { deleteOriginal: true });

        deps.moveEntry.mockClear();
        await expect(model.move(deps, 'Lore', 'Archive', 0, { copy: true })).resolves.toEqual({ ok: true, moved: 1 });
        expect(deps.moveEntry).toHaveBeenCalledWith('Lore', 'Archive', 0, { deleteOriginal: false });
    });
});

describe('entry display helpers', () => {
    test('title, preview, strategy, and position badges summarize entries', () => {
        expect(model.entryTitle({ comment: 'Memo', key: ['one'] })).toBe('Memo');
        expect(model.entryTitle({ key: ['one', 'two'] })).toBe('one, two');
        expect(model.entryTitle({ key: [] })).toBe('Untitled entry');
        expect(model.entryTitle({}, 'Fallback')).toBe('Fallback');
        expect(model.entryKeyPreview({ key: ['a'.repeat(80), 'b'.repeat(40)] })).toHaveLength(100);
        expect(model.entryStrategy({ constant: false, vectorized: true })).toBe('vectorized');
        expect(model.entryBadge({ position: 4, role: 2, depth: 4, order: 100 })).toBe('@D 🤖 4 · 100');
        expect(model.entryBadge({ position: 0, order: 100 })).toBe('↑Char · 100');
        expect(model.entryBadge({ position: 7, order: 1 })).toBe('➡️ Outlet · 1');
        expect(model.entryBadge({ position: 99, order: 2 })).toBe('99 · 2');
    });
});
