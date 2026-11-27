/* global globalThis */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
const originalDataRoot = globalThis.DATA_ROOT;
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));
globalThis.DATA_ROOT = path.join(repoRoot, 'data');

const { RACY_WINDOW_MS, createFileStamp, isFileStampCurrent } = await import('../src/file-stamp.js');
const { readAndParseFromDirectory, readPresetsFromDirectory } = await import('../src/endpoints/settings.js');
const { clearWorldInfoCaches, router: worldInfoRouter } = await import('../src/endpoints/worldinfo.js');
const { clearExtensionManifestCache, router: extensionsRouter } = await import('../src/endpoints/extensions.js');
const { readMetadataIndexCached } = await import('../src/endpoints/image-metadata.js');

afterAll(() => {
    globalThis.DATA_ROOT = originalDataRoot;
    process.chdir(originalWorkingDirectory);
});

// A fixed past time in whole seconds, so that restoring it gives the file the very same mtime again.
const OLD_MTIME_SECONDS = 1_700_000_000;
const FUTURE_MTIME_SECONDS = Math.floor(Date.now() / 1000) + 3600;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Waits until a file that was just changed is older than the window in which its timestamps cannot tell writes apart. */
const letFilesSettle = () => sleep(RACY_WINDOW_MS + 20);

function setMtime(file, seconds) {
    fs.utimesSync(file, seconds, seconds);
}

/**
 * Rewrites a file in place with text of the same length and gives it its old mtime back, which is what a write in
 * the same file system clock tick looks like to a cache that compares only (mtime, size).
 */
function rewriteSameSizeKeepingMtime(file, text, seconds = OLD_MTIME_SECONDS) {
    expect(Buffer.byteLength(text)).toBe(fs.statSync(file).size);
    fs.writeFileSync(file, text);
    setMtime(file, seconds);
}

/** Writes a file with an old mtime and waits until a stamp of it is settled. */
async function writeSettled(file, text) {
    fs.writeFileSync(file, text);
    setMtime(file, OLD_MTIME_SECONDS);
    await letFilesSettle();
}

describe('file stamp', () => {
    const baseStats = Object.freeze({
        ino: 7n,
        size: 100n,
        mtimeNs: 1_700_000_000_000_000_000n,
        ctimeNs: 1_700_000_001_000_000_000n,
    });
    const settledAt = Number(baseStats.ctimeNs / 1_000_000n) + RACY_WINDOW_MS + 1;

    test('a stamp is settled only when the newest timestamp is older than the racy window', () => {
        const ctimeMs = Number(baseStats.ctimeNs / 1_000_000n);
        expect(createFileStamp(baseStats, ctimeMs + RACY_WINDOW_MS + 1).settled).toBe(true);
        expect(createFileStamp(baseStats, ctimeMs + RACY_WINDOW_MS).settled).toBe(false);
        expect(createFileStamp(baseStats, ctimeMs).settled).toBe(false);
        expect(createFileStamp(baseStats, ctimeMs - 1_000).settled).toBe(false);
    });

    test('the newer of mtime and ctime decides, so a restored mtime does not make a fresh write look old', () => {
        const restoredMtime = { ...baseStats, mtimeNs: 1_000_000_000_000_000n };
        const nowMs = Number(baseStats.ctimeNs / 1_000_000n) + 5;
        expect(createFileStamp(restoredMtime, nowMs).settled).toBe(false);
    });

    test('a stored stamp is current only for an identical settled stamp', () => {
        const stored = createFileStamp(baseStats, settledAt);
        expect(isFileStampCurrent(stored, createFileStamp(baseStats, settledAt))).toBe(true);
        expect(isFileStampCurrent(stored, createFileStamp({ ...baseStats, ino: 8n }, settledAt))).toBe(false);
        expect(isFileStampCurrent(stored, createFileStamp({ ...baseStats, size: 101n }, settledAt))).toBe(false);
        expect(isFileStampCurrent(stored, createFileStamp({ ...baseStats, mtimeNs: baseStats.mtimeNs + 1n }, settledAt))).toBe(false);
        expect(isFileStampCurrent(stored, createFileStamp({ ...baseStats, ctimeNs: baseStats.ctimeNs + 1n }, settledAt))).toBe(false);
        expect(isFileStampCurrent(undefined, stored)).toBe(false);
    });

    test('a stamp that is not settled never counts as current, even for identical timestamps', () => {
        const unsettled = createFileStamp(baseStats, Number(baseStats.ctimeNs / 1_000_000n) + 1);
        expect(unsettled.settled).toBe(false);
        expect(isFileStampCurrent(unsettled, createFileStamp(baseStats, settledAt))).toBe(false);
    });

    test('the nanosecond part of a timestamp is kept, which a millisecond float loses', () => {
        const a = createFileStamp({ ...baseStats, ctimeNs: baseStats.ctimeNs + 1n }, settledAt);
        const b = createFileStamp(baseStats, settledAt);
        expect(Number(a.ctimeNs) / 1e6).toBe(Number(b.ctimeNs) / 1e6);
        expect(isFileStampCurrent(a, b)).toBe(false);
    });
});

