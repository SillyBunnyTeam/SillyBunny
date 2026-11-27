/* global globalThis */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

import '../src/fetch-patch.js';
import { escapeCharacterBookRegex, getFreeCharacterBookEntryId, normalizeCharacterBookPosition, normalizeWorldInfoPosition, serializeCharacterBookKeys, serializeWorldInfoEntry } from '../public/scripts/world-info-character-book.js';
import { importWorldInfoModule } from './util/world-info-module-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
            id: 2,
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

    test('preserves original ID zero and allocates a separate ID for new card records', () => {
        expect(serializeWorldInfoEntry({ uid: 1 }, positions, { id: 0 }).id).toBe(0);
        expect(getFreeCharacterBookEntryId([{ id: 74 }, { id: 0 }])).toBe(1);
        expect(getFreeCharacterBookEntryId([{ id: '0' }, { id: 1 }, { id: 74 }])).toBe(2);
        expect(getFreeCharacterBookEntryId([])).toBe(0);
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

describe('convertCharacterBook', () => {
    const originalWorkingDirectory = process.cwd();
    const diskCacheEnvironmentKey = 'SILLYTAVERN_PERFORMANCE_USEDISKCACHE';
    const originalDiskCacheSetting = process.env[diskCacheEnvironmentKey];
    let worldInfo;
    let baseUrl;
    let directories;
    let server;
    let tempRoot;

    beforeAll(async () => {
        const loaded = await importWorldInfoModule();
        worldInfo = loaded.worldInfo;

        process.env[diskCacheEnvironmentKey] = 'false';
        process.chdir(repoRoot);
        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));
        const { router: charactersRouter } = await import('../src/endpoints/characters.js');

        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'wi-character-book-test' },
                directories,
            };
            next();
        });
        app.use('/api/characters', charactersRouter);

        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-wi-charbook-'));
        directories = {
            root: tempRoot,
            backups: path.join(tempRoot, 'backups'),
            chats: path.join(tempRoot, 'chats'),
            characters: path.join(tempRoot, 'characters'),
            groupChats: path.join(tempRoot, 'group chats'),
            groups: path.join(tempRoot, 'groups'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
            worlds: path.join(tempRoot, 'worlds'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        if (server) {
            await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
        if (originalDiskCacheSetting === undefined) {
            delete process.env[diskCacheEnvironmentKey];
        } else {
            process.env[diskCacheEnvironmentKey] = originalDiskCacheSetting;
        }
        process.chdir(originalWorkingDirectory);
    });

    async function embedNativeBookInCard(bookName, bookData) {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'info').mockImplementation(() => {});
        fs.writeFileSync(path.join(directories.worlds, `${bookName}.json`), JSON.stringify(bookData));
        const createRes = await fetch(`${baseUrl}/api/characters/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ch_name: 'Alice', file_name: 'Alice' }),
        });
        expect(createRes.status).toBe(200);
        const getRes = await fetch(`${baseUrl}/api/characters/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar_url: 'Alice.png' }),
        });
        const character = await getRes.json();
        const editRes = await fetch(`${baseUrl}/api/characters/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                avatar_url: 'Alice.png',
                ch_name: character.name,
                description: character.description,
                personality: character.personality,
                scenario: character.scenario,
                first_mes: character.first_mes,
                mes_example: character.mes_example,
                creator_notes: character.data.creator_notes,
                system_prompt: character.data.system_prompt,
                post_history_instructions: character.data.post_history_instructions,
                creator: character.data.creator,
                character_version: character.data.character_version,
                alternate_greetings: character.data.alternate_greetings,
                tags: character.tags.join(','),
                talkativeness: character.talkativeness,
                fav: String(character.fav),
                world: bookName,
                depth_prompt_prompt: character.data.extensions.depth_prompt.prompt,
                depth_prompt_depth: character.data.extensions.depth_prompt.depth,
                depth_prompt_role: character.data.extensions.depth_prompt.role,
                chat: character.chat,
                create_date: character.create_date,
                json_data: character.json_data,
            }),
        });
        expect(editRes.status).toBe(200);
        const png = fs.readFileSync(path.join(directories.characters, 'Alice.png'));
        const ccv3Chunk = extract(new Uint8Array(png))
            .filter(chunk => chunk.name === 'tEXt')
            .map(chunk => PNGtext.decode(chunk.data))
            .find(chunk => chunk.keyword.toLowerCase() === 'ccv3');
        const decoded = JSON.parse(Buffer.from(ccv3Chunk.text, 'base64').toString('utf8'));
        return decoded.data.character_book;
    }

    test('maps CharacterBook filters to native entries', () => {
        const characterFilter = { isExclude: true, names: ['Alice'], tags: ['tag'] };
        const result = worldInfo.convertCharacterBook({ entries: [{ id: 74, content: 'Entry', character_filter: characterFilter }] });
        expect(result.entries[0].characterFilter).toEqual(characterFilter);
    });

    test('real import, resync, create, duplicate and cross-book append keep distinct original card IDs', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const native = worldInfo.convertCharacterBook({ entries: [
            { id: 74, content: 'First', foreign: 'kept', extensions: { foreign: { retained: true } } },
            { id: 0, content: 'Second', extensions: {} },
        ] });
        native.entries[0].content = 'Edited';
        worldInfo.syncWIOriginalDataEntry(native, 0);
        worldInfo.syncWIOriginalDataEntry(native, 1);
        expect(native.originalData.entries.map(entry => entry.id)).toEqual([74, 0]);
        expect(native.originalData.entries[0]).toMatchObject({ content: 'Edited', foreign: 'kept' });

        const created = worldInfo.createWorldInfoEntry('Book', native);
        const duplicated = worldInfo.duplicateWorldInfoEntry(native, 0);
        worldInfo.syncWIOriginalDataEntry(native, duplicated.uid);
        expect(native.originalData.entries.map(entry => entry.id)).toEqual([74, 0, 1, 2]);
        expect(native.originalData.entries[native.originalDataUidMap[created.uid]].id).toBe(1);
        expect(native.originalData.entries[native.originalDataUidMap[duplicated.uid]]).toMatchObject({
            id: 2, foreign: 'kept', extensions: { foreign: { retained: true } },
        });

        // Cross-book copy through moveWorldInfoEntry executes appendWIOriginalDataEntry with the source record.
        const destination = worldInfo.convertCharacterBook({ entries: [{ id: 74, content: 'Destination' }, { id: 0, content: 'Other' }] });
        const books = new Map([
            ['Source', structuredClone(native)],
            ['Destination', structuredClone(destination)],
        ]);
        const origFetch = globalThis.fetch;
        globalThis.fetch = jest.fn(async (url, init) => {
            const body = JSON.parse(init.body);
            if (url === '/api/worldinfo/get') {
                return { ok: books.has(body.name), json: async () => structuredClone(books.get(body.name)) };
            }
            if (url === '/api/worldinfo/edit') {
                books.set(body.name, structuredClone(body.data));
                return { ok: true, json: async () => ({ name: body.name }) };
            }
            return { ok: false, status: 404, json: async () => ({}) };
        });
        try {
            worldInfo.worldInfoCache.clear();
            worldInfo.setWorldInfoSettings({}, { world_names: ['Source', 'Destination'] });
            await expect(worldInfo.moveWorldInfoEntry('Source', 'Destination', 0, { deleteOriginal: false })).resolves.toBe(true);
            const updatedDest = books.get('Destination');
            expect(updatedDest.originalData.entries.map(entry => entry.id)).toEqual([74, 0, 1]);
            expect(updatedDest.originalData.entries[2]).toMatchObject({ foreign: 'kept', extensions: { foreign: { retained: true } } });
            expect(books.get('Source').originalData.entries[0].id).toBe(74);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test('native book to card to native roundtrip keeps layout and entry node IDs through UID renumbering', async () => {
        const extensions = { foreign: { nested: ['kept'] }, sillybunny_pathfinder: { version: 1, tree: { id: 'root', children: [{ id: 'place' }] } } };
        const native = {
            extensions,
            entries: {
                7: { uid: 7, displayIndex: 1, content: 'Second', extensions: { foreign: 'seven', sillybunny_pathfinder: { version: 1, nodeId: 'place' } } },
                42: { uid: 42, displayIndex: 0, content: 'First', extensions: { foreign: 'forty-two', sillybunny_pathfinder: { version: 1, nodeId: 'root' } } },
            },
        };
        const card = await embedNativeBookInCard('Lore', native);
        const restored = worldInfo.convertCharacterBook(card);

        expect(card.entries.map(entry => entry.id)).toEqual([42, 7]);
        expect(restored.extensions).toEqual(extensions);
        expect(restored.originalData.extensions).toEqual(extensions);
        expect(restored.originalDataUidMap).toEqual({ 0: 0, 1: 1 });
        expect(restored.entries[0]).toMatchObject({ uid: 0, content: 'First', extensions: native.entries[42].extensions });
        expect(restored.entries[1]).toMatchObject({ uid: 1, content: 'Second', extensions: native.entries[7].extensions });
        expect(native).not.toHaveProperty('originalData');
        card.extensions.foreign.nested.push('card-only');
        expect(native.extensions.foreign.nested).toEqual(['kept']);
        expect(restored.extensions.foreign.nested).toEqual(['kept']);
    });

    test('imported books preserve foreign book and entry metadata alongside Pathfinder metadata', () => {
        const card = {
            name: 'Imported', foreign: 'original book metadata',
            extensions: { foreign: 'book extension', sillybunny_pathfinder: { version: 1, tree: { id: 'root' } } },
            entries: [{ id: 91, content: 'Imported entry', foreign: 'original entry metadata', extensions: { foreign: 'entry extension', sillybunny_pathfinder: { version: 1, nodeId: 'root' } } }],
        };
        const native = worldInfo.convertCharacterBook(card);
        const exported = structuredClone(native.originalData);
        const restored = worldInfo.convertCharacterBook(exported);
        expect(exported).toEqual(card);
        expect(restored.extensions).toEqual(card.extensions);
        expect(restored.entries[0]).toMatchObject({ uid: 0, extensions: card.entries[0].extensions });
        expect(restored.originalData.entries[0]).toMatchObject({ id: 91, foreign: 'original entry metadata' });
    });

    test('native book without extensions exports empty extensions on the card', async () => {
        const card = await embedNativeBookInCard('EmptyLore', { entries: {} });
        expect(card.extensions).toEqual({});
    });
});
