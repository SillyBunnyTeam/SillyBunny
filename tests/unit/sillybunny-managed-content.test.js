/* eslint-disable playwright/no-standalone-expect -- Jest contracts for plain functions. */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

import { read as readCardMetadata } from '../../src/character-card-parser.js';
import encode from '../../src/png/encode.js';
import {
    ManagedContentError,
    buildManifest,
    createManagedContent,
    fingerprintCard,
    fingerprintSpriteFile,
    fingerprintWorld,
    parseManifest,
    readManifest,
    resolveInside,
    writeInside,
} from '../../src/sillybunny-managed-content.js';
import { createCard, createCardFile, createPng, createSpriteFile, createWorldFile } from '../fixtures/managed-content/fixture-builder.js';

const temporaryRoots = [];

afterEach(() => {
    jest.restoreAllMocks();
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function makeDirectory(...parts) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-managed-'));
    temporaryRoots.push(root);
    const directory = path.join(root, ...parts);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

/** Writes files into a directory: `{ 'name.png': Buffer, 'folder/inner.webp': Buffer }`. */
function writeFiles(directory, files) {
    for (const [name, content] of Object.entries(files)) {
        const target = path.join(directory, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
}

/** Adds a text chunk the card does not own, before the image data. */
function addComment(file) {
    const chunks = extract(new Uint8Array(file));
    chunks.splice(chunks.findIndex(chunk => chunk.name === 'IDAT'), 0, PNGtext.encode('Comment', 'kept by the container'));
    return Buffer.from(encode(chunks));
}

/** A card file whose metadata is written as given, without the mirroring that the card writer of the app applies. */
function createRawCardFile(card, { keyword = 'ccv3', seed = 1, image = createPng(seed) } = {}) {
    const chunks = extract(new Uint8Array(image));
    chunks.splice(chunks.findIndex(chunk => chunk.name === 'IDAT'), 0, PNGtext.encode(keyword, Buffer.from(JSON.stringify(card)).toString('base64')));
    return Buffer.from(encode(chunks));
}

/** A World Info file with root fields beside its entries. */
function createWorldWithRoot(entries, root) {
    return Buffer.from(JSON.stringify({ ...JSON.parse(createWorldFile(entries).toString('utf8')), ...root }));
}

describe('the card fingerprint', () => {
    const baseline = () => fingerprintCard(createCardFile());

    test('is a SHA-256 that does not change between reads', () => {
        expect(baseline()).toMatch(/^[0-9a-f]{64}$/);
        expect(baseline()).toBe(baseline());
    });

    test.each([
        ['favourite', { extensions: { fav: true } }],
        ['talkativeness', { extensions: { talkativeness: 0.9 } }],
        ['tags', { tags: ['mine', 'edited'] }],
        ['linked world', { extensions: { world: 'My Own Lore' } }],
        ['an extension of another module', { extensions: { regex_scripts: [{ id: 'x' }], 'my-extension': { on: true } } }],
    ])('ignores the personal field: %s', (_name, change) => {
        expect(fingerprintCard(createCardFile({ card: createCard(change) }))).toBe(baseline());
    });

    test('ignores the root fields a card keeps beside its data block', () => {
        const card = createCard();
        card.chat = 'Another chat - 2026-02-02';
        card.create_date = '2027-07-07';
        card.fav = true;
        card.avatar = 'Something.png';

        expect(fingerprintCard(createCardFile({ card }))).toBe(baseline());
    });

    test('ignores a talkativeness written as text', () => {
        expect(fingerprintCard(createCardFile({ card: createCard({ extensions: { talkativeness: '0.35' } }) }))).toBe(baseline());
    });

    test('counts a card without a nickname or group-only greetings as one with empty ones, as the editor writes them', () => {
        const empty = createCard({ nickname: '', group_only_greetings: [] });
        const without = createCard();
        delete without.data.nickname;
        delete without.data.group_only_greetings;

        expect(fingerprintCard(createCardFile({ card: without }))).toBe(fingerprintCard(createCardFile({ card: empty })));
    });

    test('ignores the order of the keys in the card', () => {
        const card = createCard();
        const reversed = { ...card, data: Object.fromEntries(Object.entries(card.data).reverse()) };

        expect(fingerprintCard(createCardFile({ card: reversed }))).toBe(baseline());
    });

    test.each([
        ['name', { name: 'Assistant Other' }],
        ['description', { description: 'Changed.' }],
        ['personality', { personality: 'Changed.' }],
        ['scenario', { scenario: 'Changed.' }],
        ['first message', { first_mes: 'Changed.' }],
        ['example messages', { mes_example: 'Changed.' }],
        ['alternate greetings', { alternate_greetings: ['Another hello.', 'And one more.'] }],
        ['system prompt', { system_prompt: 'Changed.' }],
        ['post-history instructions', { post_history_instructions: 'Changed.' }],
        ['creator notes', { creator_notes: 'Changed.' }],
        ['creator', { creator: 'Somebody' }],
        ['character version', { character_version: '2' }],
        ['nickname', { nickname: 'Another' }],
        ['group-only greetings', { group_only_greetings: ['Only for groups.'] }],
        ['character book', { character_book: { name: 'Own Book', entries: [{ id: 1, keys: ['a'], content: 'b' }] } }],
        ['depth prompt', { extensions: { depth_prompt: { prompt: 'Remember.', depth: 4, role: 'system' } } }],
    ])('changes with the authored field: %s', (_name, change) => {
        expect(fingerprintCard(createCardFile({ card: createCard(change) }))).not.toBe(baseline());
    });

    test('changes with the image', () => {
        expect(fingerprintCard(createCardFile({ seed: 2 }))).not.toBe(baseline());
    });

    test('ignores a chunk of the container that is not image data', () => {
        expect(fingerprintCard(addComment(createCardFile()))).toBe(baseline());
    });

    test('reads a card that only has the V2 chunk', () => {
        const chunks = extract(new Uint8Array(createCardFile()));
        const v2Only = Buffer.from(encode(chunks.filter(chunk => chunk.name !== 'tEXt' || PNGtext.decode(chunk.data).keyword !== 'ccv3')));

        expect(fingerprintCard(v2Only)).toBe(baseline());
    });

    test('counts an empty depth prompt as none, because the editor writes one into every card it saves', () => {
        const without = createCard();
        delete without.data.extensions.depth_prompt;
        const blank = createCard({ extensions: { depth_prompt: { prompt: '   ', depth: 9, role: 'user' } } });

        expect(fingerprintCard(createCardFile({ card: without }))).toBe(baseline());
        expect(fingerprintCard(createCardFile({ card: blank }))).toBe(baseline());
    });

    test('counts a character book that is the linked world as none, because the editor embeds the linked world', () => {
        const embedded = createCard({ character_book: { name: 'SillyBunny Lexicon', entries: [{ keys: ['a'], content: 'b' }], extensions: {} } });

        expect(fingerprintCard(createCardFile({ card: embedded }))).toBe(baseline());
    });

    test.each([
        ['description', br => ({ description: `one${br}two` })],
        ['personality', br => ({ personality: `one${br}two` })],
        ['scenario', br => ({ scenario: `one${br}two` })],
        ['first message', br => ({ first_mes: `one${br}two` })],
        ['example messages', br => ({ mes_example: `<START>${br}{{user}}: hi` })],
        ['system prompt', br => ({ system_prompt: `one${br}two` })],
        ['post-history instructions', br => ({ post_history_instructions: `one${br}two` })],
        ['creator notes', br => ({ creator_notes: `one${br}two` })],
        ['alternate greetings', br => ({ alternate_greetings: [`one${br}two`, 'plain'] })],
        ['group-only greetings', br => ({ group_only_greetings: [`one${br}two`] })],
        ['depth prompt', br => ({ extensions: { depth_prompt: { prompt: `one${br}two`, depth: 4, role: 'system' } } })],
    ])('counts a line break in the %s as one, whether it is written as CRLF or CR, because a browser form sends CRLF', (_name, change) => {
        const lineFeed = fingerprintCard(createCardFile({ card: createCard(change('\n')) }));

        expect(fingerprintCard(createCardFile({ card: createCard(change('\r\n')) }))).toBe(lineFeed);
        expect(fingerprintCard(createCardFile({ card: createCard(change('\r')) }))).toBe(lineFeed);
    });

    test('still tells a changed line apart from a line break', () => {
        const text = br => fingerprintCard(createCardFile({ card: createCard({ description: `one${br}two` }) }));

        expect(text('\r\n')).not.toBe(fingerprintCard(createCardFile({ card: createCard({ description: 'one two' }) })));
    });

    test('reads the creator notes from the root of a card that has none in its data, as the card parser does', () => {
        const withData = createCard({ creator_notes: 'Notes.' });
        const rootOnly = createCard({ creator_notes: 'Notes.' });
        delete rootOnly.data.creator_notes;
        rootOnly.creatorcomment = 'Notes.';

        expect(fingerprintCard(createRawCardFile(rootOnly))).toBe(fingerprintCard(createRawCardFile(withData)));
        expect(fingerprintCard(createRawCardFile(rootOnly))).not.toBe(fingerprintCard(createRawCardFile(createCard({ creator_notes: '' }))));
    });

    test('prefers the creator notes of the data over the root ones', () => {
        const card = createCard({ creator_notes: 'In data.' });
        card.creatorcomment = 'At the root.';

        expect(fingerprintCard(createRawCardFile(card))).toBe(fingerprintCard(createRawCardFile(createCard({ creator_notes: 'In data.' }))));
    });

    test('reads the creator notes of a card that only has the V2 chunk and no data block', () => {
        const flat = { name: 'Assistant Fixture', creatorcomment: 'Notes.' };
        const flatWithNotes = { name: 'Assistant Fixture', creator_notes: 'Notes.' };

        expect(fingerprintCard(createRawCardFile(flat, { keyword: 'chara' }))).toBe(fingerprintCard(createRawCardFile(flatWithNotes, { keyword: 'chara' })));
    });

    describe('with the worlds of the manifest', () => {
        const lexiconBook = { name: 'SillyBunny Lexicon', entries: [], extensions: {} };
        const unlinked = () => createCardFile({ card: createCard({ character_book: lexiconBook, extensions: { world: '' } }) });

        test('counts a book named after one of them as none, because the editor leaves the embedded copy when the world is unlinked', () => {
            expect(fingerprintCard(unlinked(), { worldNames: ['SillyBunny Lexicon'] })).toBe(baseline());
            expect(fingerprintCard(unlinked())).not.toBe(baseline());
        });

        test('counts a book with another name as authored', () => {
            const other = createCardFile({ card: createCard({ character_book: { ...lexiconBook, name: 'Own Book' }, extensions: { world: '' } }) });

            expect(fingerprintCard(other, { worldNames: ['SillyBunny Lexicon'] })).not.toBe(baseline());
        });
    });

    test('refuses a file that is not a card', () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});

        expect(() => fingerprintCard(Buffer.from('not a png'))).toThrow();
        expect(() => fingerprintCard(createPng(1))).toThrow();
    });
});

describe('the world and sprite fingerprints', () => {
    const entries = [{ key: ['alpha'], content: 'First entry.' }, { key: ['beta'], content: 'Second entry.' }];

    test('a world ignores the uid and the display order of its entries', () => {
        const renumbered = createWorldFile([entries[1], entries[0]].map((entry, index) => ({ ...entry, uid: index + 40, displayIndex: 9 - index })));
        const same = createWorldFile(entries);
        const reordered = createWorldFile([entries[1], entries[0]]);

        expect(fingerprintWorld(reordered)).toBe(fingerprintWorld(same));
        expect(fingerprintWorld(renumbered)).toBe(fingerprintWorld(same));
    });

    test('a world changes with the content of an entry', () => {
        expect(fingerprintWorld(createWorldFile([entries[0], { ...entries[1], content: 'Edited.' }]))).not.toBe(fingerprintWorld(createWorldFile(entries)));
    });

    test('a world changes with the root extensions the user keeps on it, in any key order', () => {
        const plain = fingerprintWorld(createWorldFile(entries));
        const withLayout = fingerprintWorld(createWorldWithRoot(entries, { extensions: { layout: 'mine', folder: 'a' } }));

        expect(withLayout).not.toBe(plain);
        expect(fingerprintWorld(createWorldWithRoot(entries, { extensions: { folder: 'a', layout: 'mine' } }))).toBe(withLayout);
    });

    test.each([
        ['absent', {}],
        ['empty', { extensions: {} }],
        ['not an object', { extensions: 'text' }],
    ])('a world counts root extensions that are %s as none', (_name, root) => {
        expect(fingerprintWorld(createWorldWithRoot(entries, root))).toBe(fingerprintWorld(createWorldFile(entries)));
    });

    test('a world ignores its root name and original data, which the import and the editor set and which say nothing the entries do not', () => {
        const plain = fingerprintWorld(createWorldFile(entries));

        expect(fingerprintWorld(createWorldWithRoot(entries, { name: 'Renamed', originalData: { source: 'import' } }))).toBe(plain);
    });

    test('a sprite file is the SHA-256 of its bytes', () => {
        expect(fingerprintSpriteFile(createSpriteFile(1))).toMatch(/^[0-9a-f]{64}$/);
        expect(fingerprintSpriteFile(createSpriteFile(1))).not.toBe(fingerprintSpriteFile(createSpriteFile(2)));
    });
});

describe('the pinned fingerprints', () => {
    // Shipped manifests store fingerprints and compare them with those of the files of users for as long as an old
    // release is in use. A different algorithm makes all of them differ, so these values change only together with a
    // new manifest format.
    const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAABE0lEQVR4AQEIAff+ACVbDf82Ww3/R1sN/1hbDf9pWw3/elsN/4tbDf+cWw3/ACV4Df82eA7/R3gP/1h4EP9peBH/engS/4t4E/+ceBT/ACWVDf82lQ//R5UR/1iVE/9plRX/epUX/4uVGf+clRv/ACWyDf82shD/R7IT/1iyFv9pshn/erIc/4uyH/+csiL/ACXPDf82zxH/R88V/1jPGf9pzx3/es8h/4vPJf+czyn/ACXsDf827BL/R+wX/1jsHP9p7CH/euwm/4vsK/+c7DD/ACUJDf82CRP/RwkZ/1gJH/9pCSX/egkr/4sJMf+cCTf/ACUmDf82JhT/RyYb/1gmIv9pJin/eiYw/4smN/+cJj7/PEd+Ucn9Z1wAAAAASUVORK5CYII=', 'base64');

    const CARD = {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name: 'Pinned',
            description: 'First line.\r\nSecond line.',
            personality: 'Calm.',
            scenario: 'A room.',
            first_mes: 'Hello.',
            mes_example: '<START>\n{{user}}: Hi',
            system_prompt: 'Rules.',
            post_history_instructions: 'After.',
            creator_notes: 'Notes.',
            creator: 'Somebody',
            character_version: '3.0',
            nickname: 'Pin',
            alternate_greetings: ['Alternate one.', 'Alternate two.'],
            group_only_greetings: ['Only in groups.'],
            character_book: { name: 'Own Book', entries: [{ keys: ['a'], content: 'b' }] },
            // Personal fields, which must not count.
            tags: ['one', 'two'],
            extensions: { talkativeness: '0.35', fav: true, world: 'Elsewhere', depth_prompt: { prompt: 'Remember.', depth: 2, role: 'user' }, other: { on: true } },
        },
        chat: 'Pinned - 2026-01-01',
        create_date: '2026-01-01',
    };

    test('a card', () => {
        expect(fingerprintCard(createRawCardFile(CARD, { image: IMAGE }))).toBe('16db0101c85c7bff83ac8fc9f2403a841ad1ea49d4bc0ba360757a6c674a19af');
    });

    test('a card with the world of the manifest embedded in it', () => {
        const embedded = { ...CARD, data: { ...CARD.data, character_book: { name: 'Pinned Lexicon', entries: [] } } };
        const without = { ...CARD, data: { ...CARD.data, character_book: undefined } };

        expect(fingerprintCard(createRawCardFile(embedded, { image: IMAGE }), { worldNames: ['Pinned Lexicon'] })).toBe(fingerprintCard(createRawCardFile(without, { image: IMAGE })));
    });

    test('a world', () => {
        const world = JSON.stringify({
            name: 'Pinned Lexicon',
            extensions: { layout: 'a' },
            entries: {
                1: { uid: 1, displayIndex: 4, key: ['alpha'], content: 'First.', comment: 'c' },
                0: { uid: 0, displayIndex: 3, key: ['beta'], content: 'Second.', comment: 'd' },
            },
        });

        expect(fingerprintWorld(Buffer.from(world))).toBe('d8d5334bb45a6748b8306ee4159364907db51e0ae0a0aa0f97c0615184025dfa');
    });

    test('a sprite file', () => {
        expect(fingerprintSpriteFile(Buffer.from('sprite bytes'))).toBe('896db05565eea167098e2ed376f2dbf565077bd663668bd12f3c1927e8afa5a6');
    });
});

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

