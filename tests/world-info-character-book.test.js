import { describe, expect, test } from '@jest/globals';

import { escapeCharacterBookRegex, normalizeCharacterBookPosition, normalizeWorldInfoPosition, serializeCharacterBookKeys, serializeWorldInfoEntry } from '../public/scripts/world-info-character-book.js';

const positions = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
};

describe('normalizeWorldInfoPosition', () => {
    test('passes through valid numeric enum positions', () => {
        expect(normalizeWorldInfoPosition(0, positions)).toBe(positions.before);
        expect(normalizeWorldInfoPosition(1, positions)).toBe(positions.after);
        expect(normalizeWorldInfoPosition(4, positions)).toBe(positions.atDepth);
    });

    test('returns undefined for out-of-enum integers', () => {
        expect(normalizeWorldInfoPosition(12, positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition(-1, positions)).toBeUndefined();
    });

    test('normalizes numeric string positions', () => {
        expect(normalizeWorldInfoPosition('0', positions)).toBe(positions.before);
        expect(normalizeWorldInfoPosition('1', positions)).toBe(positions.after);
    });

    test('returns undefined for out-of-enum numeric strings', () => {
        expect(normalizeWorldInfoPosition('99', positions)).toBeUndefined();
    });

    test('maps before_char and its aliases', () => {
        expect(normalizeWorldInfoPosition('before_char', positions)).toBe(positions.before);
        expect(normalizeWorldInfoPosition('before', positions)).toBe(positions.before);
        expect(normalizeWorldInfoPosition('before character', positions)).toBe(positions.before);
    });

    test('maps after_char and its aliases', () => {
        expect(normalizeWorldInfoPosition('after_char', positions)).toBe(positions.after);
        expect(normalizeWorldInfoPosition('after', positions)).toBe(positions.after);
        expect(normalizeWorldInfoPosition('after character', positions)).toBe(positions.after);
    });

    test('maps depth aliases', () => {
        expect(normalizeWorldInfoPosition('at_depth', positions)).toBe(positions.atDepth);
        expect(normalizeWorldInfoPosition('depth', positions)).toBe(positions.atDepth);
    });

    test('maps AN aliases', () => {
        expect(normalizeWorldInfoPosition('an_top', positions)).toBe(positions.ANTop);
        expect(normalizeWorldInfoPosition('author_note_top', positions)).toBe(positions.ANTop);
        expect(normalizeWorldInfoPosition('an_bottom', positions)).toBe(positions.ANBottom);
        expect(normalizeWorldInfoPosition('author_note_bottom', positions)).toBe(positions.ANBottom);
    });

    test('maps EM aliases', () => {
        expect(normalizeWorldInfoPosition('em_top', positions)).toBe(positions.EMTop);
        expect(normalizeWorldInfoPosition('examples_top', positions)).toBe(positions.EMTop);
        expect(normalizeWorldInfoPosition('em_bottom', positions)).toBe(positions.EMBottom);
        expect(normalizeWorldInfoPosition('examples_bottom', positions)).toBe(positions.EMBottom);
    });

    test('maps outlet alias', () => {
        expect(normalizeWorldInfoPosition('outlet', positions)).toBe(positions.outlet);
    });

    test('returns undefined for unknown strings', () => {
        expect(normalizeWorldInfoPosition('garbage', positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition('', positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition('   ', positions)).toBeUndefined();
    });

    test('returns undefined for non-string non-number values', () => {
        expect(normalizeWorldInfoPosition(undefined, positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition(null, positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition({}, positions)).toBeUndefined();
        expect(normalizeWorldInfoPosition(true, positions)).toBeUndefined();
    });
});

describe('normalizeCharacterBookPosition', () => {
    test('normalizes CC/ST before_char extension positions', () => {
        expect(normalizeCharacterBookPosition('before_char', 'after_char', positions)).toBe(positions.before);
    });

    test('normalizes CC/ST after_char entry positions', () => {
        expect(normalizeCharacterBookPosition(undefined, 'after_char', positions)).toBe(positions.after);
    });

    test('preserves numeric World Info positions', () => {
        expect(normalizeCharacterBookPosition(positions.atDepth, 'before_char', positions)).toBe(positions.atDepth);
    });

    test('normalizes numeric string positions from imported metadata', () => {
        expect(normalizeCharacterBookPosition('0', 'after_char', positions)).toBe(positions.before);
    });

    test('falls back to after when no known position exists', () => {
        expect(normalizeCharacterBookPosition('unknown', undefined, positions)).toBe(positions.after);
    });

    test('falls back to after for out-of-enum integer positions', () => {
        expect(normalizeCharacterBookPosition(99, 12, positions)).toBe(positions.after);
    });
});

describe('serializeCharacterBookKeys', () => {
    test('serializes unflagged regexes without delimiters', () => {
        expect(serializeCharacterBookKeys(['/foo/'], ['/bar/'])).toEqual({
            keys: ['foo'],
            secondaryKeys: ['bar'],
            useRegex: true,
        });
    });

    test('preserves delimiters when they carry regex flags', () => {
        expect(serializeCharacterBookKeys(['/foo/i'], [])).toEqual({
            keys: ['/foo/i'],
            secondaryKeys: [],
            useRegex: true,
        });
    });

    test('keeps internal keys unchanged when regex and plaintext keys are mixed', () => {
        expect(serializeCharacterBookKeys(['/foo/i'], ['bar'])).toEqual({
            keys: ['/foo/i'],
            secondaryKeys: ['bar'],
            useRegex: false,
        });
    });

    test('does not classify plaintext with unescaped slashes as regex', () => {
        expect(serializeCharacterBookKeys(['/foo/bar/'], [])).toEqual({
            keys: ['/foo/bar/'],
            secondaryKeys: [],
            useRegex: false,
        });
    });

    test('round-trips delimiter slashes without accumulating backslashes', () => {
        const rawKey = 'foo/bar';
        const internalKey = `/${escapeCharacterBookRegex(rawKey)}/`;
        const serialized = serializeCharacterBookKeys([internalKey], []);

        expect(internalKey).toBe('/foo\\/bar/');
        expect(serialized.keys).toEqual([rawKey]);
        expect(`/${escapeCharacterBookRegex(serialized.keys[0])}/`).toBe(internalKey);
    });

    test('preserves literal backslashes before delimiter slashes', () => {
        const rawKey = String.raw`foo\\/bar`;
        const internalKey = `/${escapeCharacterBookRegex(rawKey)}/`;
        expect(serializeCharacterBookKeys([internalKey], []).keys).toEqual([rawKey]);
    });
});

describe('serializeWorldInfoEntry', () => {
    test('serializes a fully populated entry to the character book shape', () => {
        const entry = {
            uid: 3,
            key: ['/foo/'],
            keysecondary: ['/bar/'],
            comment: 'A comment',
            content: 'Some content',
            constant: true,
            selective: true,
            order: 42,
            disable: true,
            position: positions.atDepth,
            caseSensitive: true,
            excludeRecursion: true,
            preventRecursion: true,
            delayUntilRecursion: 2,
            displayIndex: 5,
            probability: 50,
            useProbability: true,
            depth: 2,
            selectiveLogic: 1,
            outletName: 'outlet-a',
            group: 'g1,g2',
            groupOverride: true,
            groupWeight: 150,
            scanDepth: 7,
            matchWholeWords: true,
            useGroupScoring: true,
            automationId: 'auto-1',
            role: 2,
            vectorized: true,
            sticky: 3,
            cooldown: 4,
            delay: 5,
            matchPersonaDescription: true,
            matchCharacterDescription: true,
            matchCharacterPersonality: true,
            matchCharacterDepthPrompt: true,
            matchScenario: true,
            matchCreatorNotes: true,
            triggers: ['normal'],
            ignoreBudget: true,
            agentBlacklisted: true,
            characterFilter: {
                isExclude: true,
                names: ['alice.png'],
                tags: ['tag-1'],
            },
            extensions: { foreign_field: 'kept' },
        };

        expect(serializeWorldInfoEntry(entry, positions)).toEqual({
            id: 3,
            keys: ['foo'],
            secondary_keys: ['bar'],
            comment: 'A comment',
            content: 'Some content',
            constant: true,
            selective: true,
            insertion_order: 42,
            enabled: false,
            position: 'after_char',
            use_regex: true,
            case_sensitive: true,
            character_filter: {
                isExclude: true,
                names: ['alice.png'],
                tags: ['tag-1'],
            },
            extensions: {
                foreign_field: 'kept',
                position: positions.atDepth,
                exclude_recursion: true,
                display_index: 5,
                probability: 50,
                useProbability: true,
                depth: 2,
                selectiveLogic: 1,
                outlet_name: 'outlet-a',
                group: 'g1,g2',
                group_override: true,
                group_weight: 150,
                prevent_recursion: true,
                delay_until_recursion: 2,
                scan_depth: 7,
                match_whole_words: true,
                use_group_scoring: true,
                case_sensitive: true,
                automation_id: 'auto-1',
                role: 2,
                vectorized: true,
                sticky: 3,
                cooldown: 4,
                delay: 5,
                match_persona_description: true,
                match_character_description: true,
                match_character_personality: true,
                match_character_depth_prompt: true,
                match_scenario: true,
                match_creator_notes: true,
                triggers: ['normal'],
                ignore_budget: true,
                agent_blacklisted: true,
            },
        });
    });

    test('normalizes a legacy string position to before_char with a numeric extension position', () => {
        const record = serializeWorldInfoEntry({ uid: 0, position: '0' }, positions);
        expect(record.position).toBe('before_char');
        expect(record.extensions.position).toBe(0);
    });

    test('serializes plain keys without regex mode', () => {
        const record = serializeWorldInfoEntry({ uid: 1, key: ['alpha'], keysecondary: ['beta'] }, positions);
        expect(record.keys).toEqual(['alpha']);
        expect(record.secondary_keys).toEqual(['beta']);
        expect(record.use_regex).toBe(false);
    });

    test('preserves unknown source metadata while replacing stale native fields', () => {
        const originalEntry = {
            id: 2,
            comment: 'Stale comment',
            character_filter: { isExclude: true, names: ['stale.png'], tags: [] },
            foreign_top_level: 'kept',
            extensions: {
                display_index: 1,
                foreign_extension: 'kept',
            },
        };
        const entry = {
            uid: 9,
            comment: 'Current comment',
            displayIndex: 12,
            characterFilter: { isExclude: false, names: ['current.png'], tags: ['tag-2'] },
        };

        expect(serializeWorldInfoEntry(entry, positions, originalEntry)).toMatchObject({
            id: 9,
            comment: 'Current comment',
            character_filter: entry.characterFilter,
            foreign_top_level: 'kept',
            extensions: {
                display_index: 12,
                foreign_extension: 'kept',
            },
        });
    });

    test('does not restore a stale character filter when the native entry has none', () => {
        const record = serializeWorldInfoEntry({ uid: 7 }, positions, {
            character_filter: { isExclude: true, names: ['stale.png'], tags: [] },
        });
        expect(record).not.toHaveProperty('character_filter');
    });

    test('applies server-parity defaults for absent fields', () => {
        const record = serializeWorldInfoEntry({ uid: 7 }, positions);
        expect(record).not.toHaveProperty('character_filter');
        expect(record).toMatchObject({
            id: 7,
            keys: [],
            secondary_keys: [],
            comment: '',
            content: '',
            constant: false,
            selective: false,
            insertion_order: 100,
            enabled: true,
            position: 'after_char',
            use_regex: false,
            case_sensitive: null,
        });
        expect(record.extensions).toMatchObject({
            probability: null,
            useProbability: false,
            depth: 4,
            selectiveLogic: 0,
            group_weight: null,
            delay_until_recursion: false,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            ignore_budget: false,
            agent_blacklisted: false,
        });
    });
});
