import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
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

const hash16 = buffer => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

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
    let localizeCharacterExternalMedia;
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
        ({ extractExternalMediaSpans, isValidExternalMediaUrl, localizeCharacterExternalMedia } = await import('../src/external-media-import.js'));
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

        // The scan runs on the server's only thread, so its time must stay linear in the length of a hostile field.
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

            const expectedScene = `/user/images/Seraphina/scene-${hash16(PNG_SCENE)}.png`;
            const expectedAlt = `/user/images/Seraphina/alt-${hash16(PNG_ALT)}.png`;
            const expectedRender = `/user/images/Seraphina/render-${hash16(JPEG_PHOTO)}.jpg`;
            const expectedBg = `/user/images/Seraphina/bg-${hash16(GIF_BG)}.gif`;

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
            expect(fs.readFileSync(path.join(folderPath, `scene-${hash16(PNG_SCENE)}.png`)).equals(PNG_SCENE)).toBe(true);
            expect(fs.readFileSync(path.join(folderPath, `alt-${hash16(PNG_ALT)}.png`)).equals(PNG_ALT)).toBe(true);
            expect(fs.readFileSync(path.join(folderPath, `render-${hash16(JPEG_PHOTO)}.jpg`)).equals(JPEG_PHOTO)).toBe(true);
            expect(fs.readFileSync(path.join(folderPath, `bg-${hash16(GIF_BG)}.gif`)).equals(GIF_BG)).toBe(true);
        });

        test('downloads across V1 JSON, YAML, CharX, and BYAF imports when the request field is true', async () => {
            fetchMock.mockResolvedValue(mockImageResponse(PNG_SCENE));
            const on = { import_external_media: 'true' };

            // 1. V1 JSON card
            const v1 = createV1Card();
            v1.name = 'V1 Hero';
            v1.first_mes = '![v1](https://files.catbox.moe/scene.png)';
            const v1Answer = await importCharacterCard(Buffer.from(JSON.stringify(v1)), 'json', on);
            expect(v1Answer).toEqual({ status: 200, body: { file_name: 'V1 Hero' } });
            const expectedV1Url = `/user/images/${encodeURIComponent('V1 Hero')}/scene-${hash16(PNG_SCENE)}.png`;
            expect(readStoredCard('V1 Hero').first_mes).toBe(`![v1](${expectedV1Url})`);

            // 2. YAML card
            const yamlText = [
                'name: Yaml Hero',
                'context: "Portrait: https://files.catbox.moe/scene.png"',
                'greeting: "Hello ![yaml](https://files.catbox.moe/scene.png)"',
            ].join('\n');
            const yamlAnswer = await importCharacterCard(Buffer.from(yamlText, 'utf8'), 'yaml', on);
            expect(yamlAnswer).toEqual({ status: 200, body: { file_name: 'Yaml Hero' } });
            const expectedYamlUrl = `/user/images/${encodeURIComponent('Yaml Hero')}/scene-${hash16(PNG_SCENE)}.png`;
            expect(readStoredCard('Yaml Hero').first_mes).toBe(`Hello ![yaml](${expectedYamlUrl})`);

            // 3. CharX archive
            const charxCard = createV3Card();
            charxCard.data.name = 'CharX Hero';
            charxCard.data.first_mes = '![charx](https://files.catbox.moe/scene.png)';
            const charxZip = await createZip([{ name: 'card.json', content: JSON.stringify(charxCard) }]);
            const charxAnswer = await importCharacterCard(charxZip, 'charx', on);
            expect(charxAnswer).toEqual({ status: 200, body: { file_name: 'CharX Hero' } });
            const expectedCharxUrl = `/user/images/${encodeURIComponent('CharX Hero')}/scene-${hash16(PNG_SCENE)}.png`;
            expect(readStoredCard('CharX Hero').first_mes).toBe(`![charx](${expectedCharxUrl})`);

            // 4. BYAF archive (card + scenario chat messages)
            const byafParts = createByafParts();
            byafParts.character.loreItems[0].value = 'Lore pic: https://files.catbox.moe/scene.png';
            byafParts.scenarios[0].firstMessages[0].text = 'Welcome ![byaf](https://files.catbox.moe/scene.png)';
            byafParts.scenarios[0].messages[0].text = 'Look at https://files.catbox.moe/scene.png';
            const byafAnswer = await importCharacterCard(await createByafArchive(byafParts), 'byaf', on);
            expect(byafAnswer).toEqual({ status: 200, body: { file_name: 'Søren 桜' } });
            const expectedByafUrl = `/user/images/soren/scene-${hash16(PNG_SCENE)}.png`;
            const savedByaf = readStoredCard('Søren 桜');
            expect(savedByaf.first_mes).toBe(`Welcome ![byaf](${expectedByafUrl})`);
            expect(savedByaf.data.character_book.entries[0].content).toBe(`Lore pic: ${expectedByafUrl}`);
            const chatFolder = path.join(directories.chats, 'Søren 桜');
            const [chatFile] = fs.readdirSync(chatFolder);
            const chatContent = fs.readFileSync(path.join(chatFolder, chatFile), 'utf8');
            expect(chatContent).toContain(expectedByafUrl);
        });
    });

    describe('original URLs on export', () => {
        const MANIFEST = '.external-media.json';

        async function exportCharacter(avatarUrl, format) {
            const response = await fetch(`${baseUrl}/api/characters/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ avatar_url: avatarUrl, format }),
            });
            return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
        }

        const exportedCard = async (avatarUrl, format) => {
            const { status, bytes } = await exportCharacter(avatarUrl, format);
            expect(status).toBe(200);
            return format === 'png' ? JSON.parse(readCharacterData(bytes)) : JSON.parse(bytes.toString('utf8'));
        };

        function routeImages(routes) {
            fetchMock.mockImplementation(async url => routes.get(String(url)) ?? mockImageResponse(Buffer.alloc(0), 404));
        }

        test('an exported card carries the URLs of its author, byte for byte, in Markdown, HTML and CSS', async () => {
            routeImages(new Map([
                ['https://files.catbox.moe/scene.png', mockImageResponse(PNG_SCENE)],
                ['https://file.garden/u/alt.png?fmt=webp&w=200', mockImageResponse(PNG_ALT)],
                ['https://files.catbox.moe/bg.gif', mockImageResponse(GIF_BG)],
            ]));
            const card = createV2Card();
            card.data.name = 'Exporter';
            card.data.first_mes = 'Hi ![scene](https://files.catbox.moe/scene.png "Title") there';
            card.data.description = '<img class="a" src="https://file.garden/u/alt.png?fmt=webp&amp;w=200" alt="x">';
            card.data.scenario = '<div style="background: url(\'https://files.catbox.moe/bg.gif\')"></div>';
            const answer = await importCharacterCard(createCardPng(card), 'png', { import_external_media: 'true' });
            expect(answer.status).toBe(200);
            const stored = readStoredCard('Exporter');
            expect(stored.data.first_mes).toContain('/user/images/Exporter/');

            for (const format of ['json', 'png']) {
                const exported = await exportedCard('Exporter.png', format);
                expect(exported.data.first_mes).toBe(card.data.first_mes);
                expect(exported.data.description).toBe(card.data.description);
                expect(exported.data.scenario).toBe(card.data.scenario);
            }
            // The stored card keeps the local paths.
            expect(readStoredCard('Exporter').data.first_mes).toBe(stored.data.first_mes);
        });

        test('writes one manifest per folder that maps each stored file to its original URL', async () => {
            routeImages(new Map([['https://files.catbox.moe/scene.png', mockImageResponse(PNG_SCENE)]]));
            const card = createV2Card();
            card.data.name = 'Mapper';
            card.data.first_mes = '![scene](https://files.catbox.moe/scene.png)';
            await importCharacterCard(createCardPng(card), 'png', { import_external_media: 'true' });

            const folder = path.join(directories.userImages, 'Mapper');
            const manifest = JSON.parse(fs.readFileSync(path.join(folder, MANIFEST), 'utf8'));
            expect(manifest).toEqual({ [`scene-${hash16(PNG_SCENE)}.png`]: { url: 'https://files.catbox.moe/scene.png' } });
        });

        test('restores a folder name that the stored URL encodes', async () => {
            routeImages(new Map([['https://files.catbox.moe/scene.png', mockImageResponse(PNG_SCENE)]]));
            const card = createV2Card();
            card.data.name = 'D\'Artagnan (alt)';
            card.data.first_mes = '![scene](https://files.catbox.moe/scene.png)';
            const answer = await importCharacterCard(createCardPng(card), 'png', { import_external_media: 'true' });
            expect(answer.status).toBe(200);
            expect(readStoredCard(answer.body.file_name).data.first_mes).toContain('D%27Artagnan%20%28alt%29');

            const exported = await exportedCard(`${answer.body.file_name}.png`, 'json');
            expect(exported.data.first_mes).toBe('![scene](https://files.catbox.moe/scene.png)');
        });

        test('a local path that no manifest lists stays as it is', async () => {
            routeImages(new Map([['https://files.catbox.moe/scene.png', mockImageResponse(PNG_SCENE)]]));
            const card = createV2Card();
            card.data.name = 'Unlisted';
            card.data.first_mes = '![scene](https://files.catbox.moe/scene.png)';
            card.data.description = 'Mine: ![own](/user/images/Unlisted/own-0123456789abcdef.png) and ![other](/user/images/Nowhere/x-0123456789abcdef.png)';
            await importCharacterCard(createCardPng(card), 'png', { import_external_media: 'true' });

            const exported = await exportedCard('Unlisted.png', 'json');
            expect(exported.data.first_mes).toBe('![scene](https://files.catbox.moe/scene.png)');
            expect(exported.data.description).toBe(card.data.description);
        });

        test('a damaged manifest does not break the export', async () => {
            routeImages(new Map([['https://files.catbox.moe/scene.png', mockImageResponse(PNG_SCENE)]]));
            const card = createV2Card();
            card.data.name = 'Damaged';
            card.data.first_mes = '![scene](https://files.catbox.moe/scene.png)';
            await importCharacterCard(createCardPng(card), 'png', { import_external_media: 'true' });
            const localPath = readStoredCard('Damaged').data.first_mes;

            for (const damage of ['{not json', '[]', 'null', '{"x":{"url":42}}', '{"__proto__":{"url":"https://evil.test/a.png"}}']) {
                fs.writeFileSync(path.join(directories.userImages, 'Damaged', MANIFEST), damage);
                for (const format of ['json', 'png']) {
                    const exported = await exportedCard('Damaged.png', format);
                    expect(exported.data.first_mes).toBe(localPath);
                }
            }
            fs.rmSync(path.join(directories.userImages, 'Damaged', MANIFEST));
            expect((await exportedCard('Damaged.png', 'json')).data.first_mes).toBe(localPath);
        });

        test('two cards that share a folder keep both mappings', async () => {
            routeImages(new Map([
                ['https://files.catbox.moe/one.png', mockImageResponse(PNG_SCENE)],
                ['https://files.catbox.moe/two.png', mockImageResponse(PNG_ALT)],
            ]));
            const first = createV2Card();
            first.data.name = 'Twins';
            first.data.first_mes = '![one](https://files.catbox.moe/one.png)';
            const second = createV2Card();
            second.data.name = 'Twins';
            second.data.first_mes = '![two](https://files.catbox.moe/two.png)';
            const a = await importCharacterCard(createCardPng(first), 'png', { import_external_media: 'true' });
            const b = await importCharacterCard(createCardPng(second), 'png', { import_external_media: 'true' });
            expect(a.status).toBe(200);
            expect(b.status).toBe(200);

            const manifest = JSON.parse(fs.readFileSync(path.join(directories.userImages, 'Twins', MANIFEST), 'utf8'));
            expect(Object.values(manifest).map(entry => entry.url).sort()).toEqual([
                'https://files.catbox.moe/one.png',
                'https://files.catbox.moe/two.png',
            ]);
            const texts = [];
            for (const name of [a.body.file_name, b.body.file_name]) {
                texts.push((await exportedCard(`${name}.png`, 'json')).data.first_mes);
            }
            expect(texts.sort()).toEqual([
                '![one](https://files.catbox.moe/one.png)',
                '![two](https://files.catbox.moe/two.png)',
            ]);
        });

        test('imports that write into one folder at once keep every mapping', async () => {
            const { recordExternalMediaOrigins, readExternalMediaManifest } = await import('../src/external-media-manifest.js');
            const folder = path.join(directories.userImages, 'Parallel');
            fs.mkdirSync(folder, { recursive: true });

            await Promise.all(Array.from({ length: 20 }, (_, index) =>
                recordExternalMediaOrigins(folder, new Map([[`file-${index}.png`, `https://files.catbox.moe/${index}.png`]]))));

            const manifest = readExternalMediaManifest(folder);
            expect(manifest.size).toBe(20);
            expect(manifest.get('file-7.png')).toBe('https://files.catbox.moe/7.png');
        });

        test('a lorebook export gets the URLs of its author back', async () => {
            routeImages(new Map([['https://files.catbox.moe/scene.png', mockImageResponse(PNG_SCENE)]]));
            const world = {
                name: 'Atlas',
                entries: { 0: { uid: 0, key: ['a'], content: '<img src="https://files.catbox.moe/scene.png">' } },
            };
            const answer = await importWorldInfoFile(JSON.stringify(world), { filename: 'Atlas.json', name: 'Atlas', import_external_media: 'true' });
            expect(answer.status).toBe(200);
            expect(answer.body.data.entries[0].content).toContain('/user/images/Atlas/');

            const response = await fetch(`${baseUrl}/api/worldinfo/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: answer.body.data }),
            });
            expect(response.status).toBe(200);
            const exported = await response.json();
            expect(exported.entries[0].content).toBe('<img src="https://files.catbox.moe/scene.png">');
            expect(answer.body.data.entries[0].content).toContain('/user/images/Atlas/');
        });
    });

    describe('who can turn the import on', () => {
        const SERVER_KEY = 'SILLYTAVERN_ALLOWEXTERNALMEDIAIMPORT';
        const originalServerKey = process.env[SERVER_KEY];
        const card = () => {
            const value = createV2Card();
            value.data.name = 'Switch';
            value.data.first_mes = '![scene](https://files.catbox.moe/scene.png)';
            return value;
        };

        beforeEach(() => {
            delete process.env[SERVER_KEY];
            fetchMock.mockResolvedValue(mockImageResponse(PNG_SCENE));
        });

        afterEach(() => {
            if (originalServerKey === undefined) {
                delete process.env[SERVER_KEY];
            } else {
                process.env[SERVER_KEY] = originalServerKey;
            }
        });

        test.each([
            ['true'],
            ['TRUE'],
            [' 1 '],
        ])('the request field %j turns it on', async (value) => {
            await importCharacterCard(createCardPng(card()), 'png', { import_external_media: value });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        test.each([
            ['false'],
            ['0'],
            ['yes'],
            ['on'],
            [''],
            ['2'],
            ['[true]'],
        ])('the request field %j leaves it off', async (value) => {
            await importCharacterCard(createCardPng(card()), 'png', { import_external_media: value });

            expect(fetchMock).not.toHaveBeenCalled();
        });

        test('a saved setting of the user cannot turn it on without the request field', async () => {
            fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ power_user: { import_external_media: true } }));

            const answer = await importCharacterCard(createCardPng(card()), 'png');

            expect(answer.status).toBe(200);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        test('the field turns it on over a saved setting of off', async () => {
            fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ power_user: { import_external_media: false } }));

            await importCharacterCard(createCardPng(card()), 'png', { import_external_media: 'true' });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        test('the old server config key importExternalMedia cannot turn it on', async () => {
            process.env.SILLYTAVERN_IMPORTEXTERNALMEDIA = 'true';
            try {
                await importCharacterCard(createCardPng(card()), 'png');
            } finally {
                delete process.env.SILLYTAVERN_IMPORTEXTERNALMEDIA;
            }

            expect(fetchMock).not.toHaveBeenCalled();
        });

        test('the server config can forbid it for every user: the import succeeds without downloads and logs one line', async () => {
            process.env[SERVER_KEY] = 'false';

            const cardAnswer = await importCharacterCard(createCardPng(card()), 'png', { import_external_media: 'true' });
            const world = { name: 'Forbidden', entries: { 0: { uid: 0, content: '![a](https://files.catbox.moe/scene.png)' } } };
            const worldAnswer = await importWorldInfoFile(JSON.stringify(world), { filename: 'Forbidden.json', name: 'Forbidden', import_external_media: 'true' });

            expect(cardAnswer.status).toBe(200);
            expect(worldAnswer.status).toBe(200);
            expect(fetchMock).not.toHaveBeenCalled();
            expect(readStoredCard('Switch').first_mes).toBe('![scene](https://files.catbox.moe/scene.png)');
            expect(fs.readdirSync(directories.userImages)).toEqual([]);
            const lines = console.info.mock.calls.concat(console.warn.mock.calls).map(call => call.join(' ')).filter(text => text.includes('forbids'));
            expect(lines).toHaveLength(2);
        });

        test('an existing config.yaml gets the key as allowed, and one that forbids the download keeps its value', async () => {
            const { addMissingConfigValues } = await import('../src/config-init.js');
            const yaml = (await import('yaml')).default;
            const configPath = path.join(tempRoot, 'config.yaml');

            fs.writeFileSync(configPath, 'port: 4444\n');
            addMissingConfigValues(configPath);
            expect(yaml.parse(fs.readFileSync(configPath, 'utf8')).allowExternalMediaImport).toBe(true);

            fs.writeFileSync(configPath, 'allowExternalMediaImport: false\n');
            addMissingConfigValues(configPath);
            expect(yaml.parse(fs.readFileSync(configPath, 'utf8')).allowExternalMediaImport).toBe(false);
        });

        test('the server config does not log a line for an import that did not ask for the download', async () => {
            process.env[SERVER_KEY] = 'false';

            await importCharacterCard(createCardPng(card()), 'png', { import_external_media: 'false' });

            const lines = console.info.mock.calls.concat(console.warn.mock.calls).map(call => call.join(' ')).filter(text => text.includes('forbids'));
            expect(lines).toEqual([]);
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

            const expectedUrl = `/user/images/${encodeURIComponent('Eldoria Atlas')}/scene-${hash16(PNG_SCENE)}.png`;
            expect(answer.status).toBe(200);
            expect(answer.body.name).toBe('Eldoria Atlas');
            expect(answer.body.data.description).toBe(`Map: ![map](${expectedUrl})`);
            expect(answer.body.data.entries[0].content).toBe(`<img src="${expectedUrl}">`);
            expect(answer.body.data.originalData.entries[0].content).toBe(`<img src="${expectedUrl}">`);

            const persisted = JSON.parse(fs.readFileSync(path.join(directories.worlds, 'Eldoria Atlas.json'), 'utf8'));
            expect(persisted.entries[0].content).toBe(`<img src="${expectedUrl}">`);
            expect(persisted.originalData.entries[0].content).toBe(`<img src="${expectedUrl}">`);
            expect(
                fs.readFileSync(path.join(directories.userImages, 'Eldoria Atlas', `scene-${hash16(PNG_SCENE)}.png`)).equals(PNG_SCENE),
            ).toBe(true);
        });
    });

    describe('security, SSRF, file-type validation, and fail-open resilience', () => {
        const importRequest = () => ({ body: { import_external_media: 'true' }, user: { directories } });
        const cardWith = (name, description) => ({ name, description, data: { name, description } });

        test('a card name with a quote or a parenthesis gives a stored URL that no context ends early', async () => {
            const name = 'D\'Artagnan (alt)!';
            const card = cardWith(name, '![scene](https://files.catbox.moe/scene.png)');
            const fetchImpl = jest.fn(async () => mockImageResponse(PNG_SCENE));

            const result = await localizeCharacterExternalMedia(card, { request: importRequest(), fileName: 'card', fetchImpl });

            const fileName = `scene-${hash16(PNG_SCENE)}.png`;
            expect(result).toEqual({ changed: true, downloaded: 1 });
            expect(card.data.description).toBe(`![scene](/user/images/D%27Artagnan%20%28alt%29%21/${fileName})`);
            expect(fs.readFileSync(path.join(directories.userImages, name, fileName)).equals(PNG_SCENE)).toBe(true);
        });

        test('a card name with a percent sign keeps its remote URLs, because the static route cannot serve that folder', async () => {
            const card = cardWith('100% Wolf', '![scene](https://files.catbox.moe/scene.png)');
            const fetchImpl = jest.fn(async () => mockImageResponse(PNG_SCENE));

            const result = await localizeCharacterExternalMedia(card, { request: importRequest(), fileName: '100% Wolf', fetchImpl });

            expect(result).toEqual({ changed: false, downloaded: 0 });
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(card.data.description).toBe('![scene](https://files.catbox.moe/scene.png)');
            expect(fs.readdirSync(directories.userImages)).toEqual([]);
        });

        test('a log line escapes control characters and direction marks from the card and from the host', async () => {
            const card = cardWith('Logger', '![scene](https://files.catbox.moe/a\u009b31mb\u202e.png)');
            const fetchImpl = jest.fn(async () => {
                throw new Error('refused\u001b[2J\u009d0;title');
            });

            await localizeCharacterExternalMedia(card, { request: importRequest(), fileName: 'Logger', fetchImpl });

            const line = console.warn.mock.calls.map(call => call.join(' ')).find(text => text.includes('External media import failed'));
            expect(line).toContain('\\u009b31mb\\u202e.png');
            expect(line).toContain('refused\\u001b[2J\\u009d0;title');
            expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
        });

        describe('a stored file name that is already taken', () => {
            const fileName = () => `scene-${hash16(PNG_SCENE)}.png`;

            test('names the file with 16 hex digits of the hash', async () => {
                const card = cardWith('Digits', '![scene](https://files.catbox.moe/scene.png)');

                await localizeCharacterExternalMedia(card, { request: importRequest(), fileName: 'Digits', fetchImpl: jest.fn(async () => mockImageResponse(PNG_SCENE)) });

                const stored = fs.readdirSync(path.join(directories.userImages, 'Digits')).filter(name => !name.startsWith('.'));
                expect(stored).toEqual([fileName()]);
                expect(stored[0]).toMatch(/^scene-[0-9a-f]{16}\.png$/);
            });

            test('never replaces a file that has other content, keeps the URL remote and logs one line', async () => {
                const folder = path.join(directories.userImages, 'Clash');
                fs.mkdirSync(folder, { recursive: true });
                fs.writeFileSync(path.join(folder, fileName()), 'USER-OWNED-FILE');
                const card = cardWith('Clash', '![scene](https://files.catbox.moe/scene.png)');

                const result = await localizeCharacterExternalMedia(card, { request: importRequest(), fileName: 'Clash', fetchImpl: jest.fn(async () => mockImageResponse(PNG_SCENE)) });

                expect(result).toEqual({ changed: false, downloaded: 0 });
                expect(card.data.description).toBe('![scene](https://files.catbox.moe/scene.png)');
                expect(fs.readFileSync(path.join(folder, fileName()), 'utf8')).toBe('USER-OWNED-FILE');
                expect(fs.readdirSync(folder)).toEqual([fileName()]);
                const lines = console.warn.mock.calls.map(call => call.join(' ')).filter(text => text.includes(fileName()));
                expect(lines).toHaveLength(1);
            });

            test('reuses a file that has the same content and lists it in the manifest', async () => {
                const folder = path.join(directories.userImages, 'Again');
                fs.mkdirSync(folder, { recursive: true });
                fs.writeFileSync(path.join(folder, fileName()), PNG_SCENE);
                const before = fs.statSync(path.join(folder, fileName()));
                const card = cardWith('Again', '![scene](https://files.catbox.moe/scene.png)');

                const result = await localizeCharacterExternalMedia(card, { request: importRequest(), fileName: 'Again', fetchImpl: jest.fn(async () => mockImageResponse(PNG_SCENE)) });

                expect(result).toEqual({ changed: true, downloaded: 1 });
                expect(card.data.description).toBe(`![scene](/user/images/Again/${fileName()})`);
                expect(fs.statSync(path.join(folder, fileName())).ino).toBe(before.ino);
                expect(JSON.parse(fs.readFileSync(path.join(folder, '.external-media.json'), 'utf8'))).toEqual({
                    [fileName()]: { url: 'https://files.catbox.moe/scene.png' },
                });
            });

            test.each([
                ['stores the file', null, true],
                ['still keeps a file that has other content', 'USER-OWNED-FILE', false],
            ])('on a file system without hard links %s', async (_label, existing, stored) => {
                const linkSpy = jest.spyOn(fsPromises, 'link').mockRejectedValue(Object.assign(new Error('not permitted'), { code: 'EPERM' }));
                const folder = path.join(directories.userImages, 'NoLinks');
                fs.mkdirSync(folder, { recursive: true });
                if (existing) {
                    fs.writeFileSync(path.join(folder, fileName()), existing);
                }
                const card = cardWith('NoLinks', '![scene](https://files.catbox.moe/scene.png)');

                const result = await localizeCharacterExternalMedia(card, { request: importRequest(), fileName: 'NoLinks', fetchImpl: jest.fn(async () => mockImageResponse(PNG_SCENE)) });

                expect(linkSpy).toHaveBeenCalled();
                expect(result.downloaded).toBe(stored ? 1 : 0);
                expect(fs.readFileSync(path.join(folder, fileName())).equals(stored ? PNG_SCENE : Buffer.from(existing))).toBe(true);
                expect(fs.readdirSync(folder).filter(name => name.endsWith('.tmp'))).toEqual([]);
            });

            test('leaves no temporary file in the folder', async () => {
                const card = cardWith('Tidy', '![scene](https://files.catbox.moe/scene.png)');

                await localizeCharacterExternalMedia(card, { request: importRequest(), fileName: 'Tidy', fetchImpl: jest.fn(async () => mockImageResponse(PNG_SCENE)) });

                expect(fs.readdirSync(path.join(directories.userImages, 'Tidy')).sort()).toEqual(['.external-media.json', fileName()]);
            });
        });

        describe('the budget of one import', () => {
            const cardWithImages = (name, count) => cardWith(name, Array.from({ length: count }, (_, index) => `![i${index}](https://files.catbox.moe/${index}.png)`).join('\n'));
            const localImages = card => (card.data.description.match(/\/user\/images\//g) ?? []).length;
            const budgetLines = () => console.warn.mock.calls.map(call => call.join(' ')).filter(text => text.includes('limit for one import'));

            test('stops downloading when the total bytes are used up, keeps the other URLs remote and still succeeds', async () => {
                const card = cardWithImages('Bytes', 6);
                const fetchImpl = jest.fn(async () => mockImageResponse(PNG_SCENE));

                const result = await localizeCharacterExternalMedia(card, {
                    request: importRequest(),
                    fileName: 'Bytes',
                    fetchImpl,
                    maxBytes: PNG_SCENE.length + 5,
                    totalMaxBytes: PNG_SCENE.length * 2 + 10,
                });

                expect(result.downloaded).toBeLessThanOrEqual(2);
                expect(result.downloaded).toBeGreaterThanOrEqual(1);
                expect(localImages(card)).toBe(result.downloaded);
                expect(card.data.description).toContain('https://files.catbox.moe/5.png');
                expect(fetchImpl.mock.calls.length).toBeLessThan(6);
                expect(budgetLines()).toHaveLength(1);
            });

            test('a response that is larger than what is left of the budget stays remote', async () => {
                const card = cardWithImages('Left', 2);
                const fetchImpl = jest.fn(async url => mockImageResponse(String(url).endsWith('/0.png') ? PNG_SCENE : PNG_ALT));

                const result = await localizeCharacterExternalMedia(card, {
                    request: importRequest(),
                    fileName: 'Left',
                    fetchImpl,
                    maxBytes: PNG_SCENE.length + 5,
                    totalMaxBytes: PNG_SCENE.length + 20,
                });

                expect(result.downloaded).toBe(1);
                expect(card.data.description).toContain('/user/images/Left/0-');
                expect(card.data.description).toContain('https://files.catbox.moe/1.png');
            });

            test('stops when the total time is used up, aborts the requests that wait and still succeeds', async () => {
                const card = cardWithImages('Time', 6);
                const fetchImpl = jest.fn(async (url, { signal }) => {
                    if (String(url).endsWith('/0.png')) {
                        return mockImageResponse(PNG_SCENE);
                    }
                    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
                });

                const startedAt = performance.now();
                const result = await localizeCharacterExternalMedia(card, {
                    request: importRequest(),
                    fileName: 'Time',
                    fetchImpl,
                    timeoutMs: 30_000,
                    totalTimeoutMs: 250,
                });

                expect(performance.now() - startedAt).toBeLessThan(5000);
                expect(result.downloaded).toBe(1);
                expect(localImages(card)).toBe(1);
                expect(fetchImpl).toHaveBeenCalledTimes(4);
                expect(card.data.description).toContain('https://files.catbox.moe/5.png');
                expect(budgetLines()).toHaveLength(1);
            });

            test('a card within the budget logs no budget line', async () => {
                const card = cardWithImages('Fine', 2);

                await localizeCharacterExternalMedia(card, { request: importRequest(), fileName: 'Fine', fetchImpl: jest.fn(async () => mockImageResponse(PNG_SCENE)) });

                expect(budgetLines()).toEqual([]);
            });
        });

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

            const expectedValid = `/user/images/character/valid-${hash16(PNG_SCENE)}.png`;
            const saved = readStoredCard('character');
            expect(saved.first_mes).toBe([
                '![local](http://127.0.0.1/private.png)',
                '![redir](https://files.catbox.moe/redirect-to-local.png)',
                '![html](https://files.catbox.moe/disguised-html.png)',
                '![svg](https://files.catbox.moe/disguised-svg.png)',
                '![missing](https://files.catbox.moe/missing.png)',
                `![valid](${expectedValid})`,
            ].join('\n'));
            expect(fs.readdirSync(path.join(directories.userImages, 'character')).sort()).toEqual([
                '.external-media.json',
                `valid-${hash16(PNG_SCENE)}.png`,
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
