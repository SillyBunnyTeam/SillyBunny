/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultConfigPath = path.join(repoRoot, 'default', 'config.yaml');
const defaultConfig = parse(fs.readFileSync(defaultConfigPath, 'utf8'));
const scriptSource = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const pub = relative => fileURLToPath(new URL(`../public/${relative}`, import.meta.url));
const src = relative => fileURLToPath(new URL(`../src/${relative}`, import.meta.url));

setConfigFilePath(defaultConfigPath);

function sourceBetween(source, start, end) {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex);
}

async function fetchThumbnailAdminConfig() {
    jest.resetModules();
    const previousCliArgs = globalThis.COMMAND_LINE_ARGS;
    globalThis.COMMAND_LINE_ARGS = { configPath: defaultConfigPath };
    const { setConfigFilePath: setFreshConfig } = await import('../src/util.js');
    setFreshConfig(defaultConfigPath);
    await jest.unstable_mockModule(src('shutdown.js'), () => ({ requestGracefulExit: jest.fn() }));
    const { router: serverAdminRouter } = await import('../src/endpoints/server-admin.js');

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { admin: true }, directories: {} };
        next();
    });
    app.use('/api/server-admin', serverAdminRouter);

    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/server-admin/config/thumbnail-settings/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(response.status).toBe(200);
        return await response.json();
    } finally {
        globalThis.COMMAND_LINE_ARGS = previousCliArgs;
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

describe('Android avatar resource budget', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('chat message avatar images are viewport-aware and preserve originals for zoom', () => {
        expect(scriptSource).toContain('const viewportAvatarImg = isMobile() ? mobileAvatarImg : originalAvatarImg;');
        expect(scriptSource).toContain('const viewportThumbnailSrc = isMobile() ? mobileAvatarImg : avatarImg;');

        const avatarImageAttrs = sourceBetween(
            scriptSource,
            'messageElement.find(\'.avatar img\').attr({',
            'messageElement.find(\'.ch_name .name_text\').text(mes.name);',
        );

        expect(avatarImageAttrs).toContain('src: viewportAvatarImg');
        expect(avatarImageAttrs).toContain('\'data-thumbnail-src\': viewportThumbnailSrc');
        expect(avatarImageAttrs).toContain('\'data-original-src\': originalAvatarImg');
        expect(avatarImageAttrs).not.toContain('src: avatarImg');
        expect(avatarImageAttrs).not.toContain('src: originalAvatarImg');

        const zoomClickHandler = sourceBetween(
            scriptSource,
            '$(document).on(\'click\', \'.mes .avatar\', function () {',
            'document.addEventListener(\'click\', function (e) {',
        );

        expect(zoomClickHandler).toContain('const originalAvatarURL = avatarImage.attr(\'data-original-src\');');
        expect(zoomClickHandler).toContain('const fullAvatarURL = originalAvatarURL || avatarImage.attr(\'src\');');
        expect(zoomClickHandler).toContain('avatarImage.attr(\'data-thumbnail-src\') || avatarImage.attr(\'src\') || fullAvatarURL');
        expect(zoomClickHandler).toContain('originalAvatarURL || avatarSource?.original || getUserAvatar(targetAvatarImg)');
        // The handler only reads which picture the message shows; the viewer owns the window, which conversation mode shares.
        expect(zoomClickHandler).toContain('import(\'./scripts/sillybunny-avatar-viewer.js\')');
        expect(zoomClickHandler).toContain('toggleZoomedAvatar({ file: targetAvatarImg, src: zoomedSrc })');
        expect(zoomClickHandler).not.toContain('#zoomed_avatar_template');
    });

    test('avatar refresh cache busts both desktop and mobile thumbnail sources', () => {
        const refreshSource = sourceBetween(
            scriptSource,
            'export async function refreshCharacterAvatar(avatarKey) {',
            'export function buildAvatarList(',
        );

        expect(refreshSource).toContain('getMobileThumbnailUrl(\'avatar\', avatarKey)');
        expect(refreshSource).toContain('img.getAttribute(\'data-original-src\')');
        expect(refreshSource).toContain('img.setAttribute(\'data-original-src\', cacheBustedFullAvatarUrl);');
        expect(refreshSource).toContain('thumbnailAvatar?.preset === \'mobile\'');
        expect(refreshSource).toContain('img.setAttribute(\'src\', cacheBustedMobileThumbnailUrl);');
        expect(refreshSource).toContain('img.setAttribute(\'src\', cacheBustedThumbnailUrl);');
    });

    test('desktop thumbnail defaults remain high quality', async () => {
        expect(defaultConfig.thumbnails.format).toBe('png');
        expect(defaultConfig.thumbnails.quality).toBe(100);
        expect(defaultConfig.thumbnails.dimensions.avatar).toEqual([864, 1280]);
        expect(defaultConfig.thumbnails.dimensions.persona).toEqual([864, 1280]);

        const { getThumbnailDimensions } = await import('../src/endpoints/image-metadata.js');
        expect(getThumbnailDimensions().avatar).toEqual([864, 1280]);
        expect(getThumbnailDimensions().persona).toEqual([864, 1280]);

        const adminPayload = await fetchThumbnailAdminConfig();
        expect(adminPayload.recommended.format).toBe('png');
        expect(adminPayload.recommended.quality).toBe(100);
        expect(adminPayload.recommended.dimensions.avatar).toEqual([864, 1280]);
        expect(adminPayload.recommended.dimensions.persona).toEqual([864, 1280]);
    });

    test('mobile thumbnail defaults are kept for Android bandwidth/CPU savings', async () => {
        expect(defaultConfig.thumbnails.mobile.format).toBe('jpg');
        expect(defaultConfig.thumbnails.mobile.quality).toBeLessThanOrEqual(82);
        expect(defaultConfig.thumbnails.mobile.dimensions.avatar).toEqual([320, 480]);
        expect(defaultConfig.thumbnails.mobile.dimensions.persona).toEqual([320, 480]);

        const { getThumbnailMobileDimensions } = await import('../src/endpoints/image-metadata.js');
        expect(getThumbnailMobileDimensions().avatar).toEqual([320, 480]);
        expect(getThumbnailMobileDimensions().persona).toEqual([320, 480]);

        const adminPayload = await fetchThumbnailAdminConfig();
        expect(adminPayload.recommendedMobile.format).toBe('jpg');
        expect(adminPayload.recommendedMobile.quality).toBe(82);
        expect(adminPayload.recommendedMobile.dimensions.avatar).toEqual([320, 480]);
        expect(adminPayload.recommendedMobile.dimensions.persona).toEqual([320, 480]);

        const dom = new JSDOM('<!doctype html><html><body></body></html>');
        const previous = {
            window: globalThis.window,
            document: globalThis.document,
            HTMLElement: globalThis.HTMLElement,
            HTMLInputElement: globalThis.HTMLInputElement,
            HTMLSelectElement: globalThis.HTMLSelectElement,
            HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
            Node: globalThis.Node,
        };
        Object.assign(globalThis, {
            window: dom.window,
            document: dom.window.document,
            HTMLElement: dom.window.HTMLElement,
            HTMLInputElement: dom.window.HTMLInputElement,
            HTMLSelectElement: dom.window.HTMLSelectElement,
            HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
            Node: dom.window.Node,
        });
        try {
            jest.resetModules();
            await jest.unstable_mockModule(pub('lib.js'), () => ({ yaml: { parse: jest.fn() } }));
            await jest.unstable_mockModule(pub('scripts/sillybunny-editor/dialog.js'), () => ({ openAlert: jest.fn() }));
            await jest.unstable_mockModule(pub('scripts/sillybunny-editor/list-shell.js'), () => ({ loadListEditorStyles: jest.fn() }));
            await jest.unstable_mockModule(pub('scripts/sillybunny-editor/select-row.js'), () => ({
                createSelectRow: ({ select }) => ({ row: select, setDisabled: jest.fn(), sync: jest.fn() }),
            }));
            await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
                t: (strings, ...values) => strings.reduce((out, part, idx) => out + part + (values[idx] ?? ''), ''),
            }));

            const { createServerTools } = await import('../public/scripts/sillybunny-server-tools.js');
            const tools = createServerTools({
                createElement: (tag, { className = '', text = '', attrs = {} } = {}) => {
                    const el = document.createElement(tag);
                    if (className) el.className = className;
                    if (text) el.textContent = text;
                    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
                    return el;
                },
                createShellPanel: () => {
                    const panel = document.createElement('div');
                    const scroller = document.createElement('div');
                    panel.appendChild(scroller);
                    return { panel, scroller };
                },
                hasServerReturnedAfterRestart: () => false,
                isShellOpen: () => true,
                isShellTabOpen: () => true,
                setButtonDisabled: jest.fn(),
                setServerAdminMessage: jest.fn(),
                setServerAdminPill: jest.fn(),
                wait: async () => {},
                waitForAuthorizedRequestHeaders: async () => ({}),
            });

            const { panel } = tools.buildServerAdminPanel();
            expect(panel.textContent).toContain('Mobile Preset');
            expect(panel.textContent).toContain('Enable the mobile preset to serve smaller JPG thumbnails to phone-sized screens');
        } finally {
            dom.window.close();
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        }
    });

    test('client exposes a viewport-aware thumbnail URL helper', () => {
        expect(scriptSource).toContain('export function getMobileThumbnailUrl(type, file, t = false)');
        expect(scriptSource).toContain('export function getThumbnailUrlForViewport(type, file, t = false)');
        expect(scriptSource).toContain('return isMobile() ? getMobileThumbnailUrl(type, file, t) : getThumbnailUrl(type, file, t);');
    });

    test('cached thumbnails report their encoded image type instead of original filename extension', async () => {
        jest.resetModules();
        const { setConfigFilePath: setFreshConfig } = await import('../src/util.js');
        setFreshConfig(defaultConfigPath);
        const { publicRouter } = await import('../src/endpoints/thumbnails.js');

        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-thumb-mime-'));
        const directories = {
            characters: path.join(tempRoot, 'characters'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar-mobile'),
        };
        for (const dir of Object.values(directories)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write a JPEG-encoded cached thumbnail under a .png name and a PNG-encoded one under a .jpg name.
        const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
        fs.writeFileSync(path.join(directories.characters, 'avatar.png'), pngBytes);
        fs.writeFileSync(path.join(directories.thumbnailsAvatarMobile, 'avatar.png'), jpegBytes);
        fs.writeFileSync(path.join(directories.characters, 'avatar.jpg'), jpegBytes);
        fs.writeFileSync(path.join(directories.thumbnailsAvatar, 'avatar.jpg'), pngBytes);

        const app = express();
        app.use((req, _res, next) => {
            req.user = { directories };
            next();
        });
        app.use('/thumbnail', publicRouter);

        const server = await new Promise(resolve => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        const openSyncSpy = jest.spyOn(fs, 'openSync');
        const readSyncSpy = jest.spyOn(fs, 'readSync');
        try {
            const port = server.address().port;
            const mobileResponse = await fetch(`http://127.0.0.1:${port}/thumbnail?type=avatar&file=avatar.png&preset=mobile`);
            expect(mobileResponse.status).toBe(200);
            expect(mobileResponse.headers.get('content-type')).toMatch(/image\/jpeg/i);

            const desktopResponse = await fetch(`http://127.0.0.1:${port}/thumbnail?type=avatar&file=avatar.jpg`);
            expect(desktopResponse.status).toBe(200);
            expect(desktopResponse.headers.get('content-type')).toMatch(/image\/png/i);

            // Header sniffing must stay asynchronous rather than blocking the event loop with sync file descriptors.
            expect(openSyncSpy).not.toHaveBeenCalled();
            expect(readSyncSpy).not.toHaveBeenCalled();
        } finally {
            openSyncSpy.mockRestore();
            readSyncSpy.mockRestore();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
