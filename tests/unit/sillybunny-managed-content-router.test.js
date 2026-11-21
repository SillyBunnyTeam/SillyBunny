/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a server route. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import util from 'node:util';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';

import { setConfigFilePath } from '../../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { ManagedContentError } = await import('../../src/sillybunny-managed-content.js');
const { read: readCardMetadata, write: writeCardMetadata } = await import('../../src/character-card-parser.js');
const { createManagedContentRouter, router: productionRouter } = await import('../../src/endpoints/sillybunny-managed-content.js');
const { generateFixtureContent } = await import('../fixtures/managed-content/generate.js');

const httpFetch = globalThis.fetch;
const REISEN = 'default_AssistantReisen.png';
const SPRITES = 'Assistant Reisen';
const LEXICON = 'SillyBunny Lexicon.json';

function fakeService(overrides = {}) {
    return {
        stateSignature: jest.fn(() => 'signature-1'),
        status: jest.fn(() => [{ filename: REISEN, type: 'character', version: 1, status: 'current', updateAvailable: false, installedVersion: 1 }]),
        apply: jest.fn(() => ({ backup: 'backup.png' })),
        restore: jest.fn(() => ({ backup: null })),
        ...overrides,
    };
}

describe('the managed content routes', () => {
    let server;
    let baseUrl;
    let tempRoot;
    let currentRouter;
    /** @type {Map<string, { profile: { handle: string }, directories: object }>} */
    let users;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = users.get(request.headers['x-test-user'] ?? 'alice');
            next();
        });
        app.use('/api/sillybunny/managed-content', (request, response, next) => currentRouter(request, response, next));
        await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-managed-router-'));
        users = new Map();
        addUser('alice');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    });

    function addUser(handle) {
        const root = path.join(tempRoot, handle);
        const directories = {
            root,
            characters: path.join(root, 'characters'),
            worlds: path.join(root, 'worlds'),
            backups: path.join(root, 'backups'),
            thumbnailsAvatar: path.join(root, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(root, 'thumbnails', 'avatar', 'mobile'),
        };
        Object.values(directories).forEach(directory => fs.mkdirSync(directory, { recursive: true }));
        users.set(handle, { profile: { handle }, directories });
        return directories;
    }

    const call = async (method, resource, { body, user = 'alice', raw } = {}) => {
        const response = await httpFetch(`${baseUrl}/api/sillybunny/managed-content${resource}`, {
            method,
            headers: { 'Content-Type': 'application/json', 'x-test-user': user },
            body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        });
        return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
    };
    const post = (resource, body, options) => call('POST', resource, { body, ...options });
    const useService = (services, options = {}) => {
        const createService = jest.fn(({ directories }) => services.get(directories) ?? fakeService());
        currentRouter = createManagedContentRouter({ bundledDirectory: '/bundled', createService, ...options });
        return createService;
    };
    const quiet = () => jest.spyOn(console, 'warn').mockImplementation(() => {});

    describe('status', () => {
        test('lists the items of the service of the user, made for the bundled directory and the folders of that user', async () => {
            const service = fakeService();
            const createService = useService(new Map([[users.get('alice').directories, service]]));

            const result = await call('GET', '/status');

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ items: service.status() });
            expect(createService).toHaveBeenCalledWith({ bundledDirectory: '/bundled', directories: users.get('alice').directories });
        });

        test('is computed once while the state of the files does not change', async () => {
            const service = fakeService();
            useService(new Map([[users.get('alice').directories, service]]));

            await call('GET', '/status');
            await call('GET', '/status');
            await call('GET', '/status');

            expect(service.status).toHaveBeenCalledTimes(1);
        });

        test('is computed again when the state of the files changes', async () => {
            const service = fakeService();
            useService(new Map([[users.get('alice').directories, service]]));
            await call('GET', '/status');

            service.stateSignature.mockReturnValue('signature-2');
            service.status.mockReturnValue([]);
            const result = await call('GET', '/status');

            expect(service.status).toHaveBeenCalledTimes(2);
            expect(result.body).toEqual({ items: [] });
        });

        test.each([
            ['an apply', '/apply', () => {}],
            ['a restore', '/restore', () => {}],
            ['an apply that failed', '/apply', (service) => { service.apply.mockImplementation(() => { throw new ManagedContentError('write_failed', 'x'); }); }],
        ])('is computed again after %s, even when the signature is the same', async (_name, resource, arrange) => {
            quiet();
            const service = fakeService();
            arrange(service);
            useService(new Map([[users.get('alice').directories, service]]));
            await call('GET', '/status');

            await post(resource, { filename: REISEN });
            await call('GET', '/status');

            expect(service.status).toHaveBeenCalledTimes(2);
        });

        test('keeps what it remembers apart for each user', async () => {
            const aliceDirectories = users.get('alice').directories;
            const bobDirectories = addUser('bob');
            const alice = fakeService({ status: jest.fn(() => [{ filename: 'alice.png' }]) });
            const bob = fakeService({ status: jest.fn(() => [{ filename: 'bob.png' }]) });
            const createService = useService(new Map([[aliceDirectories, alice], [bobDirectories, bob]]));

            const first = await call('GET', '/status', { user: 'alice' });
            const second = await call('GET', '/status', { user: 'bob' });

            expect(first.body).toEqual({ items: [{ filename: 'alice.png' }] });
            expect(second.body).toEqual({ items: [{ filename: 'bob.png' }] });
            expect(createService).toHaveBeenCalledWith(expect.objectContaining({ directories: bobDirectories }));
        });

        test.each([null, undefined])('answers a status failure thrown as %p with a code', async (thrown) => {
            quiet();
            const service = fakeService({ stateSignature: jest.fn(() => { throw thrown; }) });
            useService(new Map([[users.get('alice').directories, service]]));

            const result = await call('GET', '/status');

            expect(result).toMatchObject({ status: 500, body: { error: 'status_failed' } });
        });

        test('answers with a code and no detail when the service fails', async () => {
            const warn = quiet();
            const service = fakeService({ status: jest.fn(() => { throw new Error('/secret/path exploded'); }) });
            useService(new Map([[users.get('alice').directories, service]]));

            const result = await call('GET', '/status');

            expect(result.status).toBe(500);
            expect(result.body).toEqual({ error: 'status_failed' });
            expect(warn).toHaveBeenCalled();
        });

        test('is not a route for other methods, and apply is not a route for GET', async () => {
            useService(new Map());

            expect((await post('/status', {})).status).toBe(404);
            expect((await call('GET', '/apply')).status).toBe(404);
            expect((await call('GET', '/restore')).status).toBe(404);
        });
    });

    describe.each(['apply', 'restore'])('%s', (action) => {
        const resource = `/${action}`;

        test('hands the exact filename to the service of the user and answers with its backup', async () => {
            const service = fakeService();
            useService(new Map([[users.get('alice').directories, service]]));

            const result = await post(resource, { filename: REISEN });

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ backup: action === 'apply' ? 'backup.png' : null });
            expect(service[action]).toHaveBeenCalledWith(REISEN);
        });

        test.each([
            ['no body', undefined],
            ['an empty object', {}],
            ['a number', { filename: 5 }],
            ['null', { filename: null }],
            ['a list', { filename: [REISEN] }],
            ['an object', { filename: { toString: REISEN } }],
            ['an empty name', { filename: '' }],
            ['a name that is too long', { filename: 'a'.repeat(256) }],
            ['another field beside the name', { filename: REISEN, force: true }],
            ['a different field', { file: REISEN }],
            ['a list as the body', [REISEN]],
        ])('is a bad request for %s, and calls nothing', async (_name, body) => {
            const service = fakeService();
            useService(new Map([[users.get('alice').directories, service]]));

            const result = await post(resource, body);

            expect(result.status).toBe(400);
            expect(result.body).toEqual({ error: 'invalid_request' });
            expect(service[action]).not.toHaveBeenCalled();
        });

        test('is a bad request for a body with an own __proto__ key', async () => {
            const service = fakeService();
            useService(new Map([[users.get('alice').directories, service]]));

            const result = await call('POST', resource, { raw: `{"filename":"${REISEN}","__proto__":{"polluted":true}}` });

            expect(result.status).toBe(400);
            expect(service[action]).not.toHaveBeenCalled();
        });

        test.each([
            ['unknown_item', 404],
            ['already_current', 409],
            ['not_applicable', 409],
            ['unsafe_target', 409],
            ['bundled_missing', 500],
            ['backup_failed', 500],
            ['write_failed', 500],
        ])('answers %s with %i and the code only', async (code, status) => {
            quiet();
            const service = fakeService({ [action]: jest.fn(() => { throw new ManagedContentError(code, '/secret/path could not be written', new Error('EACCES /secret')); }) });
            useService(new Map([[users.get('alice').directories, service]]));

            const result = await post(resource, { filename: REISEN });

            expect(result.status).toBe(status);
            expect(result.body).toEqual({ error: code });
        });

        test('answers a failure it does not know with a code and no detail', async () => {
            quiet();
            const service = fakeService({ [action]: jest.fn(() => { throw new TypeError('/secret/path is undefined'); }) });
            useService(new Map([[users.get('alice').directories, service]]));

            const result = await post(resource, { filename: REISEN });

            expect(result.status).toBe(500);
            expect(result.body).toEqual({ error: `${action}_failed` });
        });

        test('logs the failure with the filename as one line, and keeps the detail out of the response', async () => {
            const warn = quiet();
            const service = fakeService({ [action]: jest.fn(() => { throw new ManagedContentError('write_failed', 'disk full', new Error('ENOSPC')); }) });
            useService(new Map([[users.get('alice').directories, service]]));

            const result = await post(resource, { filename: 'name\nFAKE LOG LINE' });

            expect(JSON.stringify(result.body)).not.toMatch(/ENOSPC|disk full|FAKE/);
            const logged = warn.mock.calls.flat().map(String).join(' ');
            expect(logged).toContain('name\\nFAKE LOG LINE');
            expect(logged).not.toContain('\n');
        });

        test('logs with a constant format string, so a name made of format specifiers is logged as it is', async () => {
            const warn = quiet();
            const service = fakeService({ [action]: jest.fn(() => { throw new ManagedContentError('write_failed', 'the file %s %d broke', new Error('ENOSPC')); }) });
            useService(new Map([[users.get('alice').directories, service]]));

            await post(resource, { filename: '%s' });

            const [format, ...rest] = warn.mock.calls[0];
            expect(format).toBe('Managed content %s could not be %s:');
            expect(rest[0]).toBe('"%s"');
            expect(util.format(...warn.mock.calls[0])).toContain(`Managed content "%s" could not be ${action === 'apply' ? 'updated' : 'restored'}:`);
        });

        test('logs a name or a detail with line separators as one line', async () => {
            const warn = quiet();
            const name = 'a\u2028b\u2029c\u0085d\re\nf';
            const service = fakeService({ [action]: jest.fn(() => { throw new ManagedContentError('write_failed', `${name} broke`); }) });
            useService(new Map([[users.get('alice').directories, service]]));

            await post(resource, { filename: name });

            const line = util.format(...warn.mock.calls[0]);
            expect(line).not.toMatch(/[\n\r\u0085\u2028\u2029]/);
            expect(line).toContain('\\u2028');
        });

        test('logs a change that was not needed as information, because a second click is no fault', async () => {
            const warn = quiet();
            const info = jest.spyOn(console, 'info').mockImplementation(() => {});
            const service = fakeService({ [action]: jest.fn(() => { throw new ManagedContentError('already_current', 'x'); }) });
            useService(new Map([[users.get('alice').directories, service]]));

            const result = await post(resource, { filename: REISEN });

            expect(result.status).toBe(409);
            expect(info).toHaveBeenCalledTimes(1);
            expect(warn).not.toHaveBeenCalled();
        });

        test.each([null, undefined, 'text', 42])('answers a failure thrown as %p with a code', async (thrown) => {
            quiet();
            const service = fakeService({ [action]: jest.fn(() => { throw thrown; }) });
            useService(new Map([[users.get('alice').directories, service]]));

            const result = await post(resource, { filename: REISEN });

            expect(result).toMatchObject({ status: 500, body: { error: `${action}_failed` } });
        });

        test('spends a point on a name that is not managed, so guessing names is limited too', async () => {
            quiet();
            const service = fakeService({ [action]: jest.fn(() => { throw new ManagedContentError('unknown_item', 'x'); }) });
            useService(new Map([[users.get('alice').directories, service]]), { rateLimit: { points: 3, durationSeconds: 60 } });

            const statuses = [];
            for (let attempt = 0; attempt < 4; attempt++) {
                statuses.push((await post(resource, { filename: `guess-${attempt}.png` })).status);
            }

            expect(statuses).toEqual([404, 404, 404, 429]);
        });

        test('limits each user to a number of changes, and the limit is shared by apply and restore', async () => {
            const aliceDirectories = users.get('alice').directories;
            const bobDirectories = addUser('bob');
            const alice = fakeService();
            const bob = fakeService();
            useService(new Map([[aliceDirectories, alice], [bobDirectories, bob]]), { rateLimit: { points: 2, durationSeconds: 60 } });

            const other = action === 'apply' ? '/restore' : '/apply';
            const statuses = [
                (await post(resource, { filename: REISEN })).status,
                (await post(other, { filename: REISEN })).status,
            ];
            const limited = await post(resource, { filename: REISEN });
            const otherUser = await post(resource, { filename: REISEN }, { user: 'bob' });
            const read = await call('GET', '/status');

            expect(statuses).toEqual([200, 200]);
            expect(limited.status).toBe(429);
            expect(limited.body).toEqual({ error: 'rate_limit_exceeded' });
            expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
            expect(alice[action]).toHaveBeenCalledTimes(1);
            expect(otherUser.status).toBe(200);
            expect(read.status).toBe(200);
        });

        test('does not spend the limit on a bad request', async () => {
            const service = fakeService();
            useService(new Map([[users.get('alice').directories, service]]), { rateLimit: { points: 1, durationSeconds: 60 } });

            await post(resource, {});
            await post(resource, { filename: 5 });
            const result = await post(resource, { filename: REISEN });

            expect(result.status).toBe(200);
        });
    });

    describe('with the real service, on a data folder seeded from the fixtures', () => {
        let bundled;
        let directories;

        beforeEach(() => {
            bundled = path.join(tempRoot, 'bundled');
            generateFixtureContent(bundled);
            directories = users.get('alice').directories;
            for (const name of [REISEN, 'default_AssistantTewi.png', SPRITES, 'Assistant Tewi']) {
                fs.cpSync(path.join(bundled, name), path.join(directories.characters, name), { recursive: true });
            }
            fs.copyFileSync(path.join(bundled, LEXICON), path.join(directories.worlds, LEXICON));
            fs.writeFileSync(path.join(directories.root, 'content.log'), [REISEN, 'default_AssistantTewi.png', SPRITES, 'Assistant Tewi', LEXICON].join('\n'));
            currentRouter = createManagedContentRouter({ bundledDirectory: bundled });
        });

        const editReisen = () => {
            const target = path.join(directories.characters, REISEN);
            const file = fs.readFileSync(target);
            const card = JSON.parse(readCardMetadata(file));
            card.data.description = 'My own description.';
            fs.writeFileSync(target, writeCardMetadata(file, JSON.stringify(card)));
            return fs.readFileSync(target);
        };
        const snapshot = (directory) => {
            const entries = [];
            const walk = (current) => {
                for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                    const target = path.join(current, entry.name);
                    entry.isDirectory() ? walk(target) : entries.push([path.relative(directory, target), fs.readFileSync(target).toString('base64')]);
                }
            };
            walk(directory);
            return entries.sort();
        };

        test('reports every item as current for a fresh data folder', async () => {
            const result = await call('GET', '/status');

            expect(result.status).toBe(200);
            expect(result.body.items.map(({ filename, status }) => [filename, status])).toEqual([
                [REISEN, 'current'],
                ['default_AssistantTewi.png', 'current'],
                [SPRITES, 'current'],
                ['Assistant Tewi', 'current'],
                [LEXICON, 'current'],
            ]);
        });

        test('sees an edit made after the first answer', async () => {
            await call('GET', '/status');

            editReisen();
            const result = await call('GET', '/status');

            expect(result.body.items.find(item => item.filename === REISEN).status).toBe('modified');
        });

        test('keeps the card of the user as a backup before it replaces it', async () => {
            const edited = editReisen();

            const result = await post('/apply', { filename: REISEN });

            expect(result.status).toBe(200);
            expect(fs.readFileSync(path.join(directories.backups, 'managed', result.body.backup))).toEqual(edited);
            expect(fs.readFileSync(path.join(directories.characters, REISEN))).not.toEqual(edited);
            expect((await call('GET', '/status')).body.items.find(item => item.filename === REISEN).status).toBe('current');
        });

        test('replaces nothing when the backup cannot be made', async () => {
            quiet();
            const edited = editReisen();
            fs.rmSync(directories.backups, { recursive: true });
            fs.writeFileSync(directories.backups, 'not a folder');

            const result = await post('/apply', { filename: REISEN });

            expect(result.status).toBe(500);
            expect(result.body).toEqual({ error: 'backup_failed' });
            expect(fs.readFileSync(path.join(directories.characters, REISEN))).toEqual(edited);
        });

        test('restores a deleted card from the bundled copy', async () => {
            fs.rmSync(path.join(directories.characters, REISEN));

            const result = await post('/restore', { filename: REISEN });

            expect(result).toMatchObject({ status: 200, body: { backup: null } });
            expect(fs.readFileSync(path.join(directories.characters, REISEN))).toEqual(fs.readFileSync(path.join(bundled, REISEN)));
        });

        describe('the cached thumbnails of a card', () => {
            const cacheThumbnails = (filename) => {
                const files = [path.join(directories.thumbnailsAvatar, filename), path.join(directories.thumbnailsAvatarMobile, filename)];
                files.forEach(file => fs.writeFileSync(file, 'cached'));
                return files;
            };
            const exists = files => files.map(file => fs.existsSync(file));

            test('are removed in both presets when an update writes the card, and only for that card', async () => {
                editReisen();
                const reisen = cacheThumbnails(REISEN);
                const tewi = cacheThumbnails('default_AssistantTewi.png');

                const result = await post('/apply', { filename: REISEN });

                expect(result.status).toBe(200);
                expect(exists(reisen)).toEqual([false, false]);
                expect(exists(tewi)).toEqual([true, true]);
            });

            test('are removed when a restore writes the card', async () => {
                fs.rmSync(path.join(directories.characters, REISEN));
                const reisen = cacheThumbnails(REISEN);

                const result = await post('/restore', { filename: REISEN });

                expect(result.status).toBe(200);
                expect(exists(reisen)).toEqual([false, false]);
            });

            test('stay when nothing is written', async () => {
                const reisen = cacheThumbnails(REISEN);

                const result = await post('/apply', { filename: REISEN });

                expect(result.status).toBe(409);
                expect(exists(reisen)).toEqual([true, true]);
            });

            test('do not fail an update that cannot remove them', async () => {
                const warn = quiet();
                editReisen();
                fs.mkdirSync(path.join(directories.thumbnailsAvatar, REISEN));

                const result = await post('/apply', { filename: REISEN });

                expect(result.status).toBe(200);
                expect(fs.readFileSync(path.join(directories.characters, REISEN))).toEqual(fs.readFileSync(path.join(bundled, REISEN)));
                expect(warn).toHaveBeenCalledWith(expect.stringContaining(REISEN), expect.anything());
            });
        });

        test('refuses a current item', async () => {
            const result = await post('/apply', { filename: REISEN });

            expect(result).toMatchObject({ status: 409, body: { error: 'already_current' } });
        });

        test.each([
            ['an item that is not managed', 'Seraphina.png'],
            ['the manifest itself', 'sillybunny-managed.json'],
            ['the index', 'index.json'],
            ['a name that climbs out of the folder', `../${REISEN}`],
            ['a name that climbs out from inside a managed folder', `${SPRITES}/../../outside.png`],
            ['a name inside a managed folder', `${SPRITES}/joy.webp`],
            ['a name with a backslash', `..\\${REISEN}`],
            ['an absolute path', '/etc/passwd'],
            ['a name with a null character', `${REISEN}\u0000.txt`],
            ['a name with another case', REISEN.toLowerCase()],
            ['a name with a trailing slash', `${SPRITES}/`],
        ])('does not find %s, and writes nothing anywhere', async (_name, filename) => {
            quiet();
            editReisen();
            const before = snapshot(tempRoot);

            const applied = await post('/apply', { filename });
            const restored = await post('/restore', { filename });

            expect(applied).toMatchObject({ status: 404, body: { error: 'unknown_item' } });
            expect(restored).toMatchObject({ status: 404, body: { error: 'unknown_item' } });
            expect(snapshot(tempRoot)).toEqual(before);
        });

        test('keeps the folders of one user out of the reach of another', async () => {
            const bobDirectories = addUser('bob');
            editReisen();
            const before = snapshot(bobDirectories.root);

            const result = await post('/apply', { filename: REISEN }, { user: 'bob' });

            expect(result.status).toBe(409);
            expect(result.body.error).toBe('not_applicable');
            expect(snapshot(bobDirectories.root)).toEqual(before);
            expect(fs.readdirSync(path.join(directories.backups))).toEqual([]);
        });
    });

    test('the production router answers a list of items', async () => {
        currentRouter = productionRouter;

        const result = await call('GET', '/status');

        expect(result.status).toBe(200);
        expect(Array.isArray(result.body.items)).toBe(true);
    });
});
