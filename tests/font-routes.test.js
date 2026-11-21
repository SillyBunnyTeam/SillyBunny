import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

import { buildFontTables, buildWoff } from './helpers/font-fixtures.js';

const harness = fileURLToPath(new URL('./helpers/font-routes-harness.js', import.meta.url));
const font = buildFontTables({ family: 'Route Face' }).build();

const runtimes = [['Node.js', process.execPath]];
const bun = process.env.BUN_BINARY || path.join(os.homedir(), '.bun/bin/bun');
if (fs.existsSync(bun)) runtimes.push(['Bun', bun]);

describe.each(runtimes)('imported fonts through the file routes on %s', (_name, runtime) => {
    let root;
    let child;
    let base;

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-font-routes-'));
        child = spawn(runtime, [harness, path.join(root, 'data')], { stdio: ['ignore', 'pipe', 'pipe'] });
        base = await new Promise((resolve, reject) => {
            let output = '';
            const timer = setTimeout(() => reject(new Error(`The harness did not start: ${output}`)), 20000);
            child.stdout.on('data', chunk => {
                output += chunk;
                const match = /PORT (\d+)/.exec(output);
                if (match) {
                    clearTimeout(timer);
                    resolve(`http://127.0.0.1:${match[1]}`);
                }
            });
            child.stderr.on('data', chunk => { output += chunk; });
            child.on('exit', code => reject(new Error(`The harness exited with ${code}: ${output}`)));
        });
    }, 30000);

    afterAll(async () => {
        child?.removeAllListeners('exit');
        child?.kill();
        if (child && child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });

    const post = (route, body, account = 'account-a') => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-account': account }, body: JSON.stringify(body) });
    const get = (route, account = 'account-a') => fetch(`${base}${route}`, { headers: { 'x-test-account': account } });
    const upload = (name, data = font, account) => post('/api/files/upload', { name, data: data.toString('base64') }, account);

    test.each([
        ['woff2', 'font/woff2'],
        ['woff', 'font/woff'],
        ['ttf', 'font/ttf'],
        ['otf', 'font/otf'],
    ])('an uploaded .%s is served byte for byte with the type %s', async (extension, type) => {
        const fileName = `sb-font-${'0123456789ab'.slice(0, 11)}${extension.length}.${extension}`;
        const sent = extension === 'woff' ? buildWoff(buildFontTables({ family: 'W' }).tables) : font;
        const response = await upload(fileName, sent);
        expect(response.status).toBe(200);
        const { path: stored } = await response.json();
        expect(stored).toBe(`/user/files/${fileName}`);
        const served = await get(stored);
        expect(served.status).toBe(200);
        expect(served.headers.get('content-type')).toContain(type);
        expect(Buffer.from(await served.arrayBuffer()).equals(sent)).toBe(true);
    });

    test('a second account gets 404 for a font that the first one uploaded', async () => {
        const fileName = 'sb-font-aaaaaaaaaaaa.ttf';
        expect((await upload(fileName)).status).toBe(200);
        expect((await get(`/user/files/${fileName}`, 'account-a')).status).toBe(200);
        expect((await get(`/user/files/${fileName}`, 'account-b')).status).toBe(404);
        expect((await post('/api/files/delete', { path: `/user/files/${fileName}` }, 'account-b')).status).toBe(404);
        expect((await get(`/user/files/${fileName}`, 'account-a')).status).toBe(200);
    });

    test('a path that climbs out of the files folder is refused when served and when deleted', async () => {
        fs.writeFileSync(path.join(root, 'data/account-a/secret.txt'), 'secret');
        for (const route of ['/user/files/..%2f..%2fsecret.txt', '/user/files/%2e%2e%2f%2e%2e%2fsecret.txt', '/user/files/../../secret.txt']) {
            const response = await get(route);
            expect([400, 403, 404]).toContain(response.status);
            expect(await response.text()).not.toBe('secret');
        }
        for (const target of ['/../secret.txt', '../../secret.txt', '/user/files/../../secret.txt', '/user/filesX/x', '/user/files/../files-evil/x']) {
            expect([400, 404]).toContain((await post('/api/files/delete', { path: target })).status);
        }
        expect(fs.existsSync(path.join(root, 'data/account-a/secret.txt'))).toBe(true);
    });

    test('a name that is not a plain file name is refused by the upload route', async () => {
        for (const name of ['../sb-font-0123456789ab.ttf', 'sb-font-0123456789ab/x.ttf', 'sb-font-0123456789ab.ttf/', '.sb-font.ttf', 'sb font.ttf', 'sb-font-0123456789ab.exe']) {
            expect((await upload(name)).status).toBe(400);
        }
    });

    test('delete removes the file, then reports 404 for it', async () => {
        const fileName = 'sb-font-bbbbbbbbbbbb.otf';
        await upload(fileName);
        expect((await post('/api/files/delete', { path: `/user/files/${fileName}` })).status).toBe(200);
        expect((await get(`/user/files/${fileName}`)).status).toBe(404);
        expect((await post('/api/files/delete', { path: `/user/files/${fileName}` })).status).toBe(404);
    });
});