describe('the manifest', () => {
    const card = { filename: 'default_AssistantReisen.png', type: 'character', version: 2, fingerprint: HASH, previousFingerprints: [OTHER_HASH] };
    const world = { filename: 'SillyBunny Lexicon.json', type: 'world', version: 1, fingerprint: HASH, previousFingerprints: [] };
    const sprites = { filename: 'Assistant Reisen', type: 'sprites', version: 1, files: [{ name: 'joy.webp', sha256: HASH, previous: [OTHER_HASH] }] };
    const manifestOf = (...items) => ({ format: 1, items });

    test('lists each managed card, world and sprite folder as it was written', () => {
        expect(parseManifest(manifestOf(card, world, sprites)).items).toEqual([card, world, sprites]);
    });

    test('is empty where the file is absent, so a directory without a manifest manages nothing', () => {
        expect(readManifest(makeDirectory())).toEqual({ format: 1, items: [] });
    });

    test('is read from the bundled directory', () => {
        const directory = makeDirectory();
        writeFiles(directory, { 'sillybunny-managed.json': JSON.stringify(manifestOf(card)) });

        expect(readManifest(directory).items).toEqual([card]);
    });

    test.each([
        ['not an object', 'text'],
        ['another format', { format: 2, items: [] }],
        ['no items', { format: 1 }],
        ['a filename with a folder', manifestOf({ ...card, filename: 'folder/card.png' })],
        ['a filename that climbs out', manifestOf({ ...card, filename: '../card.png' })],
        ['a filename with a backslash', manifestOf({ ...card, filename: 'folder\\card.png' })],
        ['a hidden filename', manifestOf({ ...card, filename: '.card.png' })],
        ['a card that is not a PNG', manifestOf({ ...card, filename: 'card.json' })],
        ['a world that is not JSON', manifestOf({ ...world, filename: 'world.png' })],
        ['an unknown type', manifestOf({ ...card, type: 'theme' })],
        ['a version that is not a whole number above zero', manifestOf({ ...card, version: 0 })],
        ['a fingerprint that is not a SHA-256', manifestOf({ ...card, fingerprint: 'abc' })],
        ['an earlier fingerprint that is not a SHA-256', manifestOf({ ...card, previousFingerprints: ['abc'] })],
        ['earlier fingerprints that are not a list', manifestOf({ ...card, previousFingerprints: HASH })],
        ['the same filename twice', manifestOf(card, card)],
        ['sprites without files', manifestOf({ ...sprites, files: undefined })],
        ['a sprite file with a folder in its name', manifestOf({ ...sprites, files: [{ name: '../joy.webp', sha256: HASH, previous: [] }] })],
        ['a sprite file twice', manifestOf({ ...sprites, files: [sprites.files[0], sprites.files[0]] })],
        ['a sprite hash that is not a SHA-256', manifestOf({ ...sprites, files: [{ name: 'joy.webp', sha256: 'abc', previous: [] }] })],
    ])('is refused with %s', (_name, value) => {
        expect(() => parseManifest(value)).toThrow(/manifest/i);
    });
});

