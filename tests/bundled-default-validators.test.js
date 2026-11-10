/* global globalThis */
import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import PNGtext from 'png-chunk-text';
import extract from 'png-chunks-extract';

import { read as readCardImage } from '../src/character-card-parser.js';
import { setConfigFilePath } from '../src/util.js';
import { TavernCardValidator } from '../src/validator/TavernCardValidator.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDirectory = path.join(repoRoot, 'default', 'content');

// Global content types resolve below this value.
globalThis.DATA_ROOT = 'data-root';
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));
const { CONTENT_TYPES, PRESET_CONTENT_TYPES, getDefaultPresets, getGlobalTargetByType, getUserTargetByType } = await import('../src/endpoints/content-manager.js');
const { isValidWorldInfoData } = await import('../src/endpoints/worldinfo.js');
const { MANIFEST_FILE_NAME } = await import('../src/sillybunny-managed-content.js');

// Each property reads back as its own name. A resolved target then shows which directory a type installs to.
const directoryNames = new Proxy({}, { get: (_target, name) => String(name) });

const namedTypes = [
    CONTENT_TYPES.INSTRUCT,
    CONTENT_TYPES.CONTEXT,
    CONTENT_TYPES.SYSPROMPT,
    CONTENT_TYPES.REASONING,
    CONTENT_TYPES.THEME,
    CONTENT_TYPES.QUICK_REPLIES,
    CONTENT_TYPES.MOVING_UI,
];

const missingTextCompletions = 'the name adds "(Text Completions)" that the file name lacks';
const namesThatDifferFromTheFile = new Map([
    ['presets/sysprompt/Geechan - Universal Roleplay (V5.2).json', missingTextCompletions],
    ['presets/sysprompt/Geechan - Universal Roleplay (NSFW) (V5.2).json', missingTextCompletions],
    ['presets/sysprompt/Geechan - Universal Roleplay (Simplified) (V5.2).json', missingTextCompletions],
    ['presets/sysprompt/Geechan - Universal Roleplay (Simplified NSFW) (V5.2).json', missingTextCompletions],
    ['presets/sysprompt/Geechan - Universal Online Chat (V1.0).json', missingTextCompletions],
]);

const textFieldsByType = {
    [CONTENT_TYPES.SYSPROMPT]: ['content', 'post_history'],
    [CONTENT_TYPES.REASONING]: ['prefix', 'suffix', 'separator'],
};

const settingsOnlyInstructFields = ['enabled', 'bind_to_context'];
const storyStringFields = ['description', 'personality', 'persona', 'scenario', 'wiBefore', 'wiAfter', 'anchorBefore', 'anchorAfter'];
const cardChecks = { chara: 'validateV2', ccv3: 'validateV3' };
const knownCardFailures = new Map([
    ['default_Seraphina.png (chara)', { error: 'data.character_book.extensions', reason: 'the embedded character book has no extensions' }],
]);

// Older files may hold delayUntilRecursion as a boolean and role as null, and the app still accepts both.
const alternativeFieldTypes = { delayUntilRecursion: 'boolean', role: 'null' };

const typeLabels = { 'array': 'array of strings', 'number?': 'number or null', 'boolean?': 'boolean or null', 'enum': 'integer' };

const bookEntryFields = {
    keys: 'array',
    content: 'string',
    insertion_order: 'number',
    enabled: 'boolean',
    extensions: 'object',
};
const optionalBookEntryFields = {
    secondary_keys: 'array',
    comment: 'string',
    constant: 'boolean',
    selective: 'boolean',
    use_regex: 'boolean',
    position: 'string',
};

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = value => typeof value === 'string' && value !== '';
const expectation = type => typeLabels[type] ?? type;

function describeType(value) {
    if (value === null) {
        return 'null';
    }
    return Array.isArray(value) ? 'array' : typeof value;
}

function withChanges(base, changes) {
    return Object.fromEntries(Object.entries({ ...base, ...changes }).filter(([, value]) => value !== undefined));
}

function readIndex() {
    return JSON.parse(fs.readFileSync(path.join(contentDirectory, 'index.json'), 'utf8'));
}

