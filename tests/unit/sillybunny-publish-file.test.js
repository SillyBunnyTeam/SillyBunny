/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a file helper. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';

import { setConfigFilePath } from '../../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { publishNewFile, NO_HARD_LINK_CODES } = await import('../../src/sillybunny-publish-file.js');
const { router: themesRouter } = await import('../../src/endpoints/themes.js');

const failWith = code => () => { throw Object.assign(new Error(`${code}: fake`), { code }); };

describe('publishing a new file without replacing one', () => {
    let root;
    let directory;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-publish-'));
        directory = path.join(root, 'themes');
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('creates the folder and the file, and leaves no staging folder behind', () => {
        expect(publishNewFile(directory, 'Midnight.json', '{"name":"Midnight"}')).toBe(true);

        expect(fs.readdirSync(directory)).toEqual(['Midnight.json']);
        expect(fs.readFileSync(path.join(directory, 'Midnight.json'), 'utf8')).toBe('{"name":"Midnight"}');
    });

    test('says false and keeps the file that is there when the name is taken', () => {
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'Midnight.json'), 'the user edit');

        expect(publishNewFile(directory, 'Midnight.json', '{"name":"Midnight"}')).toBe(false);

        expect(fs.readFileSync(path.join(directory, 'Midnight.json'), 'utf8')).toBe('the user edit');
        expect(fs.readdirSync(directory)).toEqual(['Midnight.json']);
    });

    test('fails when the folder cannot be made', () => {
        fs.writeFileSync(directory, 'a file where the folder should be');

        expect(() => publishNewFile(directory, 'Midnight.json', '{}')).toThrow('not available');
    });

    describe('on a file system without hard links', () => {
        test('knows the four codes that mean it', () => {
            expect([...NO_HARD_LINK_CODES].sort()).toEqual(['ENOSYS', 'ENOTSUP', 'EPERM', 'EXDEV']);
        });

        test.each(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'])('copies the staged file instead when linking fails with %s', (code) => {
            const link = jest.fn(failWith(code));

            expect(publishNewFile(directory, 'Midnight.json', '{"name":"Midnight"}', { link })).toBe(true);

            expect(link).toHaveBeenCalledTimes(1);
            expect(fs.readdirSync(directory)).toEqual(['Midnight.json']);
            expect(fs.readFileSync(path.join(directory, 'Midnight.json'), 'utf8')).toBe('{"name":"Midnight"}');
        });

        test('copies exclusively: a file of that name is kept, and the answer is false', () => {
            fs.mkdirSync(directory);
            fs.writeFileSync(path.join(directory, 'Midnight.json'), 'the user edit');

            expect(publishNewFile(directory, 'Midnight.json', '{}', { link: failWith('EPERM') })).toBe(false);

            expect(fs.readFileSync(path.join(directory, 'Midnight.json'), 'utf8')).toBe('the user edit');
            expect(fs.readdirSync(directory)).toEqual(['Midnight.json']);
        });

        test('does not copy when the link says the name is taken', () => {
            const copy = jest.fn();

            expect(publishNewFile(directory, 'Midnight.json', '{}', { link: failWith('EEXIST'), copy })).toBe(false);

            expect(copy).not.toHaveBeenCalled();
        });

        test('does not hide any other link failure behind a copy', () => {
            const copy = jest.fn();

            expect(() => publishNewFile(directory, 'Midnight.json', '{}', { link: failWith('EIO'), copy })).toThrow('EIO');

            expect(copy).not.toHaveBeenCalled();
            expect(fs.readdirSync(directory)).toEqual([]);
        });

        test('removes a half-written copy when the copy fails after it began', () => {
            const copy = jest.fn((from, to) => {
                fs.writeFileSync(to, 'half');
                throw Object.assign(new Error('ENOSPC: fake'), { code: 'ENOSPC' });
            });

            expect(() => publishNewFile(directory, 'Midnight.json', '{}', { link: failWith('EPERM'), copy })).toThrow('ENOSPC');

            expect(fs.readdirSync(directory)).toEqual([]);
        });

        test('leaves no staging folder behind whichever way it ends', () => {
            publishNewFile(directory, 'A.json', '{}', { link: failWith('EXDEV') });
            publishNewFile(directory, 'A.json', '{}', { link: failWith('EXDEV') });

            expect(fs.readdirSync(directory)).toEqual(['A.json']);
        });
    });
});

describe('the create route of themes, which publishes through the same helper', () => {
    let server;
    let baseUrl;
    let root;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { directories: { themes: path.join(root, 'themes') } };
            next();
        });
        app.use('/api/themes', themesRouter);
        await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-themes-create-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    });

    const create = async body => (await fetch(`${baseUrl}/api/themes/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })).status;

    test('answers 201 for a new theme, and 409 for one of the same name, which it leaves as it is', async () => {
        expect(await create({ name: 'Midnight', custom_css: 'a' })).toBe(201);
        expect(await create({ name: 'Midnight', custom_css: 'b' })).toBe(409);

        const themes = path.join(root, 'themes');
        expect(fs.readdirSync(themes)).toEqual(['Midnight.json']);
        expect(JSON.parse(fs.readFileSync(path.join(themes, 'Midnight.json'), 'utf8')).custom_css).toBe('a');
    });

    test('answers 400 without a name', async () => {
        expect(await create({})).toBe(400);
        expect(await create({ name: '   ' })).toBe(400);
    });
});