describe('building the manifest', () => {
    const entries = [
        { filename: 'default_AssistantReisen.png', type: 'character' },
        { filename: 'Assistant Reisen', type: 'sprites' },
        { filename: 'SillyBunny Lexicon.json', type: 'world' },
    ];

    function bundle({ card = createCardFile(), sprites = { 'joy.webp': createSpriteFile(1), 'sad.webp': createSpriteFile(2) }, world = createWorldFile([{ content: 'One.' }]) } = {}) {
        const directory = makeDirectory();
        writeFiles(directory, { 'default_AssistantReisen.png': card, 'SillyBunny Lexicon.json': world });
        for (const [name, content] of Object.entries(sprites)) {
            writeFiles(path.join(directory, 'Assistant Reisen'), { [name]: content });
        }
        return directory;
    }

    test('fingerprints every item of a new bundle at version 1', () => {
        const directory = bundle();

        expect(buildManifest({ bundledDirectory: directory, entries })).toEqual({
            format: 1,
            items: [
                { filename: 'default_AssistantReisen.png', type: 'character', version: 1, fingerprint: fingerprintCard(createCardFile()), previousFingerprints: [] },
                {
                    filename: 'Assistant Reisen',
                    type: 'sprites',
                    version: 1,
                    files: [
                        { name: 'joy.webp', sha256: fingerprintSpriteFile(createSpriteFile(1)), previous: [] },
                        { name: 'sad.webp', sha256: fingerprintSpriteFile(createSpriteFile(2)), previous: [] },
                    ],
                },
                { filename: 'SillyBunny Lexicon.json', type: 'world', version: 1, fingerprint: fingerprintWorld(createWorldFile([{ content: 'One.' }])), previousFingerprints: [] },
            ],
        });
    });

    test('fingerprints a card the same with the copy of a world of the manifest that the editor leaves on it', () => {
        const embedded = createCardFile({ card: createCard({ character_book: { name: 'SillyBunny Lexicon', entries: [], extensions: {} }, extensions: { world: '' } }) });

        const withCopy = buildManifest({ bundledDirectory: bundle({ card: embedded }), entries });
        const without = buildManifest({ bundledDirectory: bundle(), entries });

        expect(withCopy.items[0].fingerprint).toBe(without.items[0].fingerprint);
    });

    test('keeps the version of an item that did not change', () => {
        const first = buildManifest({ bundledDirectory: bundle(), entries });

        expect(buildManifest({ bundledDirectory: bundle(), entries, previous: first })).toEqual(first);
    });

    test('raises the version of a changed card and remembers its fingerprint as an earlier one', () => {
        const first = buildManifest({ bundledDirectory: bundle(), entries });
        const edited = createCardFile({ card: createCard({ first_mes: 'A new greeting.', character_version: '2' }) });

        const second = buildManifest({ bundledDirectory: bundle({ card: edited }), entries, previous: first });
        const third = buildManifest({ bundledDirectory: bundle({ card: createCardFile({ card: createCard({ first_mes: 'A third greeting.', character_version: '3' }) }) }), entries, previous: second });

        expect(second.items[0]).toMatchObject({ version: 2, fingerprint: fingerprintCard(edited), previousFingerprints: [first.items[0].fingerprint] });
        expect(third.items[0].version).toBe(3);
        expect(third.items[0].previousFingerprints).toEqual([second.items[0].fingerprint, first.items[0].fingerprint]);
    });

    test('raises the version of sprites when a file changed, and remembers the hash of that file', () => {
        const first = buildManifest({ bundledDirectory: bundle(), entries });

        const second = buildManifest({ bundledDirectory: bundle({ sprites: { 'joy.webp': createSpriteFile(7), 'sad.webp': createSpriteFile(2) } }), entries, previous: first });

        expect(second.items[1].version).toBe(2);
        expect(second.items[1].files[0]).toEqual({ name: 'joy.webp', sha256: fingerprintSpriteFile(createSpriteFile(7)), previous: [fingerprintSpriteFile(createSpriteFile(1))] });
        expect(second.items[1].files[1].previous).toEqual([]);
    });

    test('raises the version of sprites when a file was added', () => {
        const first = buildManifest({ bundledDirectory: bundle(), entries });

        const second = buildManifest({ bundledDirectory: bundle({ sprites: { 'joy.webp': createSpriteFile(1), 'sad.webp': createSpriteFile(2), 'new.webp': createSpriteFile(3) } }), entries, previous: first });

        expect(second.items[1].version).toBe(2);
        expect(second.items[1].files.map(file => file.name)).toEqual(['joy.webp', 'new.webp', 'sad.webp']);
    });

    test('takes a character version written as a decimal', () => {
        const first = buildManifest({ bundledDirectory: bundle({ card: createCardFile({ card: createCard({ character_version: '1.0' }) }) }), entries });
        const second = buildManifest({ bundledDirectory: bundle({ card: createCardFile({ card: createCard({ character_version: '2.0', first_mes: 'New.' }) }) }), entries, previous: first });

        expect([first.items[0].version, second.items[0].version]).toEqual([1, 2]);
    });

    test('is refused for a card whose character version is not its manifest version, so edited cards can tell they are behind', () => {
        const first = buildManifest({ bundledDirectory: bundle(), entries });
        const forgotten = createCardFile({ card: createCard({ first_mes: 'A new greeting.' }) });

        expect(() => buildManifest({ bundledDirectory: bundle({ card: forgotten }), entries, previous: first })).toThrow(/character_version.*"2"/);
    });

    test('is refused when a bundled file is missing, so a manifest never lists what does not ship', () => {
        const directory = bundle();
        fs.rmSync(path.join(directory, 'default_AssistantReisen.png'));

        expect(() => buildManifest({ bundledDirectory: directory, entries })).toThrow(/default_AssistantReisen\.png/);
    });
});

