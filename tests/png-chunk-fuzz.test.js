import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

import {
    createCardPng,
    createCardTextChunk,
    createImageChunks,
    createV2Card,
    createV3Card,
    encodeCardText,
    encodePng,
} from './util/card-corpus.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const REQUEST_DEADLINE_MS = 20_000;
const TIME_BUDGET_MS = 60_000;

const HEADER_ERROR = /^Invalid \.png file header/;
const ENDED_ERROR = /^\.png file ended prematurely/;
const IHDR_ERROR = /^IHDR header missing$/;
const CRC_ERROR = /^CRC values for [\s\S]+ header do not match/;
const NO_METADATA_ERROR = /^No PNG metadata\.$/;
const NUL_ERROR = /^Invalid NULL character/;
const REPLACEMENT = String.fromCodePoint(0xFFFD);

jest.setTimeout(REQUEST_DEADLINE_MS * 2);

function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

function chunkLayout(png) {
    const layout = [];
    for (let start = 8; start < png.length;) {
        const type = png.toString('latin1', start + 4, start + 8);
        const dataStart = start + 8;
        const crcStart = dataStart + png.readUInt32BE(start);
        const label = type === 'tEXt' ? png.toString('latin1', dataStart, png.indexOf(0, dataStart)) : type;
        layout.push({ type, label, start, dataStart, crcStart, end: crcStart + 4 });
        start = crcStart + 4;
    }
    return layout;
}

function flipBit(png, offset, bit) {
    const copy = Buffer.from(png);
    copy[offset] ^= 1 << bit;
    return copy;
}

function withDeclaredLength(png, chunk, length) {
    const copy = Buffer.from(png);
    copy.writeUInt32BE(length, chunk.start);
    return copy;
}

const crcErrorFor = type => new RegExp(`^CRC values for ${type} header do not match`);
const pastTheEndAt = offset => new RegExp(`^PNG chunk at byte ${offset} runs past the end of the file$`);

function mutateCardPng(png, card, seed) {
    const random = mulberry32(seed);
    const randomInt = limit => Math.floor(random() * limit);
    const distinctInts = (count, limit) => {
        const values = new Set();
        while (values.size < count) {
            values.add(randomInt(limit));
        }
        return [...values];
    };
    const layout = chunkLayout(png);
    const endChunk = layout.at(-1);
    const dataChunks = layout.slice(0, -1);
    const declaredLengths = [png.length + 1, 64 * 1024, 1024 * 1024];
    const parser = { text: JSON.stringify(card) };
    const rejected = [];
    const accepted = [{ name: 'a card with no change', bytes: png, parser, fileName: card.data.name }];
    const reject = (name, bytes, error) => rejected.push({ name, bytes, parser: { error } });
    const accept = (name, bytes) => accepted.push({ name, bytes, parser, fileName: card.data.name });

    reject('an empty file', png.subarray(0, 0), HEADER_ERROR);
    reject('a file cut inside the signature', png.subarray(0, 1 + randomInt(7)), HEADER_ERROR);
    for (let index = 0; index < 8; index++) {
        reject(`a flipped bit in signature byte ${index}`, flipBit(png, index, randomInt(8)), HEADER_ERROR);
    }

    for (const chunk of layout) {
        reject(`a file cut before the ${chunk.label} chunk`, png.subarray(0, chunk.start), ENDED_ERROR);
    }

    for (const chunk of dataChunks) {
        const headerError = chunk.type === 'IHDR' ? IHDR_ERROR : CRC_ERROR;
        for (const cut of distinctInts(3, chunk.end - chunk.start - 1)) {
            const offset = chunk.start + 1 + cut;
            reject(`a file cut at byte ${offset - chunk.start} of the ${chunk.label} chunk`, png.subarray(0, offset), offset >= chunk.crcStart ? crcErrorFor(chunk.type) : pastTheEndAt(chunk.start));
        }
        for (const index of distinctInts(2, chunk.crcStart - chunk.dataStart)) {
            reject(`a flipped bit at data byte ${index} of the ${chunk.label} chunk`, flipBit(png, chunk.dataStart + index, randomInt(8)), crcErrorFor(chunk.type));
        }
        for (const index of distinctInts(2, 4)) {
            reject(`a flipped bit at CRC byte ${index} of the ${chunk.label} chunk`, flipBit(png, chunk.crcStart + index, randomInt(8)), crcErrorFor(chunk.type));
        }
        for (const index of distinctInts(2, 4)) {
            reject(`a flipped bit at type byte ${index} of the ${chunk.label} chunk`, flipBit(png, chunk.start + 4 + index, randomInt(8)), headerError);
        }
        for (const bit of distinctInts(2, 20)) {
            const length = (chunk.crcStart - chunk.dataStart) ^ (1 << bit);
            const dataEnd = chunk.dataStart + length;
            // When the changed length ends inside the file, the parser reads the next chunk header from bytes inside this chunk or a later one. With these seeds, those bytes declare a length past the end of the file.
            const error = dataEnd > png.length ? pastTheEndAt(chunk.start) : dataEnd + 4 > png.length ? crcErrorFor(chunk.type) : pastTheEndAt(dataEnd + 4);
            reject(`a declared length of ${length} on the ${chunk.label} chunk`, withDeclaredLength(png, chunk, length), error);
        }
        for (const length of declaredLengths) {
            reject(`a declared length of ${length} on the ${chunk.label} chunk, past the end of the file`, withDeclaredLength(png, chunk, length), pastTheEndAt(chunk.start));
        }
    }

    for (let cut = 1; cut < 8; cut++) {
        reject(`a file cut at byte ${cut} of the IEND chunk`, png.subarray(0, endChunk.start + cut), pastTheEndAt(endChunk.start));
    }
    reject('a flipped bit in the IEND type', flipBit(png, endChunk.start + 4 + randomInt(4), randomInt(8)), CRC_ERROR);

    for (let cut = 8; cut < 12; cut++) {
        accept(`a file cut at byte ${cut} of the IEND chunk`, png.subarray(0, endChunk.start + cut));
    }
    accept('a flipped bit in the IEND CRC', flipBit(png, endChunk.crcStart + randomInt(4), randomInt(8)));
    for (const length of declaredLengths) {
        reject(`a declared length of ${length} on the IEND chunk`, withDeclaredLength(png, endChunk, length), pastTheEndAt(endChunk.start));
    }
    accept('seeded bytes after the IEND chunk', Buffer.concat([png, Buffer.from(Array.from({ length: 64 }, () => randomInt(256)))]));

    return { rejected, accepted };
}

