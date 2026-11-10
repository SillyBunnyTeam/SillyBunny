import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkRow, hashTree, inputsForRow, OUTSIDE_FILE_TEXT, USER_HANDLE } from './util/hostile-file-names-harness.js';
import { ROW_TIMEOUT_MS, useRouteTable } from './util/hostile-file-names-suite.js';

const fetchMock = jest.fn();
const nodeFetch = await import('node-fetch');
jest.unstable_mockModule('node-fetch', () => ({ ...nodeFetch, default: fetchMock }));
jest.unstable_mockModule('../src/vectors/embedding.js', () => ({
    getTransformersVector: async () => [0.5, 0.5],
    getTransformersBatchVector: async texts => texts.map(() => [0.5, 0.5]),
}));

const { stageServerPluginRelease } = await import('../src/server-plugin-manager.js');

const DATA_MAID_TOKEN = 'seed-token';

describe('hostile file names on asset, file, extension, backup and vector routes', () => {
    const { rows, getHarness } = useRouteTable({
        '/api/assets': () => import('../src/endpoints/assets.js'),
        '/api/files': () => import('../src/endpoints/files.js'),
        '/api/extensions': () => import('../src/endpoints/extensions.js'),
        '/api/settings': () => import('../src/endpoints/settings.js'),
        '/api/backups': () => import('../src/endpoints/backups.js'),
        '/api/data-maid': () => import('../src/endpoints/data-maid.js'),
        '/api/image-metadata': () => import('../src/endpoints/image-metadata.js'),
        '/api/vector': () => import('../src/endpoints/vectors.js'),
        '/api/server-admin': () => import('../src/endpoints/server-admin.js'),
    });

    beforeAll(async () => {
        const { DataMaidService } = await import('../src/endpoints/data-maid.js');
        const { directories, outsideRoot } = getHarness();
        DataMaidService.TOKENS.set(DATA_MAID_TOKEN, {
            handle: USER_HANDLE,
            paths: [
                { hash: 'seed-hash', path: path.join(directories.themes, 'seed.json') },
                { hash: 'outside-hash', path: path.join(outsideRoot, 'sentinel.txt') },
            ],
        });
    });

    test.each(rows)('$title refuses hostile names or keeps them inside the user folder', async (row) => {
        expect(await checkRow(getHarness(), row)).toEqual([]);
    }, ROW_TIMEOUT_MS);

    test('no route in this suite reached the network for a hostile name', () => {
        expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('data maid token entry that points outside the user folder', () => {
        test('GET /view refuses to read the file', async () => {
            const row = { method: 'GET', mount: '/api/data-maid', path: '/view', field: 'hash', transport: 'query', fixed: { token: DATA_MAID_TOKEN } };
            const result = await getHarness().run(row, { value: 'outside-hash' });

            expect(result.status).toBe(403);
            expect(result.text).not.toContain(OUTSIDE_FILE_TEXT);
        });

        test('POST /delete leaves the file in place', async () => {
            const row = { method: 'POST', mount: '/api/data-maid', path: '/delete', field: 'hashes', transport: 'json', wrap: value => ({ token: DATA_MAID_TOKEN, hashes: [value] }) };
            const result = await getHarness().run(row, { value: 'outside-hash' });

            expect(result.status).toBe(204);
            expect(result.outsideChanges).toEqual([]);
        });
    });
});

describe('server plugin release staging', () => {
    let root;
    let pluginsRoot;
    let outsideRoot;

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-hostile-plugins-'));
        pluginsRoot = path.join(root, 'plugins');
        outsideRoot = path.join(root, 'outside');
        fs.mkdirSync(pluginsRoot);
        fs.mkdirSync(outsideRoot);
        fs.writeFileSync(path.join(outsideRoot, 'package.json'), '{"name":"outside","version":"0.0.1"}');
    });

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    });

    test('refuses every hostile directory name and leaves the sibling folder unchanged', async () => {
        const before = hashTree(outsideRoot);
        const outcomes = [];

        for (const { label, value } of inputsForRow({}, { outsideRoot })) {
            const outcome = await stageServerPluginRelease(
                { pluginsRoot, directoryName: value, targetVersion: '1.0.0' },
                { commandExists: () => true, platform: 'linux' },
            ).then(() => 'staged', error => error.code);
            if (outcome !== 'invalid_directory' && outcome !== 'plugin_missing') {
                outcomes.push(`${label}: ${outcome}`);
            }
        }

        expect(outcomes).toEqual([]);
        expect(hashTree(outsideRoot)).toEqual(before);
    });
});