const REISEN = 'default_AssistantReisen.png';
const LEXICON = 'SillyBunny Lexicon.json';
const SPRITES = 'Assistant Reisen';
const ENTRIES = [
    { filename: REISEN, type: 'character' },
    { filename: SPRITES, type: 'sprites' },
    { filename: LEXICON, type: 'world' },
];

/** The files of one bundled version: the card and the lexicon change with it, one sprite changes and one never does. */
function bundleFiles(version, { seed = 1, card = {} } = {}) {
    return {
        [REISEN]: createCardFile({ seed, card: createCard({ character_version: String(version), first_mes: `Hello, version ${version}.`, ...card }) }),
        [LEXICON]: createWorldFile([{ key: ['alpha'], content: `Lore of version ${version}.` }]),
        [`${SPRITES}/joy.webp`]: createSpriteFile(version),
        [`${SPRITES}/sad.webp`]: createSpriteFile(100),
    };
}

/** Publishes the versions in order, as releases do, and returns the directory of the last one with its manifest. */
function publish(...versions) {
    let manifest = null;
    let directory;
    for (const release of versions) {
        const { version, seed } = typeof release === 'number' ? { version: release } : release;
        directory = makeDirectory();
        writeFiles(directory, bundleFiles(version, { seed }));
        manifest = buildManifest({ bundledDirectory: directory, entries: ENTRIES, previous: manifest });
    }
    writeFiles(directory, { 'sillybunny-managed.json': JSON.stringify(manifest) });
    return { directory, manifest };
}

