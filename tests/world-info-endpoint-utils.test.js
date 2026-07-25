import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUploadStorage } from '../src/middleware/uploadStorage.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { getWorldInfoFilename, getWorldInfoName, isValidWorldInfoData, router } = await import('../src/endpoints/worldinfo.js');

describe('World Info endpoint helpers', () => {
    test('canonicalizes names the same way for reads and writes', () => {
        expect(getWorldInfoFilename('A/B')).toBe('AB.json');
        expect(getWorldInfoName('A/B')).toBe('AB');
    });

    test('rejects names that sanitize to an empty stem', () => {
        expect(getWorldInfoFilename('/')).toBe('');
        expect(getWorldInfoName('CON')).toBe('');
    });

    test('reserves filename bytes for the JSON extension', () => {
        const filename = getWorldInfoFilename('a'.repeat(255));
        expect(filename.endsWith('.json')).toBe(true);
        expect(Buffer.byteLength(filename) + 16).toBeLessThanOrEqual(255);
        expect(getWorldInfoName('a'.repeat(255))).toHaveLength(234);
    });

    test('accepts native entry objects', () => {
        expect(isValidWorldInfoData({ entries: {} })).toBe(true);
        expect(isValidWorldInfoData({ entries: { 0: { uid: 0, content: '' } } })).toBe(true);
    });

    test('rejects malformed entry containers and values', () => {
        expect(isValidWorldInfoData({ entries: null })).toBe(false);
        expect(isValidWorldInfoData({ entries: [] })).toBe(false);
        expect(isValidWorldInfoData({ entries: { 0: null } })).toBe(false);
        expect(isValidWorldInfoData({ entries: { 0: 'bad' } })).toBe(false);
    });
});