describe('preset and theme directory cache (settings.js)', () => {
    let directory;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stamp-settings-'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('serves an unchanged, settled file from the cache', async () => {
        await writeSettled(path.join(directory, 'a.json'), '{"value":"1111"}');
        expect(readAndParseFromDirectory(directory)).toEqual([{ value: '1111' }]);

        const readSpy = jest.spyOn(fs, 'readFileSync');
        expect(readAndParseFromDirectory(directory)).toEqual([{ value: '1111' }]);
        expect(readSpy).not.toHaveBeenCalled();
    });

    test('reads a same-size rewrite that keeps the old mtime', async () => {
        const file = path.join(directory, 'a.json');
        await writeSettled(file, '{"value":"1111"}');
        expect(readAndParseFromDirectory(directory)).toEqual([{ value: '1111' }]);

        rewriteSameSizeKeepingMtime(file, '{"value":"2222"}');
        expect(readAndParseFromDirectory(directory)).toEqual([{ value: '2222' }]);
    });

    test('reads a file that was replaced by a rename of another file of the same size and mtime', async () => {
        const file = path.join(directory, 'a.json');
        await writeSettled(file, '{"value":"1111"}');
        expect(readPresetsFromDirectory(directory).fileContents).toEqual(['{"value":"1111"}']);

        const replacement = path.join(directory, 'replacement.tmp');
        fs.writeFileSync(replacement, '{"value":"2222"}');
        setMtime(replacement, OLD_MTIME_SECONDS);
        fs.renameSync(replacement, file);
        expect(readPresetsFromDirectory(directory).fileContents).toEqual(['{"value":"2222"}']);
    });

    test('re-reads a file whose timestamps are too new to prove it unchanged', () => {
        const file = path.join(directory, 'a.json');
        fs.writeFileSync(file, '{"value":"1111"}');
        setMtime(file, FUTURE_MTIME_SECONDS);
        expect(readAndParseFromDirectory(directory)).toEqual([{ value: '1111' }]);

        const readSpy = jest.spyOn(fs, 'readFileSync');
        expect(readAndParseFromDirectory(directory)).toEqual([{ value: '1111' }]);
        expect(readSpy).toHaveBeenCalledTimes(1);
    });
});