function createUser() {
    const root = makeDirectory('user');
    const user = { root, characters: path.join(root, 'characters'), worlds: path.join(root, 'worlds'), backups: path.join(root, 'backups') };
    for (const directory of [user.characters, user.worlds, user.backups]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    return user;
}

/** Puts bundle files where seeding puts them: cards and sprite folders in `characters`, worlds in `worlds`. */
function install(user, files) {
    for (const [name, content] of Object.entries(files)) {
        writeFiles(name === LEXICON ? user.worlds : user.characters, { [name]: content });
    }
}

function logContent(user, ...names) {
    fs.writeFileSync(path.join(user.root, 'content.log'), names.join('\n'));
}

const FIXED_CLOCK = () => new Date('2026-11-02T10:20:30.456Z');

function setup({ published = [1], installed = null, logged = [], setPermissions = undefined, now = FIXED_CLOCK, readItems = undefined } = {}) {
    const { directory, manifest } = publish(...published);
    const user = createUser();
    if (installed !== null) {
        install(user, installed);
    }
    if (logged.length > 0) {
        logContent(user, ...logged);
    }
    const managed = createManagedContent({ bundledDirectory: directory, directories: user, now, setPermissions, readItems });
    return { managed, user, directory, manifest };
}

const statusOf = (managed, filename) => managed.status().find(item => item.filename === filename);
const statuses = managed => Object.fromEntries(managed.status().map(item => [item.filename, item.status]));

describe('the status of managed content', () => {
    test('lists nothing where nothing is managed', () => {
        const user = createUser();

        expect(createManagedContent({ bundledDirectory: makeDirectory(), directories: user }).status()).toEqual([]);
    });

    test('is not installed for an item that was never seeded, because seeding will bring it', () => {
        const { managed } = setup();

        expect(statuses(managed)).toEqual({ [REISEN]: 'not-installed', [SPRITES]: 'not-installed', [LEXICON]: 'not-installed' });
    });

    test('is deleted for an item that was seeded and is gone, because the user removed it', () => {
        const { managed } = setup({ logged: [REISEN, SPRITES, LEXICON] });

        expect(statuses(managed)).toEqual({ [REISEN]: 'deleted', [SPRITES]: 'deleted', [LEXICON]: 'deleted' });
    });

    test('is current for the files of the bundled version, with the version it reports', () => {
        const { managed } = setup({ published: [1, 2], installed: bundleFiles(2) });

        expect(statuses(managed)).toEqual({ [REISEN]: 'current', [SPRITES]: 'current', [LEXICON]: 'current' });
        expect(statusOf(managed, REISEN)).toMatchObject({ type: 'character', version: 2, updateAvailable: false });
    });

    test('is current for a card the user favourited, tagged and chatted with', () => {
        const card = { tags: ['mine'], extensions: { fav: true, talkativeness: 0.9 } };
        const { managed } = setup({ installed: bundleFiles(1, { card }) });

        expect(statusOf(managed, REISEN).status).toBe('current');
    });

    test('is updated for the files of an earlier bundled version, which nobody has edited', () => {
        const { managed } = setup({ published: [1, 2], installed: bundleFiles(1) });

        expect(statuses(managed)).toEqual({ [REISEN]: 'updated', [SPRITES]: 'updated', [LEXICON]: 'updated' });
        expect(statusOf(managed, REISEN).updateAvailable).toBe(true);
    });

    test('is modified for a card with text of the user, and offers the update only while the card is behind', () => {
        const behind = setup({ published: [1, 2], installed: bundleFiles(1, { card: { description: 'Mine.' } }) });
        const upToDate = setup({ published: [1, 2], installed: bundleFiles(2, { card: { description: 'Mine.' } }) });

        expect(statusOf(behind.managed, REISEN)).toMatchObject({ status: 'modified', installedVersion: 1, updateAvailable: true });
        expect(statusOf(upToDate.managed, REISEN)).toMatchObject({ status: 'modified', installedVersion: 2, updateAvailable: false });
    });

    test('reads the version of an edited card that is written as a decimal', () => {
        const { managed } = setup({ published: [1, 2], installed: bundleFiles(1, { card: { description: 'Mine.', character_version: '1.0' } }) });

        expect(statusOf(managed, REISEN)).toMatchObject({ status: 'modified', installedVersion: 1, updateAvailable: true });
    });

    test('is modified for a card whose version the user erased, and offers the update', () => {
        const { managed } = setup({ published: [1, 2], installed: bundleFiles(1, { card: { character_version: '' } }) });

        expect(statusOf(managed, REISEN)).toMatchObject({ status: 'modified', installedVersion: null, updateAvailable: true });
    });

    test('is modified for a card with another image', () => {
        const { managed } = setup({ installed: bundleFiles(1, { seed: 9 }) });

        expect(statusOf(managed, REISEN).status).toBe('modified');
    });

    test('is modified, and does not fail, for a card that is not a card', () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const { managed } = setup({ installed: { ...bundleFiles(1), [REISEN]: Buffer.from('garbage') } });

        expect(statusOf(managed, REISEN).status).toBe('modified');
    });

    test('is modified for a card that is a link, so a file outside the data folder is never read or replaced', () => {
        const { managed, user } = setup({ installed: bundleFiles(1) });
        const outside = path.join(makeDirectory(), 'outside.png');
        fs.writeFileSync(outside, bundleFiles(1)[REISEN]);
        fs.rmSync(path.join(user.characters, REISEN));
        fs.symlinkSync(outside, path.join(user.characters, REISEN));

        expect(statusOf(managed, REISEN).status).toBe('modified');
    });

    test('is modified for a world with an entry of the user, and never offers an update', () => {
        const { managed } = setup({ published: [1, 2], installed: { ...bundleFiles(1), [LEXICON]: createWorldFile([{ key: ['alpha'], content: 'My lore.' }]) } });

        expect(statusOf(managed, LEXICON)).toMatchObject({ status: 'modified', updateAvailable: false });
    });

    test('is updated for sprites when a file is missing or at an earlier version, and modified when the user changed one', () => {
        const missing = setup({ installed: { ...bundleFiles(1) } });
        fs.rmSync(path.join(missing.user.characters, SPRITES, 'sad.webp'));
        const earlier = setup({ published: [1, 2], installed: bundleFiles(1) });
        const edited = setup({ installed: bundleFiles(1) });
        fs.writeFileSync(path.join(edited.user.characters, SPRITES, 'sad.webp'), createSpriteFile(55));

        expect(statusOf(missing.managed, SPRITES)).toMatchObject({ status: 'updated', updateAvailable: true });
        expect(statusOf(earlier.managed, SPRITES).status).toBe('updated');
        expect(statusOf(edited.managed, SPRITES)).toMatchObject({ status: 'modified', updateAvailable: false });
    });

    test('is current for a card whose world was unlinked in the editor, which leaves the embedded copy of the world on the card', () => {
        const embedded = { name: 'SillyBunny Lexicon', entries: [], extensions: {} };
        const { managed } = setup({ installed: bundleFiles(1, { card: { character_book: embedded, extensions: { world: '' } } }) });

        expect(statusOf(managed, REISEN).status).toBe('current');
    });

    test('is modified for a card with a book of its own, even beside the worlds of the manifest', () => {
        const own = { name: 'Own Book', entries: [], extensions: {} };
        const { managed } = setup({ installed: bundleFiles(1, { card: { character_book: own, extensions: { world: '' } } }) });

        expect(statusOf(managed, REISEN).status).toBe('modified');
    });

    test('does not offer an update for a card that is a link, because applying it is refused', () => {
        const { managed, user } = setup({ published: [1, 2], installed: bundleFiles(1) });
        const outside = path.join(makeDirectory(), 'outside.png');
        fs.writeFileSync(outside, bundleFiles(1)[REISEN]);
        fs.rmSync(path.join(user.characters, REISEN));
        fs.symlinkSync(outside, path.join(user.characters, REISEN));

        expect(statusOf(managed, REISEN)).toMatchObject({ status: 'modified', installedVersion: null, updateAvailable: false });
        expect(() => managed.apply(REISEN)).toThrow(expect.objectContaining({ code: 'unsafe_target' }));
    });

    test('is modified for a world with root extensions of the user, which its entries do not show', () => {
        const mine = createWorldWithRoot([{ key: ['alpha'], content: 'Lore of version 1.' }], { extensions: { layout: 'mine' } });
        const { managed } = setup({ published: [1, 2], installed: { ...bundleFiles(1), [LEXICON]: mine } });

        expect(statusOf(managed, LEXICON)).toMatchObject({ status: 'modified', updateAvailable: false });
    });

    test('is empty, with a warning, when the manifest is broken, so a bad build never stops the start', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const directory = makeDirectory();
        writeFiles(directory, { 'sillybunny-managed.json': '{ not json' });

        expect(createManagedContent({ bundledDirectory: directory, directories: createUser() }).status()).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
    });
});

const BACKUP_STAMP = '2026-11-02T10-20-30-456Z';
const readUserCard = (user, filename = REISEN) => JSON.parse(readCardMetadata(fs.readFileSync(path.join(user.characters, filename))));
const readUserBytes = (user, ...parts) => fs.readFileSync(path.join(user.characters, ...parts));
const backupFiles = user => (fs.existsSync(path.join(user.backups, 'managed')) ? fs.readdirSync(path.join(user.backups, 'managed')).sort() : []);

/** A card as a user leaves it after using it: marked as a favourite, tagged, and given an extension of another module. */
const usedCard = { tags: ['mine'], extensions: { fav: true, talkativeness: 0.9, world: 'My Own Lore', 'my-extension': { on: true } } };

