/* eslint-disable playwright/no-duplicate-hooks, playwright/no-standalone-expect */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import multer from 'multer';

import { createUploadStorage } from '../src/middleware/uploadStorage.js';
import multerMonkeyPatch from '../src/middleware/multerMonkeyPatch.js';
import { setConfigFilePath } from '../src/util.js';

const configPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
setConfigFilePath(configPath);
const { router: themesRouter } = await import('../src/endpoints/themes.js');
const { router: backgroundsRouter } = await import('../src/endpoints/backgrounds.js');
const execFileAsync = promisify(execFile);
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

let baseUrl;
let server;
let directories;
let tempRoot;
let uploads;
let uploadMiddleware;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { directories };
        next();
    });
    app.use((request, response, next) => uploadMiddleware(request, response, next));
    app.use(multerMonkeyPatch);
    app.use('/api/themes', themesRouter);
    app.use('/api/backgrounds', backgroundsRouter);
    app.use((_error, _request, response, _next) => response.sendStatus(500));
    await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-create-only-'));
    directories = {
        root: tempRoot,
        themes: path.join(tempRoot, 'themes'),
        backgrounds: path.join(tempRoot, 'backgrounds'),
        thumbnailsBg: path.join(tempRoot, 'thumbnails', 'bg'),
        thumbnailsBgMobile: path.join(tempRoot, 'thumbnails', 'bg', 'mobile'),
    };
    for (const directory of Object.values(directories)) {
        fs.mkdirSync(directory, { recursive: true });
    }
    uploads = path.join(tempRoot, '_uploads');
    uploadMiddleware = multer({ storage: createUploadStorage(uploads) }).single('avatar');
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

