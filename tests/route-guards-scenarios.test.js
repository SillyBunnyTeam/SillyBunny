import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { OUTSIDE_FILE_TEXT, prepareEnvironment, USER_HANDLE } from './util/hostile-file-names-harness.js';

// A request that the route never answers fails at this deadline instead of at the test timeout.
const REQUEST_TIMEOUT_MS = 3_000;

const ROUTERS = {
    '/api/files': () => import('../src/endpoints/files.js'),
};

let environment;
let server;
let baseUrl;
let directories;
let outsideRoot;

beforeAll(async () => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
        jest.spyOn(console, method).mockImplementation(() => {});
    }
    environment = prepareEnvironment();
    const { getUserDirectories } = await import('../src/users.js');
    directories = getUserDirectories(USER_HANDLE);
    outsideRoot = path.join(environment.dataRoot, 'outside');

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((request, _response, next) => {
        request.user = { profile: { handle: USER_HANDLE, name: 'guards', admin: false }, directories };
        next();
    });
    for (const [mount, loadRouter] of Object.entries(ROUTERS)) {
        app.use(mount, (await loadRouter()).router);
    }
    server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 120_000);

beforeEach(() => {
    for (const root of [directories.root, outsideRoot]) {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
    for (const directory of [...Object.values(directories), outsideRoot]) {
        fs.mkdirSync(directory, { recursive: true });
    }
});

afterAll(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    environment?.restore();
    jest.restoreAllMocks();
});

function write(target, content) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

async function post(target, body, { form = false } = {}) {
    const response = await fetch(`${baseUrl}${target}`, {
        method: 'POST',
        headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, text: await response.text() };
}

const toRequestPath = target => path.relative(directories.root, target).replaceAll(path.sep, '/');

describe('file routes and a sibling of the files folder', () => {
    let keptFile;
    let siblingFile;

    beforeEach(() => {
        keptFile = path.join(directories.files, 'kept.txt');
        siblingFile = path.join(`${directories.files}-old`, 'sibling.txt');
        write(keptFile, 'kept');
        write(siblingFile, OUTSIDE_FILE_TEXT);
    });

    test('POST /delete refuses a file in a sibling folder whose name starts with the files folder name', async () => {
        const sibling = await post('/api/files/delete', { path: toRequestPath(siblingFile) });
        const kept = await post('/api/files/delete', { path: toRequestPath(keptFile) });

        expect(sibling.status).toBe(400);
        expect(fs.existsSync(siblingFile)).toBe(true);
        expect(kept.status).toBe(200);
        expect(fs.existsSync(keptFile)).toBe(false);
    });

    test('POST /verify leaves out a file in a sibling folder whose name starts with the files folder name', async () => {
        const result = await post('/api/files/verify', { urls: [toRequestPath(siblingFile), toRequestPath(keptFile)] });

        expect(result.status).toBe(200);
        expect(JSON.parse(result.text)).toEqual({ [toRequestPath(keptFile)]: true });
    });
});