describe('reconciling managed content', () => {
    test('brings an untouched card to the bundled version and keeps what the user set on it', () => {
        const { managed, user, manifest } = setup({ published: [1, 2], installed: bundleFiles(1, { card: usedCard }) });
        const before = readUserCard(user);
        before.chat = 'My chat - 2026-05-05';
        before.create_date = '2026-05-05 @10h 00m 00s 000ms';
        fs.writeFileSync(path.join(user.characters, REISEN), createCardFile({ card: before }));

        expect(managed.reconcile()).toContain(REISEN);

        const after = readUserCard(user);
        expect(fingerprintCard(readUserBytes(user, REISEN))).toBe(manifest.items[0].fingerprint);
        expect(after.data.first_mes).toBe('Hello, version 2.');
        expect(after.data.character_version).toBe('2');
        expect(after.data.tags).toEqual(['mine']);
        expect(after.data.extensions).toMatchObject({ fav: true, talkativeness: 0.9, world: 'My Own Lore', 'my-extension': { on: true } });
        expect(after.fav).toBe(true);
        expect(after.chat).toBe('My chat - 2026-05-05');
        expect(after.create_date).toBe('2026-05-05 @10h 00m 00s 000ms');
    });

    test('takes the image of the new version, and keeps the file of the user when the image did not change', () => {
        const newImage = setup({ published: [1, { version: 2, seed: 5 }], installed: bundleFiles(1) });
        const sameImage = setup({ published: [1, 2], installed: { ...bundleFiles(1), [REISEN]: addComment(bundleFiles(1)[REISEN]) } });

        newImage.managed.reconcile();
        sameImage.managed.reconcile();

        expect(readUserBytes(newImage.user, REISEN)).toEqual(createCardFile({ seed: 5, card: readUserCard(newImage.user) }));
        expect(extract(new Uint8Array(readUserBytes(sameImage.user, REISEN))).some(chunk => chunk.name === 'tEXt' && PNGtext.decode(chunk.data).keyword === 'Comment')).toBe(true);
    });

    test('replaces a world and the sprites of an earlier version, and adds a sprite that is missing', () => {
        const { managed, user } = setup({ published: [1, 2], installed: bundleFiles(1) });
        fs.rmSync(path.join(user.characters, SPRITES, 'sad.webp'));

        managed.reconcile();

        expect(readUserBytes(user, SPRITES, 'joy.webp')).toEqual(createSpriteFile(2));
        expect(readUserBytes(user, SPRITES, 'sad.webp')).toEqual(createSpriteFile(100));
        expect(fs.readFileSync(path.join(user.worlds, LEXICON))).toEqual(bundleFiles(2)[LEXICON]);
        expect(statuses(managed)).toEqual({ [REISEN]: 'current', [SPRITES]: 'current', [LEXICON]: 'current' });
    });

    test('keeps the world it replaces as a backup, and nothing else it replaces, because only a world holds data that no fingerprint covers', () => {
        const { managed, user } = setup({ published: [1, 2], installed: bundleFiles(1) });

        managed.reconcile();

        expect(backupFiles(user)).toEqual([`SillyBunny Lexicon-${BACKUP_STAMP}.json`]);
        expect(fs.readFileSync(path.join(user.backups, 'managed', `SillyBunny Lexicon-${BACKUP_STAMP}.json`))).toEqual(bundleFiles(1)[LEXICON]);
    });

    test('replaces no world whose backup cannot be made, and goes on with the other items', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { managed, user } = setup({ published: [1, 2], installed: bundleFiles(1) });
        fs.rmSync(user.backups, { recursive: true });
        fs.writeFileSync(user.backups, 'not a folder');

        expect(managed.reconcile()).toEqual([REISEN, SPRITES]);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(path.join(user.worlds, LEXICON))).toEqual(bundleFiles(1)[LEXICON]);
    });

    test('leaves a world with root extensions of the user exactly as it is', () => {
        const mine = createWorldWithRoot([{ key: ['alpha'], content: 'Lore of version 1.' }], { extensions: { layout: 'mine' } });
        const { managed, user } = setup({ published: [1, 2], installed: { ...bundleFiles(1), [LEXICON]: mine } });

        expect(managed.reconcile()).not.toContain(LEXICON);

        expect(fs.readFileSync(path.join(user.worlds, LEXICON))).toEqual(mine);
        expect(backupFiles(user)).toEqual([]);
    });

    test('does nothing the second time', () => {
        const { managed } = setup({ published: [1, 2], installed: bundleFiles(1) });
        managed.reconcile();

        expect(managed.reconcile()).toEqual([]);
    });

    test('leaves a card the user edited exactly as it is', () => {
        const { managed, user } = setup({ published: [1, 2], installed: bundleFiles(1, { card: { description: 'Mine.' } }) });
        const before = readUserBytes(user, REISEN);

        expect(managed.reconcile()).not.toContain(REISEN);

        expect(readUserBytes(user, REISEN)).toEqual(before);
    });

    test('leaves a world the user edited, and a sprite the user changed, exactly as they are', () => {
        const edited = { ...bundleFiles(1), [LEXICON]: createWorldFile([{ key: ['alpha'], content: 'My lore.' }]) };
        const { managed, user } = setup({ published: [1, 2], installed: edited });
        fs.writeFileSync(path.join(user.characters, SPRITES, 'sad.webp'), createSpriteFile(55));
        fs.rmSync(path.join(user.characters, SPRITES, 'joy.webp'));

        managed.reconcile();

        expect(fs.readFileSync(path.join(user.worlds, LEXICON))).toEqual(edited[LEXICON]);
        expect(readUserBytes(user, SPRITES, 'sad.webp')).toEqual(createSpriteFile(55));
        expect(readUserBytes(user, SPRITES, 'joy.webp')).toEqual(createSpriteFile(2));
    });

    test('leaves a card that is a link alone, and does not write through it', () => {
        const { managed, user } = setup({ published: [1, 2], installed: bundleFiles(1) });
        const outside = path.join(makeDirectory(), 'outside.png');
        fs.writeFileSync(outside, bundleFiles(1)[REISEN]);
        fs.rmSync(path.join(user.characters, REISEN));
        fs.symlinkSync(outside, path.join(user.characters, REISEN));

        managed.reconcile();

        expect(fs.readFileSync(outside)).toEqual(bundleFiles(1)[REISEN]);
        expect(fs.lstatSync(path.join(user.characters, REISEN)).isSymbolicLink()).toBe(true);
    });

    test('does not bring back an item the user deleted, or add one that was never seeded', () => {
        const deleted = setup({ logged: [REISEN, SPRITES, LEXICON] });
        const never = setup();

        expect(deleted.managed.reconcile()).toEqual([]);
        expect(never.managed.reconcile()).toEqual([]);

        expect(fs.readdirSync(deleted.user.characters)).toEqual([]);
        expect(fs.readdirSync(never.user.worlds)).toEqual([]);
    });

    test('goes on with the other items when one cannot be updated', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { managed, user, directory } = setup({ published: [1, 2], installed: bundleFiles(1) });
        fs.rmSync(path.join(directory, REISEN));

        expect(managed.reconcile()).toEqual([SPRITES, LEXICON]);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(readUserBytes(user, SPRITES, 'joy.webp')).toEqual(createSpriteFile(2));
    });

    test('sets the permissions of each file it writes', () => {
        const setPermissions = jest.fn();
        const { managed, user } = setup({ published: [1, 2], installed: bundleFiles(1), setPermissions });

        managed.reconcile();

        expect(setPermissions.mock.calls.map(([target]) => target).sort()).toEqual([
            path.join(user.characters, REISEN),
            path.join(user.characters, SPRITES, 'joy.webp'),
            path.join(user.worlds, LEXICON),
        ].sort());
    });
});

describe('applying an update', () => {
    test('updates a card the user edited, keeps its personal fields, and keeps the card of the user as a backup', () => {
        const edited = bundleFiles(1, { card: { ...usedCard, description: 'My own description.' } });
        const { managed, user, manifest } = setup({ published: [1, 2], installed: edited });

        const result = managed.apply(REISEN);

        expect(result).toEqual({ backup: `default_AssistantReisen-${BACKUP_STAMP}.png` });
        expect(backupFiles(user)).toEqual([result.backup]);
        expect(fs.readFileSync(path.join(user.backups, 'managed', result.backup))).toEqual(edited[REISEN]);
        const after = readUserCard(user);
        expect(after.data.description).toBe(createCard().data.description);
        expect(after.data.tags).toEqual(['mine']);
        expect(after.data.extensions).toMatchObject({ fav: true, world: 'My Own Lore', 'my-extension': { on: true } });
        expect(fingerprintCard(readUserBytes(user, REISEN))).toBe(manifest.items[0].fingerprint);
    });

    test('keeps the backup before it writes, so a card that cannot be backed up is not replaced', () => {
        const edited = bundleFiles(1, { card: { description: 'My own description.' } });
        const { managed, user } = setup({ published: [1, 2], installed: edited });
        fs.rmSync(user.backups, { recursive: true });
        fs.writeFileSync(user.backups, 'not a folder');

        expect(() => managed.apply(REISEN)).toThrow(expect.objectContaining({ code: 'backup_failed' }));

        expect(readUserBytes(user, REISEN)).toEqual(edited[REISEN]);
    });

    test('names a second backup of the same moment so it never replaces the first', () => {
        const { managed, user } = setup({ published: [1, 2], installed: bundleFiles(1, { card: { description: 'Mine.' } }) });
        const first = managed.apply(REISEN).backup;
        fs.writeFileSync(path.join(user.characters, REISEN), bundleFiles(1, { card: { description: 'Mine again.' } })[REISEN]);

        const second = managed.apply(REISEN).backup;

        expect(second).toBe(`default_AssistantReisen-${BACKUP_STAMP}-2.png`);
        expect(backupFiles(user)).toEqual([first, second].sort());
    });

    test('replaces a card that cannot be read, after keeping it', () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const { managed, user } = setup({ installed: { ...bundleFiles(1), [REISEN]: Buffer.from('garbage') } });

        const { backup } = managed.apply(REISEN);

        expect(fs.readFileSync(path.join(user.backups, 'managed', backup))).toEqual(Buffer.from('garbage'));
        expect(readUserBytes(user, REISEN)).toEqual(bundleFiles(1)[REISEN]);
    });

    test('updates an untouched card or sprite set of an earlier version the same way', () => {
        const { managed, user } = setup({ published: [1, 2], installed: bundleFiles(1) });

        const card = managed.apply(REISEN);
        const sprites = managed.apply(SPRITES);

        expect(card.backup).toBe(`default_AssistantReisen-${BACKUP_STAMP}.png`);
        expect(sprites.backup).toBe(`Assistant Reisen-${BACKUP_STAMP}`);
        expect(fs.readFileSync(path.join(user.backups, 'managed', sprites.backup, 'joy.webp'))).toEqual(createSpriteFile(1));
        expect(readUserBytes(user, SPRITES, 'joy.webp')).toEqual(createSpriteFile(2));
    });

    test.each([
        ['an item that is current', { installed: bundleFiles(1) }, REISEN, 'already_current'],
        ['an item that is not managed', { installed: bundleFiles(1) }, 'Other.png', 'unknown_item'],
        ['a name that climbs out of the folder', { installed: bundleFiles(1) }, '../default_AssistantReisen.png', 'unknown_item'],
        ['a name that is not text', { installed: bundleFiles(1) }, { toString: () => REISEN }, 'unknown_item'],
        ['an item the user deleted', { logged: [REISEN] }, REISEN, 'not_applicable'],
        ['an item that was never installed', {}, REISEN, 'not_applicable'],
        ['a world the user edited', { published: [1, 2], installed: { ...bundleFiles(1), [LEXICON]: createWorldFile([{ content: 'Mine.' }]) } }, LEXICON, 'not_applicable'],
        ['sprites the user changed', { published: [1, 2], installed: { ...bundleFiles(1), [`${SPRITES}/sad.webp`]: createSpriteFile(55) } }, SPRITES, 'not_applicable'],
    ])('is refused for %s, and changes nothing', (_name, options, filename, code) => {
        const { managed, user } = setup(options);
        const before = fs.readdirSync(user.characters).map(name => [name, fs.statSync(path.join(user.characters, name)).mtimeMs]);

        expect(() => managed.apply(filename)).toThrow(expect.objectContaining({ code }));
        expect(() => managed.apply(filename)).toThrow(ManagedContentError);

        expect(fs.readdirSync(user.characters).map(name => [name, fs.statSync(path.join(user.characters, name)).mtimeMs])).toEqual(before);
        expect(backupFiles(user)).toEqual([]);
    });

    test('is refused for a card that is a link, and writes nothing through it', () => {
        const { managed, user } = setup({ published: [1, 2], installed: bundleFiles(1) });
        const outside = path.join(makeDirectory(), 'outside.png');
        fs.writeFileSync(outside, bundleFiles(1)[REISEN]);
        fs.rmSync(path.join(user.characters, REISEN));
        fs.symlinkSync(outside, path.join(user.characters, REISEN));

        expect(() => managed.apply(REISEN)).toThrow(expect.objectContaining({ code: 'unsafe_target' }));

        expect(fs.readFileSync(outside)).toEqual(bundleFiles(1)[REISEN]);
        expect(backupFiles(user)).toEqual([]);
    });
});

