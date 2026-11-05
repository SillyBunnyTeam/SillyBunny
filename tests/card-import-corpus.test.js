import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import multer from 'multer';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

import '../src/fetch-patch.js';
import { parse, read, write } from '../src/character-card-parser.js';
import { AVATAR_HEIGHT, AVATAR_WIDTH } from '../src/constants.js';
import { createUploadStorage } from '../src/middleware/uploadStorage.js';
import multerMonkeyPatch from '../src/middleware/multerMonkeyPatch.js';
import encode from '../src/png/encode.js';
import { humanizedDateTime, setConfigFilePath } from '../src/util.js';
import {
    BYAF_ICON_SIZES,
    CHARX_ICON_SIZES,
    createByafArchive,
    createByafParts,
    createCardPng,
    createCardTextChunk,
    createCharxArchive,
    createCharxCard,
    createChatCorpus,
    createGradioCard,
    createImageChunks,
    createImagePng,
    createV1Card,
    createV2Card,
    createV3Card,
    createYamlCard,
    encodePng,
    toJsonl,
} from './util/card-corpus.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
const diskCacheEnvironmentKey = 'SILLYTAVERN_PERFORMANCE_USEDISKCACHE';
const originalDiskCacheSetting = process.env[diskCacheEnvironmentKey];
process.env[diskCacheEnvironmentKey] = 'false';
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { router: charactersRouter } = await import('../src/endpoints/characters.js');
const { router: chatsRouter } = await import('../src/endpoints/chats.js');

const FIXED_TIME = Date.UTC(2026, 5, 7, 8, 9, 10);
const DATE_ONLY_FAKE_TIMERS = {
    doNotFake: [
        'cancelAnimationFrame', 'cancelIdleCallback', 'clearImmediate', 'clearInterval', 'clearTimeout', 'hrtime', 'nextTick',
        'performance', 'queueMicrotask', 'requestAnimationFrame', 'requestIdleCallback', 'setImmediate', 'setInterval', 'setTimeout',
    ],
    now: FIXED_TIME,
};

const CANONICAL_FIELDS = [
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt',
    'post_history_instructions', 'alternate_greetings', 'character_book', 'tags', 'creator', 'character_version',
];
const V3_ONLY_FIELDS = ['nickname', 'creator_notes_multilang', 'source', 'group_only_greetings', 'creation_date', 'modification_date', 'assets'];
const CARD_IMAGE_SIZE = { width: 2, height: 3 };
const DEFAULT_AVATAR_SIZE = { width: AVATAR_WIDTH, height: AVATAR_HEIGHT };

const pick = (source, fields) => Object.fromEntries(fields.map(field => [field, source[field]]));
const canonicalFields = card => pick(card.data, CANONICAL_FIELDS);
const v3OnlyFields = card => pick(card.data, V3_ONLY_FIELDS);
const utf8 = text => Buffer.from(text, 'utf8');

function expectedFromV1(card) {
    return {
        name: card.name,
        description: card.description,
        personality: card.personality,
        scenario: card.scenario,
        first_mes: card.first_mes,
        mes_example: card.mes_example,
        creator_notes: card.creatorcomment,
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        character_book: undefined,
        tags: card.tags,
        creator: card.creator,
        character_version: '',
    };
}

const V2_EXTENSIONS = { talkativeness: 0.4, synthetic_marker: { kept: true }, depth_prompt: { prompt: 'Mention the tide.', depth: 2, role: 'system' } };
const V3_EXTENSIONS = { talkativeness: 0.6, synthetic_marker: { kept: true } };