describe('World Info list cache (worldinfo.js)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl = '';
    let worlds;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'stamp-test-user' }, directories: { worlds } };
            next();
        });
        app.use('/api/worldinfo', worldInfoRouter);
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        clearWorldInfoCaches();
        worlds = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stamp-worlds-'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(worlds, { recursive: true, force: true });
    });

    afterAll(async () => {
        server?.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    });

    const list = async () => (await fetch(`${baseUrl}/api/worldinfo/list`, { method: 'POST' })).json();

    test('lists the new name after a same-size rewrite that keeps the old mtime', async () => {
        const file = path.join(worlds, 'Book.json');
        await writeSettled(file, '{"name":"AAAA","extensions":{},"entries":{}}');
        expect(await list()).toEqual([{ file_id: 'Book', name: 'AAAA', extensions: {} }]);

        rewriteSameSizeKeepingMtime(file, '{"name":"BBBB","extensions":{},"entries":{}}');
        expect(await list()).toEqual([{ file_id: 'Book', name: 'BBBB', extensions: {} }]);
    });

    test('serves an unchanged, settled file from the cache', async () => {
        await writeSettled(path.join(worlds, 'Book.json'), '{"name":"AAAA","extensions":{},"entries":{}}');
        await list();

        const readSpy = jest.spyOn(fs.promises, 'readFile');
        expect(await list()).toEqual([{ file_id: 'Book', name: 'AAAA', extensions: {} }]);
        expect(readSpy).not.toHaveBeenCalled();
    });

    test('answers 500 for a book that became invalid JSON in a same-size rewrite that keeps the old mtime', async () => {
        const file = path.join(worlds, 'Book.json');
        await writeSettled(file, '{"name":"AAAA","extensions":{},"entries":{}}');
        const get = () => fetch(`${baseUrl}/api/worldinfo/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Book' }),
        });
        expect((await get()).status).toBe(200);
        expect((await get()).status).toBe(200);

        jest.spyOn(console, 'error').mockImplementation(() => { });
        rewriteSameSizeKeepingMtime(file, '{"name":"AAAA","extensions":{},"entries":{  ');
        expect((await get()).status).toBe(500);
    });
});

describe('image metadata index cache (image-metadata.js)', () => {
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stamp-metadata-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const indexWith = id => JSON.stringify({ version: 1, images: {}, folders: [{ id, name: 'N', thumbnailFile: '' }] });

    test('reads the new index after a same-size rewrite that keeps the old mtime', async () => {
        const file = path.join(root, 'image-metadata.json');
        await writeSettled(file, indexWith('aaaa'));
        expect((await readMetadataIndexCached(root)).folders[0].id).toBe('aaaa');

        rewriteSameSizeKeepingMtime(file, indexWith('bbbb'));
        expect((await readMetadataIndexCached(root)).folders[0].id).toBe('bbbb');
    });

    test('serves an unchanged, settled index from the cache', async () => {
        await writeSettled(path.join(root, 'image-metadata.json'), indexWith('aaaa'));
        const first = await readMetadataIndexCached(root);
        expect(await readMetadataIndexCached(root)).toBe(first);
    });
});

describe('extension manifest cache (extensions.js)', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl = '';
    let extensionsDirectory;

    beforeAll(async () => {
        const app = express();
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'stamp-test-user', admin: true }, directories: { extensions: extensionsDirectory } };
            next();
        });
        app.use('/api/extensions', extensionsRouter);
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        clearExtensionManifestCache();
        extensionsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stamp-extensions-'));
    });

    afterEach(() => {
        fs.rmSync(extensionsDirectory, { recursive: true, force: true });
    });

    afterAll(async () => {
        server?.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    });

    test('discover returns the new manifest after a same-size rewrite that keeps the old mtime', async () => {
        fs.mkdirSync(path.join(extensionsDirectory, 'Ext'));
        const manifestPath = path.join(extensionsDirectory, 'Ext', 'manifest.json');
        await writeSettled(manifestPath, '{"display_name":"AAAA"}');
        const discover = async () => (await (await fetch(`${baseUrl}/api/extensions/discover?manifests=1`)).json())
            .find(item => item.name === 'third-party/Ext')?.manifest;
        expect(await discover()).toEqual({ display_name: 'AAAA' });

        rewriteSameSizeKeepingMtime(manifestPath, '{"display_name":"BBBB"}');
        expect(await discover()).toEqual({ display_name: 'BBBB' });
    });
});