const { header, pixels, end } = createImageChunks();
const pngWith = (...chunks) => encodePng([header, pixels, ...chunks, end]);
const cardNamed = name => {
    const card = createV2Card();
    card.data.name = name;
    return card;
};
const cardChunk = (keyword, name) => createCardTextChunk(keyword, cardNamed(name));
const payloadChunk = payload => PNGtext.encode('chara', Buffer.from(payload).toString('base64'));
const rawTextChunk = (keyword, text) => ({ name: 'tEXt', data: new Uint8Array(Buffer.from(`${keyword}\0${text}`, 'latin1')) });
const decodeBase64 = text => Buffer.from(text, 'base64').toString('utf8');
const withInvalidUtf8 = (before, after) => Buffer.concat([Buffer.from(before), Buffer.from([0xFF, 0xFE]), Buffer.from(after)]);
const seededBytes = (() => {
    const random = mulberry32(0x0BADF00D);
    const bytes = Buffer.from(Array.from({ length: 256 }, () => Math.floor(random() * 256)));
    bytes[0] = 0;
    return bytes;
})();
const cutBase64 = encodeCardText(createV2Card()).slice(0, -8);
const wrongPayloads = ['not json', '{"name":', '{"name":"Trailing comma",}', 'null', '[]', '42', '"text"', 'true', '{}', '{"name":42}', '{"data":{"name":42}}'];
const firstCard = { parser: { text: JSON.stringify(cardNamed('First')) }, fileName: 'First' };

const CARD_SETS = [
    { id: 'V2 card with a chara chunk', card: createV2Card(), keywords: ['chara'], seed: 0x1234ABCD },
    { id: 'V3 card with chara and ccv3 chunks', card: createV3Card(), keywords: ['chara', 'ccv3'], seed: 0x9E3779B9 },
].map(({ id, card, keywords, seed }) => ({ id, ...mutateCardPng(createCardPng(card, keywords), card, seed) }));