const CARD_FORMATS = [
    {
        id: 'V1 PNG',
        fileType: 'png',
        build: async () => createCardPng(createV1Card()),
        expected: expectedFromV1(createV1Card()),
        extensions: { talkativeness: 0.7 },
        imageSize: CARD_IMAGE_SIZE,
    },
    {
        id: 'V1 JSON',
        fileType: 'json',
        build: async () => utf8(JSON.stringify(createV1Card())),
        expected: expectedFromV1(createV1Card()),
        extensions: { talkativeness: 0.7 },
        imageSize: DEFAULT_AVATAR_SIZE,
    },
    {
        id: 'V2 PNG',
        fileType: 'png',
        build: async () => createCardPng(createV2Card()),
        expected: canonicalFields(createV2Card()),
        extensions: V2_EXTENSIONS,
        imageSize: CARD_IMAGE_SIZE,
    },
    {
        id: 'V2 JSON',
        fileType: 'json',
        build: async () => utf8(JSON.stringify(createV2Card())),
        expected: canonicalFields(createV2Card()),
        extensions: V2_EXTENSIONS,
        imageSize: DEFAULT_AVATAR_SIZE,
    },
    {
        id: 'V3 PNG with a ccv3 chunk only',
        fileType: 'png',
        build: async () => createCardPng(createV3Card(), ['ccv3']),
        expected: canonicalFields(createV3Card()),
        v3Fields: v3OnlyFields(createV3Card()),
        extensions: V3_EXTENSIONS,
        imageSize: CARD_IMAGE_SIZE,
    },
    {
        id: 'V3 PNG with chara and ccv3 chunks',
        fileType: 'png',
        build: async () => createCardPng(createV3Card(), ['chara', 'ccv3']),
        expected: canonicalFields(createV3Card()),
        v3Fields: v3OnlyFields(createV3Card()),
        extensions: V3_EXTENSIONS,
        imageSize: CARD_IMAGE_SIZE,
    },
    {
        id: 'V3 JSON',
        fileType: 'json',
        build: async () => utf8(JSON.stringify(createV3Card())),
        expected: canonicalFields(createV3Card()),
        v3Fields: v3OnlyFields(createV3Card()),
        extensions: V3_EXTENSIONS,
        imageSize: DEFAULT_AVATAR_SIZE,
    },
    {
        id: 'CHARX',
        fileType: 'charx',
        build: () => createCharxArchive(),
        expected: canonicalFields(createCharxCard()),
        v3Fields: v3OnlyFields(createCharxCard()),
        extensions: V3_EXTENSIONS,
        imageSize: CHARX_ICON_SIZES.main,
    },
    {
        id: 'BYAF',
        fileType: 'byaf',
        build: () => createByafArchive(),
        expected: {
            name: 'soren',
            description: '{{char}}: I keep bees. {{user}} visits on Sundays.',
            personality: '',
            scenario: '{{user}} arrives at the hives.',
            first_mes: 'Mind the bees, {{user}}.',
            mes_example: '<START>\n{{user}}: Hello.\n{{char}}: Hush.',
            creator_notes: 'https://example.invalid/authors/test',
            system_prompt: 'Write as {{char}}.',
            post_history_instructions: '',
            alternate_greetings: ['The hives hum under the snow.'],
            character_book: {
                entries: [
                    { keys: ['hive', 'apiary'], content: '{{char}} has twelve hives.', extensions: {}, enabled: true, insertion_order: 0 },
                    { keys: ['蜂'], content: '蜂は日曜に静かになる。', extensions: {}, enabled: true, insertion_order: 1 },
                ],
                extensions: {},
            },
            tags: [],
            creator: 'Test Author',
            character_version: '',
        },
        extensions: { display_name: 'Søren 桜' },
        imageSize: BYAF_ICON_SIZES.main,
        fileName: 'Søren 桜',
    },
    {
        id: 'YAML',
        fileType: 'yaml',
        build: async () => utf8(createYamlCard()),
        expected: {
            name: 'Tomasz Ż',
            description: 'A bell founder with burnt sleeves.',
            personality: '',
            scenario: '',
            first_mes: 'Stand clear of the mould.',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            character_book: undefined,
            tags: [],
            creator: '',
            character_version: '',
        },
        extensions: { talkativeness: 0.5 },
        imageSize: DEFAULT_AVATAR_SIZE,
    },
    {
        id: 'Gradio JSON',
        fileType: 'json',
        build: async () => utf8(JSON.stringify(createGradioCard())),
        expected: {
            name: 'Ilse Vane',
            description: 'A retired ferry pilot.',
            personality: '',
            scenario: '{{user}} misses the last ferry.',
            first_mes: 'Mind the rope.',
            mes_example: '<START>\n{{char}}: The river keeps its own time.',
            creator_notes: 'Synthetic Gradio card.',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            character_book: undefined,
            tags: ['river', 'synthetic'],
            creator: 'Test Author',
            character_version: '',
        },
        extensions: { talkativeness: 0.5 },
        imageSize: DEFAULT_AVATAR_SIZE,
    },
];

function decodeTextChunks(image) {
    return extract(new Uint8Array(image))
        .filter(chunk => chunk.name === 'tEXt')
        .map(chunk => PNGtext.decode(chunk.data));
}

function readCardChunks(image) {
    return decodeTextChunks(image)
        .filter(({ keyword }) => ['chara', 'ccv3'].includes(keyword.toLowerCase()))
        .map(({ keyword, text }) => ({ keyword, card: JSON.parse(Buffer.from(text, 'base64').toString('utf8')) }));
}