describe('restoring bundled content', () => {
    test('puts back a card the user deleted, whole and without a backup', () => {
        const { managed, user } = setup({ logged: [REISEN, SPRITES, LEXICON] });

        expect(managed.restore(REISEN)).toEqual({ backup: null });

        expect(readUserBytes(user, REISEN)).toEqual(bundleFiles(1)[REISEN]);
        expect(statusOf(managed, REISEN).status).toBe('current');
        expect(backupFiles(user)).toEqual([]);
    });

    test('replaces a card the user edited with the bundled one, personal fields included, after keeping it', () => {
        const edited = bundleFiles(1, { card: { ...usedCard, description: 'Mine.' } });
        const { managed, user } = setup({ installed: edited });

        const { backup } = managed.restore(REISEN);

        expect(fs.readFileSync(path.join(user.backups, 'managed', backup))).toEqual(edited[REISEN]);
        expect(readUserBytes(user, REISEN)).toEqual(bundleFiles(1)[REISEN]);
    });

    test('puts back every sprite of a set and a world, keeping what it replaces', () => {
        const edited = { ...bundleFiles(1), [`${SPRITES}/sad.webp`]: createSpriteFile(55), [LEXICON]: createWorldFile([{ content: 'Mine.' }]) };
        const { managed, user } = setup({ installed: edited });
        fs.rmSync(path.join(user.characters, SPRITES, 'joy.webp'));
        fs.writeFileSync(path.join(user.characters, SPRITES, 'extra.webp'), createSpriteFile(77));

        const sprites = managed.restore(SPRITES);
        const world = managed.restore(LEXICON);

        expect(readUserBytes(user, SPRITES, 'joy.webp')).toEqual(createSpriteFile(1));
        expect(readUserBytes(user, SPRITES, 'sad.webp')).toEqual(createSpriteFile(100));
        expect(readUserBytes(user, SPRITES, 'extra.webp')).toEqual(createSpriteFile(77));
        expect(fs.readFileSync(path.join(user.backups, 'managed', sprites.backup, 'sad.webp'))).toEqual(createSpriteFile(55));
        expect(fs.readFileSync(path.join(user.backups, 'managed', world.backup))).toEqual(edited[LEXICON]);
        expect(fs.readFileSync(path.join(user.worlds, LEXICON))).toEqual(bundleFiles(1)[LEXICON]);
    });

    test('keeps the file of the user when the bundled file is missing', () => {
        const edited = bundleFiles(1, { card: { description: 'Mine.' } });
        const { managed, user, directory } = setup({ installed: edited });
        fs.rmSync(path.join(directory, REISEN));

        expect(() => managed.restore(REISEN)).toThrow(expect.objectContaining({ code: 'bundled_missing' }));

        expect(readUserBytes(user, REISEN)).toEqual(edited[REISEN]);
        expect(backupFiles(user)).toEqual([]);
    });

    test('is refused for an item that is current, and for one that is not managed', () => {
        const { managed } = setup({ installed: bundleFiles(1) });

        expect(() => managed.restore(REISEN)).toThrow(expect.objectContaining({ code: 'already_current' }));
        expect(() => managed.restore('Other.png')).toThrow(expect.objectContaining({ code: 'unknown_item' }));
    });

    test('is refused for sprites that are a link, and writes nothing through it', () => {
        const { managed, user } = setup({ installed: bundleFiles(1) });
        const outside = makeDirectory();
        fs.writeFileSync(path.join(outside, 'sad.webp'), createSpriteFile(55));
        fs.rmSync(path.join(user.characters, SPRITES, 'sad.webp'));
        fs.symlinkSync(path.join(outside, 'sad.webp'), path.join(user.characters, SPRITES, 'sad.webp'));

        expect(() => managed.restore(SPRITES)).toThrow(expect.objectContaining({ code: 'unsafe_target' }));

        expect(fs.readFileSync(path.join(outside, 'sad.webp'))).toEqual(createSpriteFile(55));
    });
});

