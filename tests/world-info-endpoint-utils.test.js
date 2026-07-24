import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
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
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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

    function postJson(route, body) {
        return fetch(`${baseUrl}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
});