afterAll(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function saveTheme(route, body) {
    return fetch(`${baseUrl}/api/themes${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function uploadBackground(route, name = 'NightSky.gif', content = image) {
    const form = new FormData();
    form.append('avatar', new Blob([content], { type: 'image/gif' }), name);
    return fetch(`${baseUrl}/api/backgrounds${route}`, { method: 'POST', body: form });
}

function seedBackgroundCache() {
    const paths = [
        path.join(directories.thumbnailsBg, 'NightSky.gif'),
        path.join(directories.thumbnailsBgMobile, 'NightSky.gif'),
        path.join(tempRoot, 'image-metadata.json'),
    ];
    const content = JSON.stringify({ version: 1, images: {}, folders: [] });
    for (const file of paths) fs.writeFileSync(file, content);
    return { paths, content };
}

describe('create-only installs', () => {
    test('creates a complete theme with the same JSON and filename sanitisation as save', async () => {
        fs.rmdirSync(directories.themes);
        const theme = { name: 'Night:Sky', custom_css: 'body { color: blue; }', nested: { enabled: true } };
        const response = await saveTheme('/create', theme);

        expect(response.status).toBe(201);
        expect(fs.readdirSync(directories.themes)).toEqual(['NightSky.json']);
        expect(fs.readFileSync(path.join(directories.themes, 'NightSky.json'), 'utf8')).toBe(JSON.stringify(theme, null, 4));
    });

    test('preserves an existing theme byte-for-byte, including a sanitised name collision', async () => {
        const target = path.join(directories.themes, 'NightSky.json');
        const content = '{"name":"NightSky","custom_css":"user edits"}\n';
        fs.writeFileSync(target, content);
        const before = fs.statSync(target);

        const response = await saveTheme('/create', { name: 'Night:Sky', custom_css: 'installer' });

        expect(response.status).toBe(409);
        expect(fs.readFileSync(target, 'utf8')).toBe(content);
        expect(fs.statSync(target).mtimeMs).toBe(before.mtimeMs);
        expect(fs.readdirSync(directories.themes)).toEqual(['NightSky.json']);
    });

    test.each(['/save', '/create'])('%s rejects a missing theme name', async route => {
        expect((await saveTheme(route, {})).status).toBe(400);
        expect((await saveTheme(route, { name: '' })).status).toBe(400);
        expect(fs.readdirSync(directories.themes)).toEqual([]);
    });

    test.each([[], {}, true, false, 0, 42, null, '', ' ', '\t\r\n', '\u00a0'].map(name => [name]))('create rejects name %j without creating files or directories', async name => {
        const mkdirSpy = jest.spyOn(fs, 'mkdirSync');
        const mkdtempSpy = jest.spyOn(fs, 'mkdtempSync');

        expect((await saveTheme('/create', { name })).status).toBe(400);
        expect(fs.readdirSync(directories.themes)).toEqual([]);

        fs.rmdirSync(directories.themes);
        const before = fs.readdirSync(tempRoot);
        expect((await saveTheme('/create', { name })).status).toBe(400);
        expect(fs.existsSync(directories.themes)).toBe(false);
        expect(fs.readdirSync(tempRoot)).toEqual(before);
        expect(mkdirSpy).not.toHaveBeenCalled();
        expect(mkdtempSpy).not.toHaveBeenCalled();
    });

    test('legacy save still overwrites a created theme', async () => {
        await saveTheme('/create', { name: 'NightSky', custom_css: 'installer' });
        const theme = { name: 'NightSky', custom_css: 'edited' };

        expect((await saveTheme('/save', theme)).status).toBe(200);
        expect(JSON.parse(fs.readFileSync(path.join(directories.themes, 'NightSky.json'), 'utf8'))).toEqual(theme);
    });

    test.each(['/save', '/create'])('%s reports storage errors instead of success', async route => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        fs.rmdirSync(directories.themes);
        fs.writeFileSync(directories.themes, 'not a directory');

        expect((await saveTheme(route, { name: 'NightSky' })).status).toBe(500);
        expect(fs.readFileSync(directories.themes, 'utf8')).toBe('not a directory');
    });

    test.each(['writeSync', 'fsyncSync', 'linkSync'])('a theme %s failure leaves no installed record and permits retry', async method => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const failure = Object.assign(new Error('storage failure'), { code: 'EIO' });
        const writeSync = fs.writeSync.bind(fs);
        const spy = jest.spyOn(fs, method);
        if (method === 'writeSync') {
            spy.mockImplementationOnce((fd, buffer, offset, length, position) => writeSync(fd, buffer, offset, Math.min(length, 8), position));
        }
        spy.mockImplementationOnce(() => { throw failure; });

        expect((await saveTheme('/create', { name: 'NightSky' })).status).toBe(500);
        expect(fs.readdirSync(directories.themes)).toEqual([]);
        spy.mockRestore();
        expect((await saveTheme('/create', { name: 'NightSky' })).status).toBe(201);
        expect(JSON.parse(fs.readFileSync(path.join(directories.themes, 'NightSky.json'), 'utf8'))).toEqual({ name: 'NightSky' });
    });

    test('even failed partial-write cleanup cannot expose a broken theme record', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const failure = Object.assign(new Error('storage failure'), { code: 'EIO' });
        const writeSync = fs.writeSync.bind(fs);
        jest.spyOn(fs, 'writeSync')
            .mockImplementationOnce((fd, buffer, offset, length, position) => writeSync(fd, buffer, offset, Math.min(length, 8), position))
            .mockImplementationOnce(() => { throw failure; });
        jest.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw failure; });
        jest.spyOn(fs, 'rmSync').mockImplementation(() => { throw failure; });

        expect((await saveTheme('/create', { name: 'NightSky' })).status).toBe(500);
        expect(fs.existsSync(path.join(directories.themes, 'NightSky.json'))).toBe(false);
        expect(fs.readdirSync(directories.themes).filter(name => name.endsWith('.json'))).toEqual([]);
        jest.restoreAllMocks();
        expect((await saveTheme('/create', { name: 'NightSky' })).status).toBe(201);
    });

    test('creates a background with exact bytes, a sanitised text filename, and metadata', async () => {
        const response = await uploadBackground('/upload-new', 'Night?Sky.gif');

        expect(response.status).toBe(201);
        expect(await response.text()).toBe('NightSky.gif');
        expect(fs.readFileSync(path.join(directories.backgrounds, 'NightSky.gif'))).toEqual(image);
        expect(fs.readdirSync(uploads)).toEqual([]);
        const metadata = JSON.parse(fs.readFileSync(path.join(tempRoot, 'image-metadata.json'), 'utf8'));
        expect(metadata.images['backgrounds/NightSky.gif'].hash).toBe(createHash('sha256').update(image).digest('hex'));
    });

    test.each(['/upload-new', '/UPLOAD-NEW/', '/upload-new?overwrite=true'])('%s preserves existing bytes, thumbnails and metadata and cleans the upload', async route => {
        const target = path.join(directories.backgrounds, 'NightSky.gif');
        fs.writeFileSync(target, image);
        const before = fs.statSync(target);
        const { paths, content } = seedBackgroundCache();

        const response = await uploadBackground(route, 'Night?Sky.gif', Buffer.concat([image, Buffer.from('replacement')]));

        expect(response.status).toBe(409);
        expect(fs.readFileSync(target)).toEqual(image);
        expect(fs.statSync(target).mtimeMs).toBe(before.mtimeMs);
        expect(paths.map(file => fs.readFileSync(file, 'utf8'))).toEqual(paths.map(() => content));
        expect(fs.readdirSync(uploads)).toEqual([]);
    });

    test('legacy upload still overwrites, invalidates thumbnails and updates metadata', async () => {
        fs.writeFileSync(path.join(directories.backgrounds, 'NightSky.gif'), 'previous content');
        const { paths } = seedBackgroundCache();

        const response = await uploadBackground('/upload');

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('NightSky.gif');
        expect(fs.readFileSync(path.join(directories.backgrounds, 'NightSky.gif'))).toEqual(image);
        expect(paths.slice(0, 2).map(file => fs.existsSync(file))).toEqual([false, false]);
        const metadata = JSON.parse(fs.readFileSync(paths[2], 'utf8'));
        expect(metadata.images['backgrounds/NightSky.gif'].hash).toBe(createHash('sha256').update(image).digest('hex'));
        expect(fs.readdirSync(uploads)).toEqual([]);
    });

    test.each(['/upload', '/upload-new'])('%s reports copy errors, cleans the upload and skips cache changes', async route => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {
            throw Object.assign(new Error('copy failed'), { code: 'EACCES' });
        });
        const { paths, content } = seedBackgroundCache();

        expect((await uploadBackground(route)).status).toBe(500);
        expect(fs.readdirSync(directories.backgrounds)).toEqual([]);
        expect(fs.readdirSync(uploads)).toEqual([]);
        expect(paths.map(file => fs.readFileSync(file, 'utf8'))).toEqual(paths.map(() => content));
    });

    test.each(['/upload', '/upload-new'])('%s still requires an avatar upload', async route => {
        const response = await fetch(`${baseUrl}/api/backgrounds${route}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });

        expect(response.status).toBe(400);
        expect(fs.readdirSync(uploads)).toEqual([]);
        expect(fs.readdirSync(directories.backgrounds)).toEqual([]);
    });

    test.each(['themes', 'backgrounds'])('%s exclusive creation does not follow an existing symbolic link', async kind => {
        const name = kind === 'themes' ? 'NightSky.json' : 'NightSky.gif';
        const sentinel = path.join(tempRoot, 'sentinel');
        fs.writeFileSync(sentinel, 'preserved');
        fs.symlinkSync(sentinel, path.join(directories[kind], name));

        const response = kind === 'themes'
            ? await saveTheme('/create', { name: 'NightSky' })
            : await uploadBackground('/upload-new');

        expect(response.status).toBe(409);
        expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserved');
        expect(fs.lstatSync(path.join(directories[kind], name)).isSymbolicLink()).toBe(true);
        expect(fs.readdirSync(uploads)).toEqual([]);
    });

    test.each(['themes', 'backgrounds'])('%s has one winner across concurrent processes', async kind => {
        const barrier = path.join(tempRoot, 'barrier');
        fs.mkdirSync(barrier);
        const payloads = [0, 1].map(writer => ({ name: 'NightSky', writer }));
        const images = payloads.map(payload => Buffer.concat([image, Buffer.from(String(payload.writer))]));
        const results = await Promise.all(payloads.map(async (payload, writer) => {
            const filename = `upload-${writer}`;
            if (kind === 'backgrounds') fs.writeFileSync(path.join(uploads, filename), images[writer]);
            const request = {
                body: payload,
                user: { directories },
                file: { destination: uploads, filename, originalname: 'NightSky.gif' },
            };
            const script = `
                import fs from 'node:fs';
                import { setConfigFilePath } from ${JSON.stringify(new URL('../src/util.js', import.meta.url).href)};
                setConfigFilePath(${JSON.stringify(configPath)});
                const { router } = await import(${JSON.stringify(new URL(`../src/endpoints/${kind}.js`, import.meta.url).href)});
                const route = router.stack.find(layer => layer.route?.path === ${JSON.stringify(kind === 'themes' ? '/create' : '/upload-new')});
                fs.writeFileSync(${JSON.stringify(path.join(barrier, String(writer)))}, 'ready');
                while (fs.readdirSync(${JSON.stringify(barrier)}).length < 2) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                const response = {
                    statusCode: 200,
                    status(code) { this.statusCode = code; return this; },
                    sendStatus(code) { return this.status(code); },
                    send(body) { this.body = body; return this; },
                };
                await route.route.stack[0].handle(${JSON.stringify(request)}, response);
                console.log(JSON.stringify(response));
            `;
            const { stdout } = await execFileAsync(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { timeout: 10000 });
            return JSON.parse(stdout.trim());
        }));

        expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
        const winner = results.findIndex(result => result.statusCode === 201);
        const filename = kind === 'themes' ? 'NightSky.json' : 'NightSky.gif';
        const expected = kind === 'themes' ? Buffer.from(JSON.stringify(payloads[winner], null, 4)) : images[winner];
        expect(fs.readdirSync(directories[kind])).toEqual([filename]);
        expect(fs.readFileSync(path.join(directories[kind], filename))).toEqual(expected);
        expect(fs.readdirSync(uploads)).toEqual([]);
    }, 15000);
});
