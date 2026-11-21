import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import multer from 'multer';

import '../src/fetch-patch.js';
import { Jimp, JimpMime } from '../src/jimp.js';
import { createUploadStorage } from '../src/middleware/uploadStorage.js';
import multerMonkeyPatch from '../src/middleware/multerMonkeyPatch.js';
import { getUntrustedRequestAgent } from '../src/private-request-filter.js';
import { setConfigFilePath } from '../src/util.js';
import {
    createByafArchive,
    createByafParts,
    createCardPng,
    createImagePng,
    createV1Card,
    createV2Card,
    createV3Card,
    createZip,
} from './util/card-corpus.js';

const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({
    default: fetchMock,
}));

const PNG_SCENE = createImagePng({ width: 3, height: 3, rgba: [20, 140, 220, 255] });
const PNG_ALT = createImagePng({ width: 4, height: 2, rgba: [220, 80, 40, 255] });
const JPEG_PHOTO = await new Jimp({ width: 3, height: 2, color: 0x336699ff }).getBuffer(JimpMime.jpeg, { quality: 90, jpegColorSpace: 'ycbcr' });
const GIF_BG = await new Jimp({ width: 2, height: 2, color: 0xcc8800ff }).getBuffer(JimpMime.gif);
const HTML_PAGE = Buffer.from('<!doctype html><title>Not an image</title>', 'utf8');
const SVG_VECTOR = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>', 'utf8');

const hash8 = buffer => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 8);

function mockImageResponse(buffer, status = 200, headers = {}) {
    const normalizedHeaders = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
    );
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: {
            get: name => normalizedHeaders[String(name).toLowerCase()] ?? null,
        },
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    };
}