const CONTENT_SET = {
    id: 'chunk content',
    rejected: [
        { name: 'a chara chunk with invalid JSON before a valid duplicate', bytes: pngWith(payloadChunk('{"name":'), cardChunk('chara', 'Second')), parser: { text: '{"name":' } },
        { name: 'text with no Base64 characters', bytes: pngWith(PNGtext.encode('chara', '%%%%')), parser: { text: '' } },
        { name: 'text that is not Base64', bytes: pngWith(PNGtext.encode('chara', 'not base64!')), parser: { text: decodeBase64('not base64!') } },
        { name: 'Base64 that stops inside the card', bytes: pngWith(PNGtext.encode('chara', cutBase64)), parser: { text: decodeBase64(cutBase64) } },
        { name: 'a chara chunk with no text', bytes: pngWith(rawTextChunk('chara', '')), parser: { text: '' } },
        { name: 'a text chunk with a keyword and no separator', bytes: pngWith({ name: 'tEXt', data: new Uint8Array(Buffer.from('chara', 'latin1')) }), parser: { text: '' } },
        ...wrongPayloads.map(payload => ({ name: `a card payload of ${payload}`, bytes: pngWith(payloadChunk(payload)), parser: { text: payload } })),
        { name: 'a payload that is not UTF-8', bytes: pngWith(payloadChunk(withInvalidUtf8('', 'A'))), parser: { text: `${REPLACEMENT}${REPLACEMENT}A` } },
        { name: 'a card keyword with a byte that is not ASCII', bytes: pngWith(PNGtext.encode('chara\xFF', encodeCardText(createV2Card()))), parser: { error: NO_METADATA_ERROR } },
        { name: 'a chara chunk with a NUL in its text', bytes: pngWith(rawTextChunk('chara', `${encodeCardText(createV2Card())}\0extra`)), parser: { error: NUL_ERROR } },
        { name: 'a valid card next to a text chunk with a NUL in its text', bytes: pngWith(rawTextChunk('Comment', 'one\0two'), cardChunk('chara', 'Valid')), parser: { error: NUL_ERROR } },
        { name: 'a card in a zTXt chunk', bytes: pngWith({ name: 'zTXt', data: cardChunk('chara', 'Hidden').data }), parser: { error: NO_METADATA_ERROR } },
        { name: 'an empty text chunk', bytes: pngWith({ name: 'tEXt', data: new Uint8Array(0) }), parser: { error: NO_METADATA_ERROR } },
        { name: 'a PNG with no text chunk', bytes: pngWith(), parser: { error: NO_METADATA_ERROR } },
        { name: 'a card chunk after the IEND chunk', bytes: encodePng([header, pixels, end, cardChunk('chara', 'Late')]), parser: { error: NO_METADATA_ERROR } },
        { name: 'a card chunk before the IHDR chunk', bytes: encodePng([cardChunk('chara', 'Early'), header, pixels, end]), parser: { error: IHDR_ERROR } },
        { name: 'seeded bytes with no signature', bytes: seededBytes, parser: { error: HEADER_ERROR } },
        { name: 'a JSON card sent as a PNG', bytes: Buffer.from(JSON.stringify(createV2Card())), parser: { error: HEADER_ERROR } },
    ],
    accepted: [
        { name: 'a file with two chara chunks', bytes: pngWith(cardChunk('chara', 'First'), cardChunk('chara', 'Second')), ...firstCard },
        { name: 'a file with CHARA and chara chunks', bytes: pngWith(cardChunk('CHARA', 'First'), cardChunk('chara', 'Second')), ...firstCard },
        { name: 'a file with two ccv3 chunks', bytes: pngWith(cardChunk('ccv3', 'First'), cardChunk('ccv3', 'Second')), ...firstCard },
        { name: 'a file with a ccv3 chunk between two chara chunks', bytes: pngWith(cardChunk('chara', 'Second'), cardChunk('ccv3', 'First'), cardChunk('chara', 'Third')), ...firstCard },
        { name: 'a file with a valid chara chunk before a duplicate with text that is not Base64', bytes: pngWith(cardChunk('chara', 'First'), PNGtext.encode('chara', '%%%%')), ...firstCard },
        { name: 'a card with a description that is not UTF-8', bytes: pngWith(payloadChunk(withInvalidUtf8('{"name":"Bytes","description":"A', 'B"}'))), parser: { text: `{"name":"Bytes","description":"A${REPLACEMENT}${REPLACEMENT}B"}` }, fileName: 'Bytes', fields: { description: `A${REPLACEMENT}${REPLACEMENT}B` } },
        { name: 'a card with a name that is not UTF-8', bytes: pngWith(payloadChunk(withInvalidUtf8('{"name":"A', 'B"}'))), parser: { text: `{"name":"A${REPLACEMENT}${REPLACEMENT}B"}` }, fileName: `A${REPLACEMENT}${REPLACEMENT}B` },
    ],
};