function readImageSize(image) {
    const header = Buffer.from(extract(new Uint8Array(image))[0].data);
    return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

describe('card import corpus', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;
    let uploadMiddleware;

    function resetState() {
        jest.setSystemTime(FIXED_TIME);
        tempRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-card-corpus-'));
        directories = {
            root: tempRoot,
            backups: path.join(tempRoot, 'backups'),
            characters: path.join(tempRoot, 'characters'),
            chats: path.join(tempRoot, 'chats'),
            groupChats: path.join(tempRoot, 'group chats'),
            groups: path.join(tempRoot, 'groups'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
            userImages: path.join(tempRoot, 'user', 'images'),
            worlds: path.join(tempRoot, 'worlds'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        uploadMiddleware = multer({ storage: createUploadStorage(path.join(tempRoot, '_uploads')) }).single('avatar');
    }

    function removeState() {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
    }

    beforeAll(async () => {
        jest.useFakeTimers(DATE_ONLY_FAKE_TIMERS);
        for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'card-corpus-test-user' }, directories };
            next();
        });
        app.use((request, response, next) => uploadMiddleware(request, response, next));
        app.use(multerMonkeyPatch);
        app.use('/api/characters', charactersRouter);
        app.use('/api/chats', chatsRouter);
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        jest.useRealTimers();
        jest.restoreAllMocks();
        if (originalDiskCacheSetting === undefined) {
            delete process.env[diskCacheEnvironmentKey];
        } else {
            process.env[diskCacheEnvironmentKey] = originalDiskCacheSetting;
        }
        process.chdir(originalWorkingDirectory);
    });

    function postJson(resource, body) {
        return fetch(`${baseUrl}${resource}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    function upload(resource, bytes, fileName, fields = {}) {
        const form = new FormData();
        form.append('avatar', new Blob([bytes]), fileName);
        for (const [key, value] of Object.entries(fields)) {
            form.append(key, value);
        }
        return fetch(`${baseUrl}${resource}`, { method: 'POST', body: form });
    }

    function importCard(bytes, fileType, fields = {}) {
        return upload('/api/characters/import', bytes, `upload.${fileType}`, { file_type: fileType, user_name: 'Tester', ...fields });
    }

    async function importedFileName(bytes, fileType, fields) {
        const response = await importCard(bytes, fileType, fields);
        expect(response.status).toBe(200);
        return (await response.json()).file_name;
    }

    async function exportCard(format, fileName) {
        const response = await postJson('/api/characters/export', { format, avatar_url: `${fileName}.png` });
        expect(response.status).toBe(200);
        return response;
    }

    const storedCardPath = fileName => path.join(directories.characters, `${fileName}.png`);
    const readStoredCard = fileName => readCardChunks(fs.readFileSync(storedCardPath(fileName)));

    describe('character card parser', () => {
        beforeEach(resetState);
        afterEach(removeState);

        const { header, pixels, end } = createImageChunks();
        const namedCard = name => ({ spec: 'chara_card_v2', spec_version: '2.0', name, data: { name } });

        test('encode writes chunks that the chunk reader accepts', () => {
            const chunks = [header, PNGtext.encode('Comment', 'text'), pixels, end];
            const decoded = extract(encode(chunks));
            expect(decoded.map(chunk => chunk.name)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
            decoded.forEach((chunk, index) => expect(Buffer.from(chunk.data).equals(Buffer.from(chunks[index].data))).toBe(true));
        });

        test('read returns the ccv3 chunk when both card chunks exist', () => {
            const image = encodePng([header, createCardTextChunk('chara', namedCard('from chara')), createCardTextChunk('ccv3', namedCard('from ccv3')), pixels, end]);
            expect(JSON.parse(read(image)).name).toBe('from ccv3');
        });

        test('read returns the chara chunk when no ccv3 chunk exists', () => {
            const image = encodePng([header, PNGtext.encode('Comment', 'text'), createCardTextChunk('chara', namedCard('from chara')), pixels, end]);
            expect(JSON.parse(read(image)).name).toBe('from chara');
        });

        test.each([['CHARA'], ['Chara'], ['CCV3'], ['CcV3']])('read matches the keyword %s without regard to case', keyword => {
            const image = encodePng([header, createCardTextChunk(keyword, namedCard('found')), pixels, end]);
            expect(JSON.parse(read(image)).name).toBe('found');
        });

        test('read decodes the chunk text as Base64 over UTF-8', () => {
            const image = createCardPng(createV3Card(), ['ccv3']);
            expect(JSON.parse(read(image)).data.name).toBe('Ренард 🦊');
        });

        test.each([
            ['no text chunk', [header, pixels, end]],
            ['only other text chunks', [header, PNGtext.encode('Comment', 'text'), pixels, end]],
        ])('read rejects a PNG with %s', (_label, chunks) => {
            expect(() => read(encodePng(chunks))).toThrow('No PNG metadata.');
        });

        test('write replaces every card chunk and keeps the other chunks in order', () => {
            const image = encodePng([
                header,
                PNGtext.encode('Comment', 'keep this'),
                createCardTextChunk('chara', namedCard('old')),
                createCardTextChunk('ccv3', namedCard('old')),
                createCardTextChunk('CHARA', namedCard('older')),
                pixels,
                end,
            ]);

            const written = write(image, JSON.stringify(namedCard('new')));

            const chunks = extract(new Uint8Array(written));
            expect(chunks.map(chunk => chunk.name)).toEqual(['IHDR', 'tEXt', 'IDAT', 'tEXt', 'tEXt', 'IEND']);
            expect(Buffer.from(chunks[2].data).equals(Buffer.from(pixels.data))).toBe(true);
            expect(decodeTextChunks(written).map(({ keyword }) => keyword)).toEqual(['Comment', 'chara', 'ccv3']);
            expect(decodeTextChunks(written)[0].text).toBe('keep this');
            expect(readCardChunks(written).map(({ card }) => card.name)).toEqual(['new', 'new']);
        });

        test('write gives each chunk its own spec and copies the data block to the root fields', () => {
            const card = {
                spec: 'chara_card_v2',
                name: 'stale',
                description: 'stale',
                creatorcomment: 'stale',
                data: { name: 'fresh', description: 'fresh text', creator_notes: 'fresh notes', tags: ['tag'], extensions: { talkativeness: 0.3, fav: true } },
            };

            const [chara, ccv3] = readCardChunks(write(encodePng([header, pixels, end]), JSON.stringify(card)));

            expect(chara.card).toMatchObject({ spec: 'chara_card_v2', spec_version: '2.0' });
            expect(ccv3.card).toMatchObject({ spec: 'chara_card_v3', spec_version: '3.0' });
            for (const { card: written } of [chara, ccv3]) {
                expect(written).toMatchObject({ name: 'fresh', description: 'fresh text', creatorcomment: 'fresh notes', tags: ['tag'], talkativeness: 0.3, fav: true });
            }
        });

        test('write copies root fields to a data block that lacks them', () => {
            const card = { name: 'Root only', description: 'root text', creatorcomment: 'root notes', talkativeness: 0.2 };

            const [{ card: written }] = readCardChunks(write(encodePng([header, pixels, end]), JSON.stringify(card)));

            expect(written.data).toMatchObject({ name: 'Root only', description: 'root text', creator_notes: 'root notes', extensions: { talkativeness: 0.2 } });
        });

        test('write stores metadata that is not JSON in a chara chunk only', () => {
            const written = write(encodePng([header, pixels, end]), 'plain text');

            const textChunks = decodeTextChunks(written);
            expect(textChunks.map(({ keyword }) => keyword)).toEqual(['chara']);
            expect(Buffer.from(textChunks[0].text, 'base64').toString('utf8')).toBe('plain text');
            expect(read(written)).toBe('plain text');
        });

        test('parse reads a card from a file path', async () => {
            const cardPath = path.join(tempRoot, 'card.png');
            fs.writeFileSync(cardPath, createCardPng(namedCard('from file')));

            expect(JSON.parse(await parse(cardPath)).name).toBe('from file');
            expect(JSON.parse(await parse(cardPath, 'png')).name).toBe('from file');
        });

        test('parse rejects a format other than PNG', async () => {
            const cardPath = path.join(tempRoot, 'card.png');
            fs.writeFileSync(cardPath, createCardPng(namedCard('from file')));

            await expect(parse(cardPath, 'webp')).rejects.toThrow('Unsupported format');
        });
    });

    test('the generator returns the same bytes on every call', async () => {
        for (const format of CARD_FORMATS) {
            const [first, second] = [await format.build(), await format.build()];
            expect(first.equals(second)).toBe(true);
        }
    });

    describe.each(CARD_FORMATS)('$id', format => {
        const expectedFileName = format.fileName ?? format.expected.name;
        const reimportedFileName = format.fileName ? format.expected.name : `${expectedFileName}1`;
        let importResponse;

        beforeAll(async () => {
            resetState();
            const response = await importCard(await format.build(), format.fileType);
            importResponse = { status: response.status, body: await response.json() };
        });

        afterEach(() => {
            for (const entry of fs.readdirSync(directories.characters)) {
                if (entry.endsWith('.png') && entry !== `${expectedFileName}.png`) {
                    fs.rmSync(path.join(directories.characters, entry));
                }
            }
        });

        afterAll(removeState);

        const expectCanonicalCard = card => {
            expect(canonicalFields(card)).toEqual(format.expected);
            expect(card.data.extensions).toMatchObject(format.extensions);
            expect(card.name).toBe(format.expected.name);
            expect(card.description).toBe(format.expected.description);
        };

        test('import stores the canonical fields in both metadata chunks', async () => {
            expect(importResponse.status).toBe(200);
            expect(importResponse.body).toEqual({ file_name: expectedFileName });
            expect(fs.readdirSync(path.join(tempRoot, '_uploads'))).toEqual([]);
            expect(fs.readdirSync(directories.characters)).toContain(`${expectedFileName}.png`);
            const chunks = readStoredCard(expectedFileName);
            expect(chunks.map(chunk => chunk.keyword)).toEqual(['chara', 'ccv3']);
            expect(chunks[0].card).toMatchObject({ spec: 'chara_card_v2', spec_version: '2.0' });
            expect(chunks[1].card).toMatchObject({ spec: 'chara_card_v3', spec_version: '3.0' });
            for (const { card } of chunks) {
                expectCanonicalCard(card);
                expect(card.create_date).toBe(new Date(FIXED_TIME).toISOString());
            }
            expect(readImageSize(fs.readFileSync(storedCardPath(expectedFileName)))).toEqual(format.imageSize);
        });

        test('the get route returns the canonical fields of the imported card', async () => {
            const response = await postJson('/api/characters/get', { avatar_url: `${expectedFileName}.png` });

            expect(response.status).toBe(200);
            const character = await response.json();
            expectCanonicalCard(character);
            expect(character.avatar).toBe(`${expectedFileName}.png`);
        });

        test('a PNG export keeps the metadata chunks and imports to the same fields', async () => {
            const exportResponse = await exportCard('png', expectedFileName);

            expect(exportResponse.headers.get('content-type')).toContain('image/png');
            const exported = Buffer.from(await exportResponse.arrayBuffer());
            expect(readImageSize(exported)).toEqual(format.imageSize);
            const exportedChunks = readCardChunks(exported);
            expect(exportedChunks.map(chunk => chunk.keyword)).toEqual(['chara', 'ccv3']);
            for (const { card } of exportedChunks) {
                expectCanonicalCard(card);
                expect(card.chat).toBeUndefined();
                expect(card.fav).toBe(false);
                expect(card.data.extensions.fav).toBe(false);
            }

            expect(await importedFileName(exported, 'png')).toBe(reimportedFileName);

            const secondImport = fs.readFileSync(storedCardPath(reimportedFileName));
            expect(readImageSize(secondImport)).toEqual(format.imageSize);
            for (const { card } of readCardChunks(secondImport)) {
                expectCanonicalCard(card);
            }
        });

        test('a JSON export imports to the same fields', async () => {
            const exported = await (await exportCard('json', expectedFileName)).json();

            expect(exported.spec).toBe('chara_card_v3');
            expectCanonicalCard(exported);
            expect(exported.chat).toBeUndefined();
            expect(exported.fav).toBe(false);
            expect(exported.data.extensions.fav).toBe(false);

            expect(await importedFileName(utf8(JSON.stringify(exported)), 'json')).toBe(reimportedFileName);

            for (const { card } of readStoredCard(reimportedFileName)) {
                expectCanonicalCard(card);
            }
        });

        if (format.v3Fields) {
            test('V3 fields survive import, both exports and a second import', async () => {
                const expectV3Fields = card => expect(v3OnlyFields(card)).toEqual(format.v3Fields);
                readStoredCard(expectedFileName).forEach(({ card }) => expectV3Fields(card));

                const pngExport = Buffer.from(await (await exportCard('png', expectedFileName)).arrayBuffer());
                readCardChunks(pngExport).forEach(({ card }) => expectV3Fields(card));

                const jsonExport = await (await exportCard('json', expectedFileName)).json();
                expectV3Fields(jsonExport);

                const fromPng = await importedFileName(pngExport, 'png');
                const fromJson = await importedFileName(utf8(JSON.stringify(jsonExport)), 'json');
                for (const secondImport of [fromPng, fromJson]) {
                    readStoredCard(secondImport).forEach(({ card }) => expectV3Fields(card));
                }
            });
        }
    });

    describe('card details', () => {
        beforeEach(resetState);
        afterEach(removeState);

        test.each([
            ['PNG', 'png', () => createCardPng(createV2Card())],
            ['JSON', 'json', () => utf8(JSON.stringify(createV2Card()))],
        ])('a %s import drops the chat name and favourite flag of the source card', async (_label, fileType, build) => {
            const fileName = await importedFileName(build(), fileType);

            for (const { card } of readStoredCard(fileName)) {
                expect(card.fav).toBe(false);
                expect(card.data.extensions.fav).toBe(false);
                expect(card.chat).toBe(`${fileName} - ${humanizedDateTime(FIXED_TIME)}`);
            }
        });

        test('a ccv3 chunk wins over a different chara chunk on import', async () => {
            const { header, pixels, end } = createImageChunks();
            const image = encodePng([header, createCardTextChunk('chara', createV2Card()), createCardTextChunk('ccv3', createV3Card()), pixels, end]);

            const fileName = await importedFileName(image, 'png');

            expect(fileName).toBe(createV3Card().data.name);
            for (const { card } of readStoredCard(fileName)) {
                expect(canonicalFields(card)).toEqual(canonicalFields(createV3Card()));
            }
        });

        test('the data block wins over different root fields on import', async () => {
            const card = createV2Card();
            Object.assign(card, { name: 'Stale root name', description: 'Stale root text', first_mes: 'Stale root greeting' });

            const fileName = await importedFileName(createCardPng(card), 'png');

            expect(fileName).toBe(card.data.name);
            for (const { card: stored } of readStoredCard(fileName)) {
                expect(stored).toMatchObject({ name: card.data.name, description: card.data.description, first_mes: card.data.first_mes });
            }
        });

        test.each([
            ['PNG', 'png', card => createCardPng(card)],
            ['JSON', 'json', card => utf8(JSON.stringify(card))],
        ])('a V1 %s import splits comma-separated tags and clears the placeholder creator notes', async (_label, fileType, build) => {
            const card = { ...createV1Card(), tags: 'lighthouse, synthetic ,', creator_notes: 'Creator\'s notes go here.' };
            delete card.creatorcomment;

            const fileName = await importedFileName(build(card), fileType);

            for (const { card: stored } of readStoredCard(fileName)) {
                expect(stored.data.tags).toEqual(['lighthouse', 'synthetic']);
                expect(stored.data.creator_notes).toBe('');
            }
        });

        test('a preserved name replaces the existing card and keeps its file name', async () => {
            const fileName = await importedFileName(createCardPng(createV2Card()), 'png');

            const replaced = await importedFileName(createCardPng(createV3Card()), 'png', { preserved_name: `${fileName}.png` });

            expect(replaced).toBe(fileName);
            expect(fs.readdirSync(directories.characters)).toEqual([`${fileName}.png`]);
            for (const { card } of readStoredCard(fileName)) {
                expect(canonicalFields(card)).toEqual(canonicalFields(createV3Card()));
            }
        });

        test('a CHARX import uses the main icon and stores each asset type in its folder', async () => {
            const card = createCharxCard();
            const name = card.data.name;

            const fileName = await importedFileName(await createCharxArchive(card), 'charx');

            expect(fileName).toBe(name);
            expect(readImageSize(fs.readFileSync(storedCardPath(fileName)))).toEqual(CHARX_ICON_SIZES.main);
            const spriteFolder = path.join(directories.characters, name);
            expect(fs.readdirSync(spriteFolder).sort()).toEqual(['backgrounds', 'joy.png']);
            expect(fs.readFileSync(path.join(spriteFolder, 'joy.png')).equals(createImagePng({ rgba: [10, 200, 10, 255] }))).toBe(true);
            expect(fs.readdirSync(path.join(spriteFolder, 'backgrounds'))).toEqual(['beach_day.png']);
            expect(fs.readFileSync(path.join(spriteFolder, 'backgrounds', 'beach_day.png')).equals(createImagePng({ rgba: [10, 10, 200, 255] }))).toBe(true);
            expect(fs.readdirSync(path.join(directories.userImages, name))).toEqual(['poster.png']);
            expect(fs.readFileSync(path.join(directories.userImages, name, 'poster.png')).equals(createImagePng({ rgba: [90, 90, 90, 255] }))).toBe(true);
        });

        test('a CHARX card without an icon asset uses the default avatar', async () => {
            const card = createCharxCard();
            card.data.assets = card.data.assets.filter(asset => asset.type !== 'icon');

            const fileName = await importedFileName(await createCharxArchive(card), 'charx');

            expect(readImageSize(fs.readFileSync(storedCardPath(fileName)))).toEqual(DEFAULT_AVATAR_SIZE);
        });

        test('a BYAF import creates one chat per scenario and stores its background and alternate icon', async () => {
            const fileName = await importedFileName(await createByafArchive(), 'byaf');
            const stamp = humanizedDateTime(FIXED_TIME);

            const chatFolder = path.join(directories.chats, fileName);
            expect(fs.readdirSync(chatFolder).sort()).toEqual([`Sunday - ${stamp} imported.jsonl`, `Winter - ${stamp} imported.jsonl`]);
            const [header, greeting, question, answer] = fs.readFileSync(path.join(chatFolder, `Sunday - ${stamp} imported.jsonl`), 'utf8').split('\n').map(line => JSON.parse(line));
            expect(header.chat_metadata).toMatchObject({
                system_prompt: 'Write as {{char}}.',
                mes_example: '<START>\n{{user}}: Hello.\n{{char}}: Hush.',
            });
            expect(header.chat_metadata.scenario).toContain('arrives at the hives');
            expect(header.chat_metadata.byaf_model_settings).toMatchObject({ model: 'synthetic-model', temperature: 0.8 });
            expect(greeting).toMatchObject({ name: 'soren', is_user: false });
            expect(greeting.mes).toContain('Mind the bees');
            expect(question).toMatchObject({ name: 'Tester', is_user: true, mes: 'Are they asleep?' });
            expect(answer).toMatchObject({ name: 'soren', is_user: false, mes: 'Almost.', swipes: ['Not yet.', 'Almost.'], swipe_id: 1 });
            for (const { card } of readStoredCard(fileName)) {
                expect(card.chat).toBe(`Sunday - ${stamp} imported`);
            }

            const backgroundFolder = path.join(directories.userImages, fileName);
            const backgroundFiles = fs.readdirSync(backgroundFolder);
            expect(backgroundFiles).toHaveLength(1);
            expect(backgroundFiles[0].startsWith(`${fileName}_bg`)).toBe(true);
            expect(fs.readFileSync(path.join(backgroundFolder, backgroundFiles[0])).equals(createImagePng({ rgba: [30, 120, 30, 255] }))).toBe(true);
            expect(header.chat_metadata.chat_backgrounds).toEqual([expect.stringContaining(backgroundFiles[0])]);
            expect(header.chat_metadata.custom_background).toContain(encodeURI(backgroundFiles[0]));

            const iconFolder = path.join(directories.characters, 'soren');
            const iconFiles = fs.readdirSync(iconFolder);
            expect(iconFiles).toHaveLength(1);
            expect(iconFiles[0].startsWith('smile')).toBe(true);
            expect(fs.readFileSync(path.join(iconFolder, iconFiles[0])).equals(createImagePng(BYAF_ICON_SIZES.alt))).toBe(true);
        });

        test('a BYAF import with a preserved name changes only the card', async () => {
            const { manifest, character, scenarios } = createByafParts();
            character.name = 'Replacement';

            const fileName = await importedFileName(await createByafArchive({ manifest, character, scenarios }), 'byaf', { preserved_name: 'Existing.png' });

            expect(fileName).toBe('Existing');
            expect(fs.readdirSync(directories.characters)).toEqual(['Existing.png']);
            expect(fs.readdirSync(directories.chats)).toEqual([]);
            expect(fs.readdirSync(directories.userImages)).toEqual([]);
            for (const { card } of readStoredCard('Existing')) {
                expect(card.data.name).toBe('Replacement');
            }
        });
    });

    describe.each(createChatCorpus())('$id chat', chat => {
        const chatFields = { avatar_url: 'Keeper.png', character_name: 'Keeper', user_name: 'Tester' };
        let chatFolder;

        beforeEach(() => {
            resetState();
            chatFolder = path.join(directories.chats, 'Keeper');
            fs.mkdirSync(chatFolder);
        });

        afterEach(removeState);

        const importChat = (content, fileType) => upload('/api/chats/import', utf8(content), `chat.${fileType}`, { ...chatFields, file_type: fileType });
        const readChatRecords = fileName => fs.readFileSync(path.join(chatFolder, fileName), 'utf8').split('\n').map(line => JSON.parse(line));

        test('import writes the messages and the chat route loads them', async () => {
            const response = await importChat(chat.content, chat.fileType);

            expect(response.status).toBe(200);
            const fileName = `Keeper - ${humanizedDateTime(FIXED_TIME)} imported.jsonl`;
            expect(await response.json()).toEqual({ res: true, fileNames: [fileName] });
            expect(fs.readdirSync(chatFolder)).toEqual([fileName]);
            const [header, ...messages] = readChatRecords(fileName);
            expect(header).toEqual(chat.expectedHeader);
            const importTime = new Date(FIXED_TIME).toISOString();
            expect(messages).toMatchObject(chat.expectedMessages.map(message => ({ send_date: importTime, ...message })));

            const loaded = await postJson('/api/chats/get', { avatar_url: 'Keeper.png', file_name: path.parse(fileName).name });
            expect(loaded.status).toBe(200);
            expect(await loaded.json()).toEqual([{ chat_metadata: {}, ...header }, ...messages]);
        });

        test('a JSONL export imports to the same records', async () => {
            const { fileNames: [fileName] } = await (await importChat(chat.content, chat.fileType)).json();

            const exportResponse = await postJson('/api/chats/export', { ...chatFields, is_group: false, file: fileName, exportfilename: 'out.jsonl', format: 'jsonl' });

            expect(exportResponse.status).toBe(200);
            const { result } = await exportResponse.json();
            expect(result).toBe(fs.readFileSync(path.join(chatFolder, fileName), 'utf8'));

            jest.setSystemTime(FIXED_TIME + 1000);
            const secondResponse = await importChat(result, 'jsonl');

            expect(secondResponse.status).toBe(200);
            const secondFileName = `Keeper - ${humanizedDateTime(FIXED_TIME + 1000)} imported.jsonl`;
            expect(await secondResponse.json()).toEqual({ res: true, fileNames: [secondFileName] });
            expect(readChatRecords(secondFileName)).toEqual(readChatRecords(fileName));
        });
    });

    describe('chat file handling', () => {
        const chatFields = { avatar_url: 'Keeper.png', character_name: 'Keeper', user_name: 'Tester' };
        const nativeChat = createChatCorpus().find(chat => chat.id === 'native JSONL');

        beforeEach(() => {
            resetState();
            fs.mkdirSync(path.join(directories.chats, 'Keeper'));
        });

        afterEach(removeState);

        test('a text export lists the visible messages and uses their display text', async () => {
            const imported = await upload('/api/chats/import', utf8(nativeChat.content), 'chat.jsonl', { ...chatFields, file_type: 'jsonl' });
            const { fileNames: [fileName] } = await imported.json();

            const response = await postJson('/api/chats/export', { ...chatFields, is_group: false, file: fileName, exportfilename: 'out.txt', format: 'txt' });

            expect(response.status).toBe(200);
            expect((await response.json()).result).toBe('Keeper: Hello again.\n\nTester: こんにちは。\n\nKeeper: Shown text.\n\n');
        });

        test.each([
            ['JSON of an unknown shape', 'json', '{"unknown":true}'],
            ['JSON that does not parse', 'json', '{"unterminated":'],
            ['JSONL with an unknown header', 'jsonl', toJsonl([{ unknown: true }, { name: 'Keeper', mes: 'Hello.' }])],
            ['JSONL with a header that does not parse', 'jsonl', '{"unterminated":\n{"name":"Keeper","mes":"Hello."}'],
        ])('import rejects %s and writes no chat', async (_label, fileType, content) => {
            const response = await upload('/api/chats/import', utf8(content), `chat.${fileType}`, { ...chatFields, file_type: fileType });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ error: true });
            expect(fs.readdirSync(path.join(directories.chats, 'Keeper'))).toEqual([]);
        });

        test('a group chat file imports, loads and exports to the same records', async () => {
            const response = await upload('/api/chats/group/import', utf8(nativeChat.content), 'group.jsonl');

            expect(response.status).toBe(200);
            const { res: chatId } = await response.json();
            expect(chatId).toBe(humanizedDateTime(FIXED_TIME));
            expect(fs.readdirSync(directories.groupChats)).toEqual([`${chatId}.jsonl`]);
            expect(fs.readdirSync(path.join(tempRoot, '_uploads'))).toEqual([]);

            const loaded = await postJson('/api/chats/group/get', { id: chatId });
            expect(loaded.status).toBe(200);
            const records = await loaded.json();
            expect(records).toEqual(nativeChat.content.split('\n').map(line => JSON.parse(line)));

            const exported = await postJson('/api/chats/export', { is_group: true, file: `${chatId}.jsonl`, exportfilename: 'out.jsonl', format: 'jsonl' });
            expect(exported.status).toBe(200);
            expect((await exported.json()).result).toBe(nativeChat.content);
        });
    });
});