function entriesOfTypes(...types) {
    const entries = readIndex().filter(entry => types.includes(entry.type));
    expect(entries.length).toBeGreaterThan(0);
    return entries;
}

function hasExtension(entry, extension) {
    return path.extname(entry.filename).toLowerCase() === extension;
}

function readJson(entry) {
    try {
        return { data: JSON.parse(fs.readFileSync(path.join(contentDirectory, entry.filename), 'utf8')) };
    } catch (error) {
        return { error: error.message };
    }
}

function readObject(entry) {
    const { data } = readJson(entry);
    return isPlainObject(data) ? data : null;
}

function readSource(...segments) {
    return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');
}

function readBlock(source, declaration) {
    const start = source.indexOf(`\n${declaration}\n`);
    const end = source.indexOf(declaration.endsWith('[') ? '\n];' : '\n};', start);
    return start === -1 || end === -1 ? '' : source.slice(start, end);
}

function resolveTarget(type) {
    return getUserTargetByType(type, directoryNames) ?? getGlobalTargetByType(type);
}

function existsWithExactCase(relativePath) {
    let directory = contentDirectory;
    for (const name of relativePath.split('/')) {
        let names;
        try {
            names = fs.readdirSync(directory);
        } catch {
            return false;
        }
        if (!names.includes(name)) {
            return false;
        }
        directory = path.join(directory, name);
    }
    return true;
}

function listFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
        const itemPath = path.join(directory, item.name);
        return item.isDirectory() ? listFiles(itemPath) : [itemPath];
    });
}

function isPlainRelativePath(value) {
    return isNonEmptyString(value)
        && !value.includes('\\')
        && !path.posix.isAbsolute(value)
        && path.posix.normalize(value) === value
        && !value.split('/').includes('..');
}

function readInstructRules() {
    const source = readSource('public', 'scripts', 'instruct-mode.js');
    const fields = [...readBlock(source, 'const controls = [').matchAll(/property: '(\w+)', isCheckbox: (true|false)/g)]
        .map(([, name, isCheckbox]) => ({ name, isCheckbox: isCheckbox === 'true' }))
        .filter(field => !settingsOnlyInstructFields.includes(field.name));
    const namesBehaviors = [...readBlock(source, 'export const names_behavior_types = {').matchAll(/: '(\w+)'/g)].map(match => match[1]);
    return { fields, namesBehaviors };
}

