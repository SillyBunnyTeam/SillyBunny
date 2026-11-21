import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { prepareEnvironment, USER_HANDLE } from './util/hostile-file-names-harness.js';

let environment;
let server;
let baseUrl;
let userImages;

beforeAll(async () => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
        jest.spyOn(console, method).mockImplementation(() => {});
    }
    environment = prepareEnvironment();
    const { getUserDirectories, router } = await import('../src/users.js');
    const directories = getUserDirectories(USER_HANDLE);
    userImages = directories.userImages;

    // No helmet here: the route has to set its own headers.
    const app = express();
    app.use((request, _response, next) => {
        request.user = { profile: { handle: USER_HANDLE, name: 'images', admin: false }, directories };
        next();
    });
    app.use(router);
    server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    fs.mkdirSync(path.join(userImages, 'Folder'), { recursive: true });
    for (const name of ['a.png', 'a.avif', 'a.AVIF', 'a.jfif', 'a.webp', 'a.mp4', 'a.bin']) {
        fs.writeFileSync(path.join(userImages, 'Folder', name), 'x');
    }
}, 120_000);

afterAll(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    environment?.restore();
    jest.restoreAllMocks();
});

describe('stored images route headers', () => {
    test.each([
        ['a.png', 'image/png'],
        ['a.webp', 'image/webp'],
        ['a.avif', 'image/avif'],
        ['a.AVIF', 'image/avif'],
        ['a.jfif', 'image/jpeg'],
        ['a.mp4', 'video/mp4'],
        ['a.bin', 'application/octet-stream'],
    ])('%s is served as %s and is never sniffed', async (name, contentType) => {
        const response = await fetch(`${baseUrl}/user/images/Folder/${name}`);

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(contentType);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });
});