describe('World Info endpoints', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;
    let uploadsPath;

    beforeAll(async () => {
        uploadsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-world-info-uploads-'));
        const app = express();
        app.use(express.json());
        app.use(multer({ storage: createUploadStorage(uploadsPath) }).single('avatar'));
        app.use((request, _response, next) => {
            request.user = { directories };
            next();
        });
        app.use('/api/worldinfo', router);
        await new Promise(resolve => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-world-info-endpoints-'));
        directories = { worlds: path.join(tempRoot, 'worlds') };
        fs.mkdirSync(directories.worlds, { recursive: true });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        fs.rmSync(uploadsPath, { recursive: true, force: true });
    });

    test('rejects empty canonical edit names without creating a file', async () => {
        const response = await postJson('/api/worldinfo/edit', { name: '/', data: { entries: {} } });
        expect(response.status).toBe(400);
        expect(fs.readdirSync(directories.worlds)).toEqual([]);
    });

    test('keeps maximum-length edit names discoverable as JSON files', async () => {
        const response = await postJson('/api/worldinfo/edit', { name: 'a'.repeat(255), data: { entries: {} } });
        expect(response.status).toBe(200);
        const [filename] = fs.readdirSync(directories.worlds);
        expect(filename.endsWith('.json')).toBe(true);
        expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(255);
    });

    test('returns not found for missing worlds', async () => {
        const response = await postJson('/api/worldinfo/get', { name: 'Missing' });
        expect(response.status).toBe(404);
    });

    test('renames a world without leaving the source file behind', async () => {
        await postJson('/api/worldinfo/edit', { name: 'Old', data: { entries: {} } });
        const response = await postJson('/api/worldinfo/rename', { oldName: 'Old', newName: 'New', data: { entries: {} } });
        expect(response.status).toBe(200);
        expect(fs.existsSync(path.join(directories.worlds, 'Old.json'))).toBe(false);
        expect(fs.existsSync(path.join(directories.worlds, 'New.json'))).toBe(true);
    });

    test('reads, edits, and renames legacy long filenames without truncating the source', async () => {
        const legacyName = 'l'.repeat(240);
        const legacyFilename = `${legacyName}.json`;
        const legacyPath = path.join(directories.worlds, legacyFilename);
        fs.writeFileSync(legacyPath, JSON.stringify({ entries: {}, marker: 'old' }));

        const getResponse = await postJson('/api/worldinfo/get', { name: legacyName });
        expect(getResponse.status).toBe(200);
        expect((await getResponse.json()).marker).toBe('old');

        const editResponse = await postJson('/api/worldinfo/edit', { name: legacyName, data: { entries: {}, marker: 'edited' } });
        expect(editResponse.status).toBe(200);
        expect(JSON.parse(fs.readFileSync(legacyPath, 'utf8')).marker).toBe('edited');

        const renameResponse = await postJson('/api/worldinfo/rename', { oldName: legacyName, newName: 'Renamed Legacy', data: { entries: {}, marker: 'renamed' } });
        expect(renameResponse.status).toBe(200);
        expect(fs.existsSync(legacyPath)).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(directories.worlds, 'Renamed Legacy.json'), 'utf8')).marker).toBe('renamed');
    });

    test('imports a native world info JSON file', async () => {
        const contents = JSON.stringify({ entries: { 0: { uid: 0, content: 'hello' } } });
        const response = await postImport({ filename: 'My World.json', contents });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ name: 'My World' });
        expect(fs.readFileSync(path.join(directories.worlds, 'My World.json'), 'utf8')).toBe(contents);
        expect(fs.readdirSync(uploadsPath)).toEqual([]);
    });

    test('prefers the requested name from the form body over the filename', async () => {
        const contents = JSON.stringify({ entries: {} });
        const response = await postImport({ filename: 'Ignored.json', contents, name: 'Renamed' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ name: 'Renamed' });
        expect(fs.existsSync(path.join(directories.worlds, 'Renamed.json'))).toBe(true);
        expect(fs.existsSync(path.join(directories.worlds, 'Ignored.json'))).toBe(false);
    });

    test('uses convertedData over the uploaded file body', async () => {
        const convertedData = JSON.stringify({ entries: {} });
        const response = await postImport({ filename: 'Converted.json', contents: 'not json at all', convertedData });
        expect(response.status).toBe(200);
        expect(fs.readFileSync(path.join(directories.worlds, 'Converted.json'), 'utf8')).toBe(convertedData);
    });

    test('rejects invalid JSON uploads with a 400', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const response = await postImport({ filename: 'Broken.json', contents: '{ not json' });
        expect(response.status).toBe(400);
        expect(await response.text()).toBe('Is not a valid world info file');
        expect(fs.readdirSync(directories.worlds)).toEqual([]);
        expect(fs.readdirSync(uploadsPath)).toEqual([]);
    });

    test('rejects JSON without an entries object', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const noEntries = await postImport({ filename: 'NoEntries.json', contents: JSON.stringify({ name: 'x' }) });
        expect(noEntries.status).toBe(400);
        const arrayEntries = await postImport({ filename: 'ArrayEntries.json', contents: JSON.stringify({ entries: [] }) });
        expect(arrayEntries.status).toBe(400);
        expect(fs.readdirSync(directories.worlds)).toEqual([]);
    });

    test('rejects import names that sanitize to an empty stem', async () => {
        const response = await postImport({ filename: 'Valid.json', contents: JSON.stringify({ entries: {} }), name: '/' });
        expect(response.status).toBe(400);
        expect(await response.text()).toBe('World file must have a name');
        expect(fs.readdirSync(directories.worlds)).toEqual([]);
    });

    test('reports import storage failures as a 500 instead of an invalid file', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        fs.mkdirSync(path.join(directories.worlds, 'Blocked.json'));
        const response = await postImport({ filename: 'Blocked.json', contents: JSON.stringify({ entries: {} }) });
        expect(response.status).toBe(500);
        expect(fs.statSync(path.join(directories.worlds, 'Blocked.json')).isDirectory()).toBe(true);
        expect(fs.readdirSync(uploadsPath)).toEqual([]);
    });

    test('rejects import requests without an uploaded file', async () => {
        const response = await postJson('/api/worldinfo/import', {});
        expect(response.status).toBe(400);
    });

    function postImport({ filename, contents, name, convertedData }) {
        const formData = new FormData();
        formData.append('avatar', new Blob([contents], { type: 'application/json' }), filename);
        if (name !== undefined) {
            formData.set('name', name);
        }
        if (convertedData !== undefined) {
            formData.set('convertedData', convertedData);
        }
        return fetch(`${baseUrl}/api/worldinfo/import`, { method: 'POST', body: formData });
    }

    function postJson(route, body) {
        return fetch(`${baseUrl}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
});