const REJECTED_OUTCOME = { status: 200, body: { error: true }, files: [], serverExit: null };

describe('PNG chunk fuzz', () => {
    let baseUrl;
    let directories;
    let server;
    let serverExit = null;
    let serverLog = '';
    let startedAt;
    let tempRoot;

    function serverScript() {
        const sourceUrl = file => JSON.stringify(new URL(`../src/${file}`, import.meta.url).href);
        return `
            import express from 'express';
            import multer from 'multer';
            import ${sourceUrl('fetch-patch.js')};
            import { read } from ${sourceUrl('character-card-parser.js')};
            import { createUploadStorage } from ${sourceUrl('middleware/uploadStorage.js')};
            import multerMonkeyPatch from ${sourceUrl('middleware/multerMonkeyPatch.js')};
            import { setConfigFilePath } from ${sourceUrl('util.js')};

            setConfigFilePath(${JSON.stringify(path.join(repoRoot, 'default', 'config.yaml'))});
            const { router } = await import(${sourceUrl('endpoints/characters.js')});
            const directories = ${JSON.stringify(directories)};
            const app = express();
            app.post('/parser/read', express.raw({ type: () => true, limit: '8mb' }), (request, response) => {
                try {
                    response.json({ text: read(Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)) });
                } catch (error) {
                    response.json({ error: error.message });
                }
            });
            app.use((request, _response, next) => {
                request.user = { profile: { handle: 'png-fuzz-test-user' }, directories };
                next();
            });
            app.use(multer({ storage: createUploadStorage(${JSON.stringify(path.join(tempRoot, '_uploads'))}) }).single('avatar'));
            app.use(multerMonkeyPatch);
            app.use('/api/characters', router);
            const listener = app.listen(0, '127.0.0.1', () => process.stdout.write('listening:' + listener.address().port + '\\n'));
        `;
    }

    beforeAll(async () => {
        startedAt = performance.now();
        tempRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-png-fuzz-'));
        directories = {
            root: tempRoot,
            backups: path.join(tempRoot, 'backups'),
            characters: path.join(tempRoot, 'characters'),
            chats: path.join(tempRoot, 'chats'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
            userImages: path.join(tempRoot, 'user', 'images'),
            worlds: path.join(tempRoot, 'worlds'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }

        server = spawn(process.execPath, ['--input-type=module', '-e', serverScript()], {
            cwd: repoRoot,
            env: { ...process.env, SILLYTAVERN_PERFORMANCE_USEDISKCACHE: 'false' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        server.once('exit', (code, signal) => {
            serverExit = { code, signal };
        });
        server.stderr.setEncoding('utf8');
        server.stderr.on('data', text => {
            serverLog = (serverLog + text).slice(-4000);
        });
        server.stdout.setEncoding('utf8');
        const port = await new Promise((resolve, reject) => {
            let output = '';
            server.stdout.on('data', text => {
                output = (output + text).slice(-100);
                const match = output.match(/listening:(\d+)\n/);
                if (match) {
                    resolve(Number(match[1]));
                }
            });
            server.once('exit', code => reject(new Error(`The server exited with code ${code}: ${serverLog}`)));
        });
        baseUrl = `http://127.0.0.1:${port}`;
    }, 60_000);

    afterAll(async () => {
        if (server && !serverExit) {
            const exited = once(server, 'exit');
            server.kill('SIGKILL');
            await exited;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
    });

    afterEach(() => {
        fs.rmSync(directories.characters, { recursive: true, force: true, maxRetries: 5 });
        fs.mkdirSync(directories.characters);
    });

    async function request(resource, init) {
        try {
            return await fetch(`${baseUrl}${resource}`, { ...init, signal: AbortSignal.timeout(REQUEST_DEADLINE_MS) });
        } catch (error) {
            // A stuck server would make each later row wait for its whole deadline, so stop it and let them fail at once.
            server.kill('SIGKILL');
            throw new Error(`${resource} got no answer (${error.message}). Server exit: ${JSON.stringify(serverExit)}. Server log: ${serverLog}`);
        }
    }

    async function readInServer(bytes) {
        const response = await request('/parser/read', { method: 'POST', body: bytes });
        return response.json();
    }

    async function importOutcome(bytes, fields = {}) {
        const form = new FormData();
        if (bytes) {
            form.append('avatar', new Blob([bytes]), 'upload.png');
        }
        for (const [key, value] of Object.entries({ file_type: 'png', ...fields })) {
            if (value !== undefined) {
                form.append(key, value);
            }
        }
        const response = await request('/api/characters/import', { method: 'POST', body: form });
        const text = await response.text();
        return {
            status: response.status,
            body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
            files: fs.readdirSync(directories.characters, { recursive: true }),
            serverExit,
        };
    }

    function readStoredCard(fileName) {
        const stored = fs.readFileSync(path.join(directories.characters, `${fileName}.png`));
        const chunks = extract(new Uint8Array(stored));
        const cardChunks = chunks
            .filter(chunk => chunk.name === 'tEXt')
            .map(chunk => PNGtext.decode(chunk.data))
            .filter(({ keyword }) => ['chara', 'ccv3'].includes(keyword.toLowerCase()));
        const imageHeader = Buffer.from(chunks[0].data);
        return {
            wellFormed: encodePng(chunks).equals(stored),
            keywords: cardChunks.map(({ keyword }) => keyword),
            cards: cardChunks.map(({ text }) => JSON.parse(decodeBase64(text))),
            size: [imageHeader.readUInt32BE(0), imageHeader.readUInt32BE(4)],
        };
    }

    const parserResult = ({ error, text }) => error ? { error: expect.stringMatching(error) } : { text };

    describe.each([...CARD_SETS, CONTENT_SET])('$id', ({ rejected, accepted }) => {
        test.each(rejected)('$name is rejected', async ({ bytes, parser }) => {
            expect(await readInServer(bytes)).toEqual(parserResult(parser));
            expect(await importOutcome(bytes)).toEqual(REJECTED_OUTCOME);
        });

        test.each(accepted)('$name still imports', async ({ bytes, parser, fileName, fields }) => {
            expect(await readInServer(bytes)).toEqual(parserResult(parser));
            expect(await importOutcome(bytes)).toEqual({ status: 200, body: { file_name: fileName }, files: [`${fileName}.png`], serverExit: null });

            const stored = readStoredCard(fileName);
            expect(stored).toMatchObject({ wellFormed: true, keywords: ['chara', 'ccv3'], size: [2, 3] });
            for (const card of stored.cards) {
                expect(card.data).toMatchObject({ name: fileName, ...fields });
            }
        });
    });

    describe('import route', () => {
        const validPng = createCardPng(createV2Card());

        test('a request without a file gets a 400', async () => {
            expect(await importOutcome(null)).toEqual({ status: 400, body: 'Bad Request', files: [], serverExit: null });
        });

        test.each([
            ['an unknown file type', 'webp'],
            ['no file type', undefined],
        ])('a valid card with %s is rejected', async (_label, fileType) => {
            expect(await importOutcome(validPng, { file_type: fileType })).toEqual(REJECTED_OUTCOME);
        });

        test.each([
            ['a cut file', validPng.subarray(0, 40)],
            ['a wrong CRC', flipBit(validPng, chunkLayout(validPng)[1].crcStart, 3)],
            ['invalid JSON', pngWith(payloadChunk('{"name":'))],
        ])('an upload with %s leaves the card with the preserved name unchanged', async (_label, bytes) => {
            const fields = { preserved_name: 'Existing.png' };
            expect(await importOutcome(validPng, fields)).toMatchObject({ status: 200, body: { file_name: 'Existing' } });
            const existingPath = path.join(directories.characters, 'Existing.png');
            const before = fs.readFileSync(existingPath);

            expect(await importOutcome(bytes, fields)).toEqual({ ...REJECTED_OUTCOME, files: ['Existing.png'] });

            expect(fs.readFileSync(existingPath).equals(before)).toBe(true);
        });
    });

    test('the server still imports a valid card after the whole set', async () => {
        const { name } = createV2Card().data;

        expect(await importOutcome(createCardPng(createV2Card()))).toEqual({ status: 200, body: { file_name: name }, files: [`${name}.png`], serverExit: null });
    });

    test('the whole set stays inside the time budget', () => {
        expect(performance.now() - startedAt).toBeLessThan(TIME_BUDGET_MS);
    });
});