describe('external media import (#952)', () => {
    let baseUrl;
    let directories;
    let extractExternalMediaSpans;
    let isValidExternalMediaUrl;
    let readCharacterData;
    let server;
    let tempRoot;
    let uploadMiddleware;
    let originalWorkingDirectory;

    beforeAll(async () => {
        originalWorkingDirectory = process.cwd();
        const repoRoot = path.resolve(originalWorkingDirectory, '..');
        process.chdir(repoRoot);
        setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));
        ({ extractExternalMediaSpans, isValidExternalMediaUrl } = await import('../src/external-media-import.js'));
        ({ read: readCharacterData } = await import('../src/character-card-parser.js'));
        const { router: charactersRouter } = await import('../src/endpoints/characters.js');
        const { router: worldInfoRouter } = await import('../src/endpoints/worldinfo.js');

        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'media-import-test-user' }, directories };
            next();
        });
        app.use((request, response, next) => uploadMiddleware(request, response, next));
        app.use(multerMonkeyPatch);
        app.use('/api/characters', charactersRouter);
        app.use('/api/worldinfo', worldInfoRouter);

        server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        fetchMock.mockReset();
        for (const method of ['error', 'info', 'log', 'warn']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
        tempRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-ext-media-import-'));
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
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (tempRoot) {
            fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
        }
    });

    afterAll(async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        process.chdir(originalWorkingDirectory);
    });

    async function importCharacterCard(bytes, fileType, fields = {}) {
        const form = new FormData();
        form.append('avatar', new Blob([bytes]), `upload.${fileType}`);
        form.append('file_type', fileType);
        form.append('user_name', 'Tester');
        for (const [key, value] of Object.entries(fields)) {
            form.append(key, value);
        }
        const response = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: form });
        const text = await response.text();
        return {
            status: response.status,
            body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
        };
    }

    async function importWorldInfoFile(contents, { filename = 'Lorebook.json', name, convertedData, import_external_media } = {}) {
        const form = new FormData();
        form.append('avatar', new Blob([contents], { type: 'application/json' }), filename);
        if (name !== undefined) {
            form.set('name', name);
        }
        if (convertedData !== undefined) {
            form.set('convertedData', convertedData);
        }
        if (import_external_media !== undefined) {
            form.set('import_external_media', String(import_external_media));
        }
        const response = await fetch(`${baseUrl}/api/worldinfo/import`, { method: 'POST', body: form });
        const text = await response.text();
        return {
            status: response.status,
            body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
        };
    }

    function readStoredCard(fileName) {
        const pngBuffer = fs.readFileSync(path.join(directories.characters, `${fileName}.png`));
        return JSON.parse(readCharacterData(pngBuffer));
    }

    describe('URL validation and span extraction', () => {
        test.each([
            ['relative path', '/user/images/test.png'],
            ['file protocol', 'file:///etc/passwd'],
            ['ftp protocol', 'ftp://files.catbox.moe/a.png'],
            ['non-standard port', 'https://files.catbox.moe:8443/a.png'],
            ['embedded credentials', 'https://user:pass@files.catbox.moe/a.png'],
            ['localhost', 'http://localhost/a.png'],
            ['localhost trailing dot', 'http://localhost./a.png'],
            ['localhost subdomain', 'https://sub.localhost/a.png'],
            ['localhost subdomain trailing dot', 'https://sub.localhost./a.png'],
            ['IPv4 loopback', 'http://127.0.0.1/a.png'],
            ['IPv4 private', 'http://192.168.1.10/a.png'],
            ['IPv4 metadata', 'http://169.254.169.254/latest/meta-data/'],
            ['IPv4 hex literal', 'http://0x7f000001/a.png'],
            ['IPv6 loopback', 'http://[::1]/a.png'],
            ['unresolved macro', 'https://files.catbox.moe/{{getvar::img}}.png'],
        ])('rejects %s (%s)', (_label, url) => {
            expect(isValidExternalMediaUrl(url)).toBe(false);
        });

        test('extracts Markdown, HTML, srcset, CSS url(), and bare image URLs without touching macro or webpage links', () => {
            const sample = [
                '![scene](https://files.catbox.moe/scene.png "Title")',
                '<img src="https://file.garden/u/pic?fmt=webp&amp;w=200" srcset="https://files.catbox.moe/1x.png 1x, https://files.catbox.moe/2x.png 2x">',
                '<div style="background: url(\'https://files.catbox.moe/bg.gif\')"></div>',
                'Bare URLs: https://files.catbox.moe/bare.jpg, and (https://file.garden/u/other.webp).',
                'Skip macro: ![dyn](https://files.catbox.moe/{{char}}.png) and webpage https://chub.ai/users/creator.',
            ].join('\n');

            const spans = extractExternalMediaSpans(sample);
            expect(spans.map(span => span.fetchUrl)).toEqual([
                'https://files.catbox.moe/scene.png',
                'https://file.garden/u/pic?fmt=webp&w=200',
                'https://files.catbox.moe/1x.png',
                'https://files.catbox.moe/2x.png',
                'https://files.catbox.moe/bg.gif',
                'https://files.catbox.moe/bare.jpg',
                'https://file.garden/u/other.webp',
            ]);
        });

        test('an unclosed image or media tag does not take the link after it', () => {
            expect(extractExternalMediaSpans('![ and [profile](https://chub.ai/users/creator)')).toEqual([]);
            expect(extractExternalMediaSpans('<img and <a href="https://chub.ai/users/creator">profile</a>')).toEqual([]);
            expect(extractExternalMediaSpans('url( and (https://chub.ai/users/creator)')).toEqual([]);
        });

        // The scan runs on the server's only thread. Before the classes were bounded, each of these texts took
        // seconds and the time grew with the square of the length.
        test.each([
            ['unclosed Markdown images', '!['],
            ['unclosed Markdown images with an angle URL', '![a](<'],
            ['unclosed media tags', '<img '],
            ['unclosed CSS url()', 'url('],
        ])('scans 200,000 repeated %s within the time budget', (_label, fragment) => {
            const text = `https://files.catbox.moe/a.png ${fragment.repeat(200_000)}`;
            const startedAt = performance.now();
            const spans = extractExternalMediaSpans(text);
            expect(performance.now() - startedAt).toBeLessThan(2000);
            expect(spans.map(span => span.fetchUrl)).toEqual(['https://files.catbox.moe/a.png']);
        });

        test('scans a field with 50,000 image URLs within the time budget and keeps their order', () => {
            const urls = Array.from({ length: 50_000 }, (_, index) => `https://files.catbox.moe/${index}.png`);
            const text = `<img srcset="${urls.map(url => `${url} 1x`).join(', ')}"> ${urls.map(url => `![scene](${url})`).join(' ')}`;
            const startedAt = performance.now();
            const spans = extractExternalMediaSpans(text);
            expect(performance.now() - startedAt).toBeLessThan(5000);
            expect(spans).toHaveLength(100_000);
            expect(spans.every((span, index) => index === 0 || spans[index - 1].end <= span.start)).toBe(true);
        });
    });

    describe('character card imports', () => {
        test('does not fetch or rewrite external URLs when import_external_media is disabled (default)', async () => {
            const card = createV2Card();
            card.data.first_mes = 'Welcome! ![scene](https://files.catbox.moe/scene.png)';

            const answer = await importCharacterCard(createCardPng(card), 'png');

            expect(answer.status).toBe(200);
            expect(fetchMock).not.toHaveBeenCalled();
            const saved = readStoredCard(answer.body.file_name);
            expect(saved.first_mes).toBe('Welcome! ![scene](https://files.catbox.moe/scene.png)');
            expect(saved.data.first_mes).toBe('Welcome! ![scene](https://files.catbox.moe/scene.png)');
            expect(fs.readdirSync(directories.userImages)).toEqual([]);
        });

        test('downloads external images once, stores them under user/images/<card>/, and rewrites all card fields on PNG import', async () => {
            const routes = new Map([
                ['https://files.catbox.moe/scene.png', mockImageResponse(PNG_SCENE)],
                ['https://file.garden/user/alt.png?w=400&mode=fit', mockImageResponse(PNG_ALT)],
                ['https://cdn.example.com/render?id=99', mockImageResponse(JPEG_PHOTO)],
                ['https://files.catbox.moe/bg.gif', mockImageResponse(GIF_BG)],
            ]);
            fetchMock.mockImplementation(async (url) => routes.get(String(url)) ?? mockImageResponse(Buffer.alloc(0), 404));

            const card = createV3Card();
            card.data.name = 'Seraphina';
            card.data.description = 'Outfit reference: https://files.catbox.moe/scene.png.';
            card.data.first_mes = 'Hello! ![Opening](https://files.catbox.moe/scene.png "Intro")';
            card.data.alternate_greetings = [
                '<img class="cg" src="https://file.garden/user/alt.png?w=400&amp;mode=fit" alt="alt">',
                'Extensionless markdown image: ![dynamic](https://cdn.example.com/render?id=99)',
            ];
            card.data.group_only_greetings = ['Group banner: https://files.catbox.moe/scene.png'];
            card.data.creator_notes = '<style>.box { background-image: url("https://files.catbox.moe/bg.gif"); }</style> Creator page: https://chub.ai/users/author';
            card.data.creator_notes_multilang = {
                en: '![en](https://files.catbox.moe/scene.png)',
                ja: '![ja](https://file.garden/user/alt.png?w=400&mode=fit)',
            };
            card.data.extensions.depth_prompt = {
                prompt: 'Remember https://files.catbox.moe/scene.png',
                depth: 2,
                role: 'system',
            };
            card.data.extensions.regex_scripts = [
                {
                    id: 'hud',
                    scriptName: 'HUD',
                    findRegex: '/status/',
                    replaceString: '<img src="https://files.catbox.moe/bg.gif">',
                },
            ];
            card.data.character_book.entries[0].content = 'Lore image: ![dock](https://files.catbox.moe/scene.png) and macro ![skip](https://files.catbox.moe/{{char}}.png)';
            card.data.assets = [
                { type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' },
                { type: 'other', uri: 'https://files.catbox.moe/scene.png', name: 'scene', ext: 'png' },
            ];

            const answer = await importCharacterCard(createCardPng(card, ['chara', 'ccv3']), 'png', {
                import_external_media: 'true',
            });

            expect(answer).toEqual({ status: 200, body: { file_name: 'Seraphina' } });
            // 4 unique URLs, even though scene.png appeared 7 times across fields
            expect(fetchMock).toHaveBeenCalledTimes(4);
            for (const [, options] of fetchMock.mock.calls) {
                expect(options.agent).toBe(getUntrustedRequestAgent());
                expect(options.redirect).toBe('manual');
            }

            const expectedScene = `/user/images/Seraphina/scene-${hash8(PNG_SCENE)}.png`;
            const expectedAlt = `/user/images/Seraphina/alt-${hash8(PNG_ALT)}.png`;
            const expectedRender = `/user/images/Seraphina/render-${hash8(JPEG_PHOTO)}.jpg`;
            const expectedBg = `/user/images/Seraphina/bg-${hash8(GIF_BG)}.gif`;

            const saved = readStoredCard('Seraphina');
            expect(saved.description).toBe(`Outfit reference: ${expectedScene}.`);
            expect(saved.data.description).toBe(`Outfit reference: ${expectedScene}.`);
            expect(saved.first_mes).toBe(`Hello! ![Opening](${expectedScene} "Intro")`);
            expect(saved.data.first_mes).toBe(`Hello! ![Opening](${expectedScene} "Intro")`);
            expect(saved.data.alternate_greetings).toEqual([
                `<img class="cg" src="${expectedAlt}" alt="alt">`,
                `Extensionless markdown image: ![dynamic](${expectedRender})`,
            ]);
            expect(saved.data.group_only_greetings).toEqual([`Group banner: ${expectedScene}`]);
            expect(saved.creatorcomment).toBe(`<style>.box { background-image: url("${expectedBg}"); }</style> Creator page: https://chub.ai/users/author`);
            expect(saved.data.creator_notes).toBe(saved.creatorcomment);
            expect(saved.data.creator_notes_multilang).toEqual({
                en: `![en](${expectedScene})`,
                ja: `![ja](${expectedAlt})`,
            });
            expect(saved.data.extensions.depth_prompt.prompt).toBe(`Remember ${expectedScene}`);
            expect(saved.data.extensions.regex_scripts[0].replaceString).toBe(`<img src="${expectedBg}">`);
            expect(saved.data.character_book.entries[0].content).toBe(
                `Lore image: ![dock](${expectedScene}) and macro ![skip](https://files.catbox.moe/{{char}}.png)`,
            );
            expect(saved.data.assets[1].uri).toBe(expectedScene);
            // Provenance URL in data.source must never be touched
            expect(saved.data.source).toEqual(['https://example.invalid/cards/ren']);

            // Verify actual files on disk match original bytes
            const folderPath = path.join(directories.userImages, 'Seraphina');
            expect(fs.readFileSync(path.join(folderPath, `scene-${hash8(PNG_SCENE)}.png`)).equals(PNG_SCENE)).toBe(true);
            expect(fs.readFileSync(path.join(folderPath, `alt-${hash8(PNG_ALT)}.png`)).equals(PNG_ALT)).toBe(true);
            expect(fs.readFileSync(path.join(folderPath, `render-${hash8(JPEG_PHOTO)}.jpg`)).equals(JPEG_PHOTO)).toBe(true);
            expect(fs.readFileSync(path.join(folderPath, `bg-${hash8(GIF_BG)}.gif`)).equals(GIF_BG)).toBe(true);
        });

        test('honours explicit import_external_media=false override even when settings.json has it enabled', async () => {
            fs.writeFileSync(
                path.join(directories.root, 'settings.json'),
                JSON.stringify({ power_user: { import_external_media: true } }),
            );

            const card = createV2Card();
            card.data.name = 'Override Off';
            card.data.first_mes = 'Welcome! ![scene](https://files.catbox.moe/scene.png)';

            const answer = await importCharacterCard(createCardPng(card), 'png', {
                import_external_media: 'false',
            });

            expect(answer).toEqual({ status: 200, body: { file_name: 'Override Off' } });
            expect(fetchMock).not.toHaveBeenCalled();
            expect(readStoredCard('Override Off').first_mes).toBe('Welcome! ![scene](https://files.catbox.moe/scene.png)');
        });

        test('honours persisted power_user.import_external_media in settings.json across V1 JSON, YAML, CharX, and BYAF imports', async () => {
            fs.writeFileSync(
                path.join(directories.root, 'settings.json'),
                JSON.stringify({ power_user: { import_external_media: true } }),
            );
            fetchMock.mockResolvedValue(mockImageResponse(PNG_SCENE));

            // 1. V1 JSON card
            const v1 = createV1Card();
            v1.name = 'V1 Hero';
            v1.first_mes = '![v1](https://files.catbox.moe/scene.png)';
            const v1Answer = await importCharacterCard(Buffer.from(JSON.stringify(v1)), 'json');
            expect(v1Answer).toEqual({ status: 200, body: { file_name: 'V1 Hero' } });
            const expectedV1Url = `/user/images/${encodeURIComponent('V1 Hero')}/scene-${hash8(PNG_SCENE)}.png`;
            expect(readStoredCard('V1 Hero').first_mes).toBe(`![v1](${expectedV1Url})`);

            // 2. YAML card
            const yamlText = [
                'name: Yaml Hero',
                'context: "Portrait: https://files.catbox.moe/scene.png"',
                'greeting: "Hello ![yaml](https://files.catbox.moe/scene.png)"',
            ].join('\n');
            const yamlAnswer = await importCharacterCard(Buffer.from(yamlText, 'utf8'), 'yaml');
            expect(yamlAnswer).toEqual({ status: 200, body: { file_name: 'Yaml Hero' } });
            const expectedYamlUrl = `/user/images/${encodeURIComponent('Yaml Hero')}/scene-${hash8(PNG_SCENE)}.png`;
            expect(readStoredCard('Yaml Hero').first_mes).toBe(`Hello ![yaml](${expectedYamlUrl})`);

            // 3. CharX archive
            const charxCard = createV3Card();
            charxCard.data.name = 'CharX Hero';
            charxCard.data.first_mes = '![charx](https://files.catbox.moe/scene.png)';
            const charxZip = await createZip([{ name: 'card.json', content: JSON.stringify(charxCard) }]);
            const charxAnswer = await importCharacterCard(charxZip, 'charx');
            expect(charxAnswer).toEqual({ status: 200, body: { file_name: 'CharX Hero' } });
            const expectedCharxUrl = `/user/images/${encodeURIComponent('CharX Hero')}/scene-${hash8(PNG_SCENE)}.png`;
            expect(readStoredCard('CharX Hero').first_mes).toBe(`![charx](${expectedCharxUrl})`);

            // 4. BYAF archive (card + scenario chat messages)
            const byafParts = createByafParts();
            byafParts.character.loreItems[0].value = 'Lore pic: https://files.catbox.moe/scene.png';
            byafParts.scenarios[0].firstMessages[0].text = 'Welcome ![byaf](https://files.catbox.moe/scene.png)';
            byafParts.scenarios[0].messages[0].text = 'Look at https://files.catbox.moe/scene.png';
            const byafAnswer = await importCharacterCard(await createByafArchive(byafParts), 'byaf');
            expect(byafAnswer).toEqual({ status: 200, body: { file_name: 'Søren 桜' } });
            const expectedByafUrl = `/user/images/soren/scene-${hash8(PNG_SCENE)}.png`;
            const savedByaf = readStoredCard('Søren 桜');
            expect(savedByaf.first_mes).toBe(`Welcome ![byaf](${expectedByafUrl})`);
            expect(savedByaf.data.character_book.entries[0].content).toBe(`Lore pic: ${expectedByafUrl}`);
            const chatFolder = path.join(directories.chats, 'Søren 桜');
            const [chatFile] = fs.readdirSync(chatFolder);
            const chatContent = fs.readFileSync(path.join(chatFolder, chatFile), 'utf8');
            expect(chatContent).toContain(expectedByafUrl);
        });
    });

    describe('World Info / lorebook imports', () => {
        test('downloads external media in World Info entries and originalData and returns the updated payload', async () => {
            fetchMock.mockResolvedValue(mockImageResponse(PNG_SCENE));

            const worldPayload = {
                name: 'Eldoria Atlas',
                description: 'Map: ![map](https://files.catbox.moe/scene.png)',
                entries: {
                    0: {
                        uid: 0,
                        key: ['castle'],
                        comment: 'Castle view https://files.catbox.moe/scene.png',
                        content: '<img src="https://files.catbox.moe/scene.png">',
                    },
                },
                originalData: {
                    name: 'Eldoria Atlas',
                    description: 'Map: ![map](https://files.catbox.moe/scene.png)',
                    entries: [
                        {
                            id: 0,
                            keys: ['castle'],
                            comment: 'Castle view https://files.catbox.moe/scene.png',
                            content: '<img src="https://files.catbox.moe/scene.png">',
                        },
                    ],
                },
            };

            const answer = await importWorldInfoFile(JSON.stringify(worldPayload), {
                filename: 'Eldoria Atlas.json',
                name: 'Eldoria Atlas',
                import_external_media: 'true',
            });

            const expectedUrl = `/user/images/${encodeURIComponent('Eldoria Atlas')}/scene-${hash8(PNG_SCENE)}.png`;
            expect(answer.status).toBe(200);
            expect(answer.body.name).toBe('Eldoria Atlas');
            expect(answer.body.data.description).toBe(`Map: ![map](${expectedUrl})`);
            expect(answer.body.data.entries[0].content).toBe(`<img src="${expectedUrl}">`);
            expect(answer.body.data.originalData.entries[0].content).toBe(`<img src="${expectedUrl}">`);

            const persisted = JSON.parse(fs.readFileSync(path.join(directories.worlds, 'Eldoria Atlas.json'), 'utf8'));
            expect(persisted.entries[0].content).toBe(`<img src="${expectedUrl}">`);
            expect(persisted.originalData.entries[0].content).toBe(`<img src="${expectedUrl}">`);
            expect(
                fs.readFileSync(path.join(directories.userImages, 'Eldoria Atlas', `scene-${hash8(PNG_SCENE)}.png`)).equals(PNG_SCENE),
            ).toBe(true);
        });
    });

    describe('security, SSRF, file-type validation, and fail-open resilience', () => {
        test('blocks SSRF redirects to localhost or private IPs, rejects non-image payloads, and fails open so valid images still import', async () => {
            fetchMock.mockImplementation(async (url) => {
                switch (String(url)) {
                    case 'https://files.catbox.moe/redirect-to-local.png':
                        return mockImageResponse(Buffer.alloc(0), 302, { location: 'http://127.0.0.1:4444/secret.png' });
                    case 'https://files.catbox.moe/disguised-html.png':
                        return mockImageResponse(HTML_PAGE, 200, { 'content-type': 'image/png' });
                    case 'https://files.catbox.moe/disguised-svg.png':
                        return mockImageResponse(SVG_VECTOR, 200, { 'content-type': 'image/svg+xml' });
                    case 'https://files.catbox.moe/missing.png':
                        return mockImageResponse(Buffer.alloc(0), 404);
                    case 'https://files.catbox.moe/valid.png':
                        return mockImageResponse(PNG_SCENE, 200, { 'content-type': 'image/png' });
                    default:
                        throw new Error(`Unexpected fetch URL: ${url}`);
                }
            });

            const card = createV2Card();
            card.data.name = '..';
            card.data.first_mes = [
                '![local](http://127.0.0.1/private.png)',
                '![redir](https://files.catbox.moe/redirect-to-local.png)',
                '![html](https://files.catbox.moe/disguised-html.png)',
                '![svg](https://files.catbox.moe/disguised-svg.png)',
                '![missing](https://files.catbox.moe/missing.png)',
                '![valid](https://files.catbox.moe/valid.png)',
            ].join('\n');

            const answer = await importCharacterCard(createCardPng(card), 'png', {
                import_external_media: 'true',
            });

            // Card name '..' sanitizes to empty, so getPngName falls back to 'character'
            expect(answer).toEqual({ status: 200, body: { file_name: 'character' } });
            // 127.0.0.1 was rejected before fetch; redirect hop to 127.0.0.1 was rejected before following
            expect(fetchMock.mock.calls.map(call => call[0]).sort()).toEqual([
                'https://files.catbox.moe/disguised-html.png',
                'https://files.catbox.moe/disguised-svg.png',
                'https://files.catbox.moe/missing.png',
                'https://files.catbox.moe/redirect-to-local.png',
                'https://files.catbox.moe/valid.png',
            ]);

            const expectedValid = `/user/images/character/valid-${hash8(PNG_SCENE)}.png`;
            const saved = readStoredCard('character');
            expect(saved.first_mes).toBe([
                '![local](http://127.0.0.1/private.png)',
                '![redir](https://files.catbox.moe/redirect-to-local.png)',
                '![html](https://files.catbox.moe/disguised-html.png)',
                '![svg](https://files.catbox.moe/disguised-svg.png)',
                '![missing](https://files.catbox.moe/missing.png)',
                `![valid](${expectedValid})`,
            ].join('\n'));
            expect(fs.readdirSync(path.join(directories.userImages, 'character'))).toEqual([
                `valid-${hash8(PNG_SCENE)}.png`,
            ]);
        });

        test('requestWithNodeHttp enforces getUntrustedRequestAgent() and does not follow redirects', async () => {
            const http = await import('node:http');
            const { requestWithNodeHttp } = await import('../src/external-media-import.js');
            const localServer = http.createServer((_req, res) => {
                res.writeHead(200, { 'content-type': 'image/png' });
                res.end(PNG_SCENE);
            });
            await new Promise(resolve => localServer.listen(0, '127.0.0.1', resolve));
            try {
                const { port } = localServer.address();
                await expect(
                    requestWithNodeHttp(`http://127.0.0.1:${port}/test.png`, {
                        agent: getUntrustedRequestAgent(),
                        signal: AbortSignal.timeout(3000),
                    }),
                ).rejects.toThrow(/Blocked request to private IP address/);
            } finally {
                await new Promise(resolve => localServer.close(resolve));
            }
        });
    });
});