function readWorldInfoRules() {
    const source = readSource('public', 'scripts', 'world-info.js');
    const readNumbers = declaration => [...readBlock(source, declaration).matchAll(/: (\d+),/g)].map(match => Number(match[1]));
    const definitions = readBlock(source, 'export const newWorldInfoEntryDefinition = {');
    const fieldTypes = Object.fromEntries([...definitions.matchAll(/^ {4}(\w+): \{ default: .*, type: '([a-z?]+)'/gm)].map(match => [match[1], match[2]]));
    return {
        fieldTypes,
        positions: readNumbers('export const world_info_position = {'),
        logics: readNumbers('export const world_info_logic = {'),
    };
}

let worldInfoRules;
const getWorldInfoRules = () => (worldInfoRules ??= readWorldInfoRules());

function matchesFieldType(value, type) {
    switch (type) {
        case 'array': return Array.isArray(value) && value.every(item => typeof item === 'string');
        case 'object': return isPlainObject(value);
        case 'null': return value === null;
        case 'enum': return Number.isInteger(value);
        case 'number': return Number.isFinite(value);
        case 'number?': return value === null || Number.isFinite(value);
        case 'boolean?': return value === null || typeof value === 'boolean';
        default: return typeof value === type;
    }
}

function findStoryStringProblems(storyString) {
    const values = Object.fromEntries(storyStringFields.map(field => [field, `<${field}>`]));
    const params = {
        ...values,
        loreBefore: values.wiBefore,
        loreAfter: values.wiAfter,
        system: '<system>',
        char: '<char>',
        user: '<user>',
        mesExamples: '<mesExamples>',
        mesExamplesRaw: '<mesExamplesRaw>',
    };
    let output;
    try {
        output = Handlebars.compile(storyString, { noEscape: true })(params);
    } catch (error) {
        return [`does not compile: ${error.message.split('\n')[0]}`];
    }
    return storyStringFields.filter(field => !output.includes(values[field])).map(field => `leaves out ${field}`);
}

function findInstructProblems(preset, { fields, namesBehaviors }) {
    const problems = [];
    for (const { name, isCheckbox } of fields) {
        const expected = isCheckbox ? 'boolean' : 'string';
        if (typeof preset[name] !== expected) {
            problems.push(`${name} is ${describeType(preset[name])}, expected ${expected}`);
        }
    }
    if (!namesBehaviors.includes(preset.names_behavior)) {
        problems.push(`names_behavior is ${JSON.stringify(preset.names_behavior)}`);
    }
    return problems;
}

function findPromptProblems(preset) {
    if (!Array.isArray(preset.prompts)) {
        return [`prompts is ${describeType(preset.prompts)}, expected array`];
    }
    const problems = [];
    const identifiers = preset.prompts.map(prompt => prompt?.identifier);
    if (!identifiers.every(isNonEmptyString)) {
        problems.push('a prompt has no identifier');
    }
    for (const identifier of new Set(identifiers.filter((value, position) => identifiers.indexOf(value) !== position))) {
        problems.push(`the prompt ${identifier} is defined twice`);
    }
    for (const group of Array.isArray(preset.prompt_order) ? preset.prompt_order : []) {
        for (const item of Array.isArray(group?.order) ? group.order : []) {
            if (!identifiers.includes(item?.identifier)) {
                problems.push(`prompt_order lists ${item?.identifier}, which no prompt defines`);
            }
        }
    }
    return problems;
}

function findWorldInfoEntryProblems(key, entry, rules) {
    if (!isPlainObject(entry)) {
        return [`is ${describeType(entry)}, expected object`];
    }
    const problems = [];
    if (!Number.isInteger(entry.uid) || String(entry.uid) !== key) {
        problems.push(`uid ${JSON.stringify(entry.uid)} does not match the key ${key}`);
    }
    for (const required of ['key', 'content']) {
        if (!Object.hasOwn(entry, required)) {
            problems.push(`has no ${required}`);
        }
    }
    for (const [field, value] of Object.entries(entry)) {
        const type = rules.fieldTypes[field];
        const alternative = alternativeFieldTypes[field];
        if (type !== undefined && !matchesFieldType(value, type) && !(alternative !== undefined && matchesFieldType(value, alternative))) {
            problems.push(`${field} is ${describeType(value)}, expected ${expectation(type)}`);
        }
    }
    if (entry.position !== undefined && !rules.positions.includes(entry.position)) {
        problems.push(`position ${JSON.stringify(entry.position)} is not a known position`);
    }
    if (entry.selectiveLogic !== undefined && !rules.logics.includes(entry.selectiveLogic)) {
        problems.push(`selectiveLogic ${JSON.stringify(entry.selectiveLogic)} is not a known logic`);
    }
    if (typeof entry.probability === 'number' && (entry.probability < 0 || entry.probability > 100)) {
        problems.push(`probability ${entry.probability} is outside 0 to 100`);
    }
    return problems;
}

function findBookEntryProblems(entry) {
    if (!isPlainObject(entry)) {
        return [`is ${describeType(entry)}, expected object`];
    }
    const problems = [];
    for (const [field, type] of Object.entries(bookEntryFields)) {
        if (!matchesFieldType(entry[field], type)) {
            problems.push(`${field} is ${describeType(entry[field])}, expected ${expectation(type)}`);
        }
    }
    for (const [field, type] of Object.entries(optionalBookEntryFields)) {
        if (entry[field] !== undefined && !matchesFieldType(entry[field], type)) {
            problems.push(`${field} is ${describeType(entry[field])}, expected ${expectation(type)}`);
        }
    }
    if (typeof entry.position === 'string' && !['before_char', 'after_char'].includes(entry.position)) {
        problems.push(`position ${JSON.stringify(entry.position)} is not before_char or after_char`);
    }
    return problems;
}

function readCardChunks(buffer) {
    return extract(new Uint8Array(buffer))
        .filter(chunk => chunk.name === 'tEXt')
        .map(chunk => PNGtext.decode(chunk.data))
        .filter(({ keyword }) => Object.hasOwn(cardChecks, keyword.toLowerCase()))
        .map(({ keyword, text }) => ({
            keyword: keyword.toLowerCase(),
            card: JSON.parse(Buffer.from(text, 'base64').toString('utf8')),
        }));
}

function collectCardProblems(check) {
    const problems = [];
    for (const entry of entriesOfTypes(CONTENT_TYPES.CHARACTER)) {
        if (!hasExtension(entry, '.png')) {
            problems.push(`${entry.filename}: not a PNG image`);
            continue;
        }
        try {
            const buffer = fs.readFileSync(path.join(contentDirectory, entry.filename));
            readCardImage(buffer);
            for (const { keyword, card } of readCardChunks(buffer)) {
                const label = `${entry.filename} (${keyword})`;
                problems.push(...check(card, keyword, label).map(problem => `${label}: ${problem}`));
            }
        } catch (error) {
            problems.push(`${entry.filename}: ${error.message}`);
        }
    }
    return problems;
}

describe('bundled content index', () => {
    test('lists entries with a plain relative filename and a type', () => {
        const index = readIndex();
        expect(Array.isArray(index)).toBe(true);
        const malformed = index.filter(entry => !(isPlainObject(entry) && isPlainRelativePath(entry.filename) && isNonEmptyString(entry.type)));
        expect(malformed).toEqual([]);
    });

    test('uses only content types that the content manager can install', () => {
        const knownTypes = Object.values(CONTENT_TYPES);
        const unknown = readIndex()
            .filter(entry => !knownTypes.includes(entry.type) || !resolveTarget(entry.type))
            .map(entry => `${entry.filename}: ${entry.type}`);
        expect(unknown).toEqual([]);
    });

    test('points every entry at an existing, non-empty file or folder', () => {
        const problems = [];
        for (const { filename } of readIndex()) {
            if (!existsWithExactCase(filename)) {
                problems.push(`${filename}: not found with this exact spelling`);
                continue;
            }
            const location = path.join(contentDirectory, filename);
            const stats = fs.statSync(location);
            if (stats.isDirectory() ? fs.readdirSync(location).length === 0 : stats.size === 0) {
                problems.push(`${filename}: empty`);
            }
        }
        expect(problems).toEqual([]);
    });

    test('installs no two entries under the same file name', () => {
        const owners = new Map();
        for (const { filename, type } of readIndex()) {
            const installed = `${resolveTarget(type)}/${path.parse(filename).base}`;
            owners.set(installed, [...(owners.get(installed) ?? []), filename]);
        }
        const shared = [...owners].filter(([, files]) => files.length > 1).map(([installed, files]) => `${installed}: ${files.join(', ')}`);
        expect(shared).toEqual([]);
    });

    test('has an entry for every file in the content folder', () => {
        const filenames = readIndex().map(entry => entry.filename);
        const unlisted = listFiles(contentDirectory)
            .map(file => path.relative(contentDirectory, file).split(path.sep).join('/'))
            // The managed content manifest describes bundled files for updates and is not content that the index installs.
            .filter(file => file !== 'index.json' && file !== MANIFEST_FILE_NAME)
            .filter(file => !filenames.some(filename => file === filename || file.startsWith(`${filename}/`)));
        expect(unlisted).toEqual([]);
    });

    test('matches the default presets that the content manager reports', () => {
        const expected = readIndex().filter(entry => PRESET_CONTENT_TYPES.includes(entry.type)).map(entry => entry.filename);
        expect(expected.length).toBeGreaterThan(0);
        expect(getDefaultPresets(directoryNames).map(preset => preset.filename)).toEqual(expected);
    });

    test('has JSON files that parse into objects', () => {
        const problems = [];
        for (const entry of readIndex().filter(item => hasExtension(item, '.json'))) {
            const { data, error } = readJson(entry);
            if (error) {
                problems.push(`${entry.filename}: ${error}`);
            } else if (!isPlainObject(data)) {
                problems.push(`${entry.filename}: holds ${describeType(data)}, expected object`);
            }
        }
        expect(problems).toEqual([]);
    });

    test('gives each named data file the name of its file apart from the listed exceptions', () => {
        const problems = [];
        const seen = new Set();
        for (const entry of entriesOfTypes(...namedTypes)) {
            const data = readObject(entry);
            if (data === null) {
                continue;
            }
            const matches = data.name === path.parse(entry.filename).name;
            if (namesThatDifferFromTheFile.has(entry.filename)) {
                seen.add(entry.filename);
                if (matches) {
                    problems.push(`${entry.filename}: the name now matches the file, remove it from the exceptions`);
                }
            } else if (!matches) {
                problems.push(`${entry.filename}: the name is ${JSON.stringify(data.name)}`);
            }
        }
        for (const filename of namesThatDifferFromTheFile.keys()) {
            if (!seen.has(filename)) {
                problems.push(`${filename}: listed as an exception but not found`);
            }
        }
        expect(problems).toEqual([]);
    });
});

describe('bundled presets', () => {
    test('defines the prompts that a chat completion preset orders', () => {
        const problems = [];
        for (const entry of entriesOfTypes(CONTENT_TYPES.OPENAI_PRESET)) {
            const data = readObject(entry);
            if (data !== null) {
                problems.push(...findPromptProblems(data).map(problem => `${entry.filename}: ${problem}`));
            }
        }
        expect(problems).toEqual([]);
    });

    test('gives every instruct template the fields that the instruct loader reads', () => {
        const rules = readInstructRules();
        expect(rules.fields.length).toBeGreaterThan(10);
        const problems = [];
        for (const entry of entriesOfTypes(CONTENT_TYPES.INSTRUCT)) {
            const data = readObject(entry);
            if (data !== null) {
                problems.push(...findInstructProblems(data, rules).map(problem => `${entry.filename}: ${problem}`));
            }
        }
        expect(problems).toEqual([]);
    });

    test('gives every context template a story string that renders the character fields', () => {
        const problems = [];
        for (const entry of entriesOfTypes(CONTENT_TYPES.CONTEXT)) {
            const data = readObject(entry);
            if (data === null) {
                continue;
            }
            if (typeof data.story_string !== 'string') {
                problems.push(`${entry.filename}: story_string is ${describeType(data.story_string)}`);
                continue;
            }
            problems.push(...findStoryStringProblems(data.story_string).map(problem => `${entry.filename}: ${problem}`));
        }
        expect(problems).toEqual([]);
    });

    test('gives every system prompt and reasoning template its text fields', () => {
        const problems = [];
        for (const [type, fields] of Object.entries(textFieldsByType)) {
            for (const entry of entriesOfTypes(type)) {
                const data = readObject(entry);
                if (data === null) {
                    continue;
                }
                for (const field of fields.filter(name => typeof data[name] !== 'string')) {
                    problems.push(`${entry.filename}: ${field} is ${describeType(data[field])}, expected string`);
                }
            }
        }
        expect(problems).toEqual([]);
    });
});

describe('bundled characters', () => {
    test('stores cards that pass the card validator in every character image apart from the known failures', () => {
        const problems = collectCardProblems((card, keyword, label) => {
            const validator = new TavernCardValidator(card);
            const check = cardChecks[keyword];
            const failure = validator[check]() ? null : (validator.lastValidationError ?? 'an unknown field');
            const found = [];
            if (failure !== (knownCardFailures.get(label)?.error ?? null)) {
                found.push(failure === null ? `passes ${check}, remove it from the known failures` : `fails ${check} at ${failure}`);
            }
            if (!isNonEmptyString(card.data?.name)) {
                found.push('has no name');
            }
            return found;
        });
        expect(problems).toEqual([]);
    });

    test('holds valid character book entries in every card', () => {
        const problems = collectCardProblems(card => {
            const entries = card.data?.character_book?.entries;
            if (entries === undefined) {
                return [];
            }
            if (!Array.isArray(entries)) {
                return [`character_book.entries is ${describeType(entries)}, expected array`];
            }
            return entries.flatMap((entry, position) => findBookEntryProblems(entry).map(problem => `book entry ${position}: ${problem}`));
        });
        expect(problems).toEqual([]);
    });
});

describe('bundled World Info', () => {
    test('has entries that the editor and the scanner can use', () => {
        const rules = getWorldInfoRules();
        expect(Object.keys(rules.fieldTypes).length).toBeGreaterThan(20);
        const problems = [];
        for (const entry of entriesOfTypes(CONTENT_TYPES.WORLD)) {
            const data = readObject(entry);
            if (data === null) {
                continue;
            }
            if (!isValidWorldInfoData(data)) {
                problems.push(`${entry.filename}: does not hold an entries object`);
                continue;
            }
            for (const [key, value] of Object.entries(data.entries)) {
                problems.push(...findWorldInfoEntryProblems(key, value, rules).map(problem => `${entry.filename}, entry ${key}: ${problem}`));
            }
        }
        expect(problems).toEqual([]);
    });
});

describe('rules for bundled data', () => {
    const goodStoryString = '{{#if description}}{{description}}{{/if}}{{personality}}{{persona}}{{scenario}}{{wiBefore}}{{wiAfter}}{{anchorBefore}}{{anchorAfter}}';
    const instructRules = {
        fields: [
            { name: 'input_suffix', isCheckbox: false },
            { name: 'wrap', isCheckbox: true },
            { name: 'stop_sequence', isCheckbox: false },
        ],
        namesBehaviors: ['none', 'force', 'always'],
    };
    const goodInstructTemplate = { input_suffix: '', wrap: true, stop_sequence: '', names_behavior: 'force' };
    const goodWorldInfoEntry = { uid: 7, key: ['a'], keysecondary: [], content: 'text', constant: false, order: 100, position: 0, selectiveLogic: 0, probability: 100, scanDepth: null, role: null, delayUntilRecursion: false };
    const goodBookEntry = { keys: ['a'], content: 'text', insertion_order: 100, enabled: true, extensions: {}, position: 'before_char' };

    test('reads the field lists from the loader sources', () => {
        const instruct = readInstructRules();
        expect(instruct.fields.map(field => field.name)).toEqual(expect.arrayContaining(['input_sequence', 'output_sequence', 'names_behavior', 'wrap']));
        expect(instruct.fields.find(field => field.name === 'wrap')?.isCheckbox).toBe(true);
        expect(instruct.namesBehaviors).toEqual(expect.arrayContaining(['none', 'always']));
        const worldInfo = getWorldInfoRules();
        expect(worldInfo.fieldTypes).toMatchObject({ key: 'array', content: 'string', position: 'number' });
        expect(Object.keys(worldInfo.fieldTypes).length).toBeGreaterThan(20);
        expect(worldInfo.positions).toEqual(expect.arrayContaining([0, 1]));
        expect(worldInfo.logics).toEqual(expect.arrayContaining([0, 1]));
    });

    test.each([
        ['every character field', goodStoryString],
        ['the older lore names', goodStoryString.replace('wiBefore', 'loreBefore').replace('wiAfter', 'loreAfter')],
    ])('accepts a story string with %s', (_name, storyString) => {
        expect(findStoryStringProblems(storyString)).toEqual([]);
    });

    test.each([
        ['an unclosed block', '{{#if description}}{{description}}', 'does not compile'],
        ['a block closed by another name', '{{#if description}}{{description}}{{/each}}', 'does not compile'],
        ['an unfinished expression', '{{description', 'does not compile'],
        ['no persona', goodStoryString.replace('{{persona}}', ''), 'leaves out persona'],
        ['no anchorAfter', goodStoryString.replace('{{anchorAfter}}', ''), 'leaves out anchorAfter'],
    ])('rejects a story string with %s', (_name, storyString, expected) => {
        expect(findStoryStringProblems(storyString).join('; ')).toContain(expected);
    });

    test.each([
        ['a missing field', { input_suffix: undefined }, 'input_suffix is undefined, expected string'],
        ['a text where a switch belongs', { wrap: 'true' }, 'wrap is string, expected boolean'],
        ['a switch where a text belongs', { stop_sequence: false }, 'stop_sequence is boolean, expected string'],
        ['an unknown names behavior', { names_behavior: 'sometimes' }, 'names_behavior is "sometimes"'],
    ])('rejects an instruct template with %s', (_name, change, expected) => {
        expect(findInstructProblems(goodInstructTemplate, instructRules)).toEqual([]);
        expect(findInstructProblems(withChanges(goodInstructTemplate, change), instructRules)).toEqual([expected]);
    });

    test.each([
        ['prompts that are not a list', { prompts: {} }, 'prompts is object, expected array'],
        ['a prompt without an identifier', { prompts: [{ name: 'x' }], prompt_order: [] }, 'a prompt has no identifier'],
        ['a prompt defined twice', { prompts: [{ identifier: 'a' }, { identifier: 'a' }] }, 'the prompt a is defined twice'],
        ['an order that lists an unknown prompt', { prompt_order: [{ order: [{ identifier: 'a' }, { identifier: 'b' }] }] }, 'prompt_order lists b, which no prompt defines'],
    ])('rejects a chat completion preset with %s', (_name, change, expected) => {
        const preset = { prompts: [{ identifier: 'a' }], prompt_order: [{ order: [{ identifier: 'a' }] }] };
        expect(findPromptProblems(preset)).toEqual([]);
        expect(findPromptProblems({ ...preset, ...change })).toEqual([expected]);
    });

    test('accepts a World Info entry with the older forms of role and delayUntilRecursion', () => {
        const rules = getWorldInfoRules();
        expect(findWorldInfoEntryProblems('7', goodWorldInfoEntry, rules)).toEqual([]);
        expect(findWorldInfoEntryProblems('7', { ...goodWorldInfoEntry, role: 1, delayUntilRecursion: 2 }, rules)).toEqual([]);
    });

    test.each([
        ['a uid that differs from its key', { uid: 8 }, 'uid 8 does not match the key 7'],
        ['no content', { content: undefined }, 'has no content'],
        ['keys that are not a list', { key: 'a' }, 'key is string, expected array of strings'],
        ['a switch stored as text', { constant: 'false' }, 'constant is string, expected boolean'],
        ['a position that does not exist', { position: 99 }, 'position 99 is not a known position'],
        ['a logic that does not exist', { selectiveLogic: 9 }, 'selectiveLogic 9 is not a known logic'],
        ['a probability above 100', { probability: 101 }, 'probability 101 is outside 0 to 100'],
        ['a scan depth stored as text', { scanDepth: '4' }, 'scanDepth is string, expected number or null'],
    ])('rejects a World Info entry with %s', (_name, change, expected) => {
        expect(findWorldInfoEntryProblems('7', withChanges(goodWorldInfoEntry, change), getWorldInfoRules())).toEqual([expected]);
    });

    test('accepts a character book entry with only the required fields', () => {
        expect(findBookEntryProblems({ keys: [], content: '', insertion_order: 0, enabled: false, extensions: {} })).toEqual([]);
        expect(findBookEntryProblems(goodBookEntry)).toEqual([]);
    });

    test.each([
        ['keys that are not a list', { keys: 'a' }, 'keys is string, expected array of strings'],
        ['no content', { content: undefined }, 'content is undefined, expected string'],
        ['an order stored as text', { insertion_order: '100' }, 'insertion_order is string, expected number'],
        ['extensions stored as a list', { extensions: [] }, 'extensions is array, expected object'],
        ['an unknown position', { position: 'middle' }, 'position "middle" is not before_char or after_char'],
        ['secondary keys that are not text', { secondary_keys: [1] }, 'secondary_keys is array, expected array of strings'],
    ])('rejects a character book entry with %s', (_name, change, expected) => {
        expect(findBookEntryProblems(withChanges(goodBookEntry, change))).toEqual([expected]);
    });
});