describe('the backups of managed content', () => {
    const BASE_TIME = Date.UTC(2026, 10, 2, 10, 0, 0);
    const stampAt = seconds => new Date(BASE_TIME + seconds * 1000).toISOString().replace(/[:.]/g, '-');

    /** A managed content whose clock the test moves, with the card of the user edited anew before each call. */
    function setupWithClock(options = {}) {
        let seconds = 0;
        const context = setup({ ...options, now: () => new Date(BASE_TIME + seconds * 1000) });
        return { ...context, tick: () => { seconds += 1; } };
    }

    const editCard = (user, round) => fs.writeFileSync(path.join(user.characters, REISEN), bundleFiles(1, { card: { description: `Mine ${round}.` } })[REISEN]);

    test('keeps the newest five of an item and removes the older ones', () => {
        const { managed, user, tick } = setupWithClock({ installed: bundleFiles(1) });

        for (let round = 0; round < 8; round++) {
            editCard(user, round);
            managed.apply(REISEN);
            tick();
        }

        expect(backupFiles(user)).toEqual([3, 4, 5, 6, 7].map(second => `default_AssistantReisen-${stampAt(second)}.png`));
    });

    test('keeps the newest five when many are made in the same moment, by their number and not by their text', () => {
        const { managed, user } = setupWithClock({ installed: bundleFiles(1) });

        for (let round = 0; round < 11; round++) {
            editCard(user, round);
            managed.apply(REISEN);
        }

        expect(backupFiles(user)).toEqual([7, 8, 9, 10, 11].map(number => `default_AssistantReisen-${stampAt(0)}-${number}.png`).sort());
    });

    test('never removes the backups of another item, or a file that is not a backup', () => {
        const { managed, user, tick } = setupWithClock({ installed: bundleFiles(1) });
        const directory = path.join(user.backups, 'managed');
        fs.mkdirSync(directory, { recursive: true });
        const decoys = ['default_AssistantReisen-notes.txt', 'default_AssistantReisen-2026-01-01.png', 'default_AssistantReisen.png', 'default_AssistantReisen-2026-01-01T00-00-00-000Z.json', 'Other-2026-01-01T00-00-00-000Z.png'];
        decoys.forEach(name => fs.writeFileSync(path.join(directory, name), 'decoy'));
        fs.mkdirSync(path.join(directory, 'default_AssistantReisen-2026-01-01T00-00-00-000Z.png'));
        fs.writeFileSync(path.join(user.worlds, LEXICON), createWorldFile([{ content: 'Mine.' }]));
        const worldBackup = managed.restore(LEXICON).backup;

        for (let round = 0; round < 8; round++) {
            editCard(user, round);
            managed.apply(REISEN);
            tick();
        }

        const left = fs.readdirSync(directory);
        expect(left).toContain(worldBackup);
        expect(left).toEqual(expect.arrayContaining(decoys));
        expect(left.filter(name => /^default_AssistantReisen-\d{4}-.*Z\.png$/.test(name) && fs.statSync(path.join(directory, name)).isFile())).toHaveLength(5);
    });

    test('does not mistake the item whose name starts the same for the same item', () => {
        const { managed, user, tick } = setupWithClock({ installed: bundleFiles(1) });
        const directory = path.join(user.backups, 'managed');
        fs.mkdirSync(directory, { recursive: true });
        const longer = Array.from({ length: 7 }, (_, index) => `default_AssistantReisen Two-${stampAt(-100 - index)}.png`);
        longer.forEach(name => fs.writeFileSync(path.join(directory, name), 'other item'));

        for (let round = 0; round < 2; round++) {
            editCard(user, round);
            managed.apply(REISEN);
            tick();
        }

        expect(fs.readdirSync(directory)).toEqual(expect.arrayContaining(longer));
    });

    test('keeps the newest five sets of sprite backups', () => {
        const { managed, user, tick } = setupWithClock({ installed: bundleFiles(1) });

        for (let round = 0; round < 8; round++) {
            fs.writeFileSync(path.join(user.characters, SPRITES, 'sad.webp'), createSpriteFile(150 + round));
            managed.restore(SPRITES);
            tick();
        }

        expect(backupFiles(user)).toEqual([3, 4, 5, 6, 7].map(second => `${SPRITES}-${stampAt(second)}`).sort());
    });

    test('keeps the update when the old backups cannot be removed', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { managed, user, tick } = setupWithClock({ installed: bundleFiles(1) });
        for (let round = 0; round < 5; round++) {
            editCard(user, round);
            managed.apply(REISEN);
            tick();
        }
        const rmSync = jest.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('EBUSY'); });
        editCard(user, 99);

        expect(() => managed.apply(REISEN)).not.toThrow();

        rmSync.mockRestore();
        expect(warn).toHaveBeenCalled();
        expect(statusOf(managed, REISEN).status).toBe('current');
    });
});

describe('the paths managed content reads and writes', () => {
    const OUTSIDE_HASH = 'c'.repeat(64);

    test('resolves a name inside its folder, and refuses one that leaves it or is the folder itself', () => {
        const base = path.join(makeDirectory(), 'characters');

        expect(resolveInside(base, 'card.png')).toBe(path.join(base, 'card.png'));
        expect(resolveInside(base, 'Folder', 'sprite.webp')).toBe(path.join(base, 'Folder', 'sprite.webp'));
        for (const parts of [['..', 'card.png'], ['..'], ['.'], [''], ['Folder', '..', '..', 'card.png'], ['Folder/../../card.png']]) {
            expect(() => resolveInside(base, ...parts)).toThrow(expect.objectContaining({ code: 'unsafe_target' }));
        }
    });

    test('writes a file inside its folder and sets its permissions', () => {
        const base = path.join(makeDirectory(), 'characters');
        const setPermissions = jest.fn();

        writeInside(base, path.join(base, 'Folder', 'card.png'), Buffer.from('card'), setPermissions);

        expect(fs.readFileSync(path.join(base, 'Folder', 'card.png'), 'utf8')).toBe('card');
        expect(setPermissions).toHaveBeenCalledWith(path.join(base, 'Folder', 'card.png'));
    });

    test.each([
        ['a sibling of the folder', base => path.join(base, '..', 'outside.png')],
        ['a folder that only starts with its name', base => `${base}-other/card.png`],
        ['the folder itself', base => base],
    ])('refuses to write %s, and writes nothing', (_name, targetOf) => {
        const base = path.join(makeDirectory(), 'characters');
        fs.mkdirSync(base);
        const root = path.dirname(base);

        expect(() => writeInside(base, targetOf(base), Buffer.from('x'), () => {})).toThrow(expect.objectContaining({ code: 'unsafe_target' }));

        expect(fs.readdirSync(root)).toEqual(['characters']);
        expect(fs.readdirSync(base)).toEqual([]);
    });

    describe('through the service, for an item that got past the manifest check', () => {
        const escapedCard = { filename: '../outside.png', type: 'character', version: 2, fingerprint: HASH, previousFingerprints: [OUTSIDE_HASH] };
        const escapedSprites = { filename: SPRITES, type: 'sprites', version: 2, files: [{ name: '../../outside.webp', sha256: HASH, previous: [OUTSIDE_HASH] }] };
        const escapedWorld = { filename: '../outside.json', type: 'world', version: 2, fingerprint: HASH, previousFingerprints: [OUTSIDE_HASH] };

        function arrange(item) {
            const context = setup({ installed: bundleFiles(1), readItems: () => [item] });
            const outsideNames = ['outside.png', 'outside.json', 'outside.webp'];
            outsideNames.forEach(name => fs.writeFileSync(path.join(context.user.root, name), 'outside'));
            context.untouched = () => outsideNames.every(name => fs.readFileSync(path.join(context.user.root, name), 'utf8') === 'outside');
            return context;
        }

        test.each([
            ['a card', escapedCard],
            ['a world', escapedWorld],
            ['sprites', escapedSprites],
        ])('reports %s as modified without reading it, and offers no update', (_name, item) => {
            const { managed } = arrange(item);

            expect(managed.status()[0]).toMatchObject({ status: 'modified', updateAvailable: false });
        });

        test.each([
            ['a card', escapedCard],
            ['a world', escapedWorld],
            ['sprites', escapedSprites],
        ])('refuses to apply or restore %s, and writes and backs up nothing', (_name, item) => {
            const { managed, user, untouched } = arrange(item);
            const name = item.filename;

            expect(() => managed.apply(name)).toThrow(expect.objectContaining({ code: expect.stringMatching(/unsafe_target|not_applicable/) }));
            expect(() => managed.restore(name)).toThrow(expect.objectContaining({ code: 'unsafe_target' }));

            expect(untouched()).toBe(true);
            expect(backupFiles(user)).toEqual([]);
        });

        test('skips it when reconciling, and goes on', () => {
            jest.spyOn(console, 'warn').mockImplementation(() => {});
            const { managed, untouched } = arrange(escapedCard);

            expect(managed.reconcile()).toEqual([]);
            expect(untouched()).toBe(true);
        });

        test('makes a signature without failing', () => {
            const { managed } = arrange(escapedCard);

            expect(() => managed.stateSignature()).not.toThrow();
        });
    });
});
