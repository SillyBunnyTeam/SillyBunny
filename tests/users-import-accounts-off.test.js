import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_USER } from '../src/constants.js';
import { readReply, startAccountServer } from './util/user-account-harness.js';

const harness = await startAccountServer({ config: { enableUserAccounts: false } });

// A successful import copies the default content into the account, which can pass the default Jest timeout on a busy machine.
jest.setTimeout(30000);

const outsideRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-import-accounts-off-'));
const SOURCE_FILES = {
    'settings.json': '{"owner":"source"}',
    'extensions/source-extension/manifest.json': '{"js":"index.js"}',
    'extensions/source-extension/index.js': 'export {};',
};

let source;

beforeEach(async () => {
    await harness.reset();
    source = fs.mkdtempSync(path.join(outsideRoot, 'source-'));
    for (const [relativePath, content] of Object.entries(SOURCE_FILES)) {
        fs.mkdirSync(path.dirname(path.join(source, relativePath)), { recursive: true });
        fs.writeFileSync(path.join(source, relativePath), content);
    }
});

afterAll(async () => {
    await harness.close();
    fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe('server folder imports with user accounts off', () => {
    test('a request without a login imports a folder as the default user', async () => {
        const reply = await readReply(await harness.client().post('/api/users/import-sillytavern/folder', { sourcePath: source }));

        expect(reply.status).toBe(200);
        expect(fs.readFileSync(path.join(harness.userRoot(DEFAULT_USER.handle), 'settings.json'), 'utf8')).toBe('{"owner":"source"}');
    });

    test('a request without a login syncs extensions as the default user', async () => {
        const reply = await readReply(await harness.client().post('/api/users/import-sillytavern/extensions', { sourcePath: source }));

        expect(reply.status).toBe(200);
        expect(fs.readFileSync(path.join(harness.userRoot(DEFAULT_USER.handle), 'extensions', 'source-extension', 'index.js'), 'utf8')).toBe('export {};');
    });
});
