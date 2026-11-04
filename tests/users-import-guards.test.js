import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_USER } from '../src/constants.js';
import { ADMIN, MEMBER, OPEN_MEMBER, readReply, startAccountServer } from './util/user-account-harness.js';

const harness = await startAccountServer();

// A successful import copies the default content into the account, which can pass the default Jest timeout on a busy machine.
jest.setTimeout(30000);

const outsideRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-import-guards-'));
const UNAUTHORIZED = { status: 403, body: { error: 'Unauthorized' } };
const ADMIN_FILES = {
    'settings.json': '{"owner":"admin"}',
    'secrets.json': '{"api_key_openai":"admin-key"}',
    'chats/Ada/private.jsonl': '{"private":true}',
    'extensions/admin-extension/manifest.json': '{"js":"index.js"}',
    'extensions/admin-extension/index.js': 'export {};',
};

let nextFolder = 1;
let member;

function writeTree(root, files) {
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

function outsideFolder() {
    const folder = path.join(outsideRoot, `source-${nextFolder++}`);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
}

/**
 * Links a folder with a junction on Windows, which needs no extra rights there, and with a symbolic link elsewhere.
 */
function linkFolder(target, linkPath) {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, 'junction');
}

function canLinkFiles() {
    const target = path.join(outsideRoot, 'file-link-probe-target');
    const link = path.join(outsideRoot, 'file-link-probe-link');
    fs.writeFileSync(target, '');
    try {
        fs.symlinkSync(target, link);
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(link, { force: true });
        fs.rmSync(target, { force: true });
    }
}

function memberFile(...segments) {
    return path.join(harness.userRoot(OPEN_MEMBER.handle), ...segments);
}

function expectNoAdminDataInMemberFolder() {
    expect(fs.existsSync(memberFile('secrets.json'))).toBe(false);
    expect(fs.existsSync(memberFile('chats', 'Ada', 'private.jsonl'))).toBe(false);
    expect(fs.existsSync(memberFile('extensions', 'admin-extension'))).toBe(false);
}

beforeEach(async () => {
    await harness.reset();
    writeTree(harness.userRoot(ADMIN.handle), ADMIN_FILES);
    member = await harness.loginAs(OPEN_MEMBER);
});

afterAll(async () => {
    await harness.close();
    fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe('POST /api/users/import-sillytavern/folder', () => {
    const importFolder = (client, sourcePath) => client.post('/api/users/import-sillytavern/folder', { sourcePath });

    test('only an admin may import the folder of another account', async () => {
        const admin = await harness.loginAs(DEFAULT_USER);
        writeTree(harness.userRoot(MEMBER.handle), { 'settings.json': '{"owner":"member"}' });

        const memberReply = await readReply(await importFolder(member, harness.userRoot(ADMIN.handle)));
        const adminReply = await readReply(await importFolder(admin, harness.userRoot(MEMBER.handle)));

        expect(memberReply).toEqual(UNAUTHORIZED);
        expectNoAdminDataInMemberFolder();
        expect(adminReply.status).toBe(200);
    });

    test.each([
        ['the data root', () => harness.dataRoot],
        ['a missing folder inside the data root', () => path.join(harness.dataRoot, ADMIN.handle, 'no-such-folder')],
        ['a relative path into the data root', () => path.relative(process.cwd(), harness.userRoot(ADMIN.handle))],
    ])('answers 403 to a member for %s', async (_title, sourcePath) => {
        const reply = await readReply(await importFolder(member, sourcePath()));

        expect(reply).toEqual(UNAUTHORIZED);
        expectNoAdminDataInMemberFolder();
    });

    test('a member gets the answer for its own folder there, and 403 for another account', async () => {
        writeTree(harness.userRoot(OPEN_MEMBER.handle), { 'settings.json': '{"owner":"open"}' });
        writeTree(harness.userRoot(MEMBER.handle), { 'settings.json': '{"owner":"member"}' });

        const own = await readReply(await importFolder(member, harness.userRoot(OPEN_MEMBER.handle)));
        const other = await readReply(await importFolder(member, harness.userRoot(MEMBER.handle)));

        expect(own).toEqual({ status: 400, body: { error: 'That folder is already the current SillyBunny account.' } });
        expect(other).toEqual(UNAUTHORIZED);
    });

    test('answers 403 to a member for a folder that links to another account', async () => {
        const link = path.join(outsideFolder(), 'linked-account');
        linkFolder(harness.userRoot(ADMIN.handle), link);

        const reply = await readReply(await importFolder(member, link));

        expect(reply).toEqual(UNAUTHORIZED);
        expectNoAdminDataInMemberFolder();
    });

    test('imports a member folder from outside the data root and skips a linked folder that leads into another account', async () => {
        const source = outsideFolder();
        writeTree(source, { 'settings.json': '{"owner":"outside"}', 'characters/Own.png': 'card' });
        linkFolder(path.join(harness.userRoot(ADMIN.handle), 'chats'), path.join(source, 'chats'));

        const reply = await readReply(await importFolder(member, source));

        expect(reply.status).toBe(200);
        expect(fs.readFileSync(memberFile('settings.json'), 'utf8')).toBe('{"owner":"outside"}');
        expect(fs.readFileSync(memberFile('characters', 'Own.png'), 'utf8')).toBe('card');
        expectNoAdminDataInMemberFolder();
    });
});

const describeWithFileLinks = canLinkFiles() ? describe : describe.skip;

describeWithFileLinks('POST /api/users/import-sillytavern/folder, where the system user can link files', () => {
    test('skips a linked file that leads into another account', async () => {
        const source = outsideFolder();
        writeTree(source, { 'settings.json': '{"owner":"outside"}' });
        fs.symlinkSync(path.join(harness.userRoot(ADMIN.handle), 'secrets.json'), path.join(source, 'secrets.json'));

        const reply = await readReply(await member.post('/api/users/import-sillytavern/folder', { sourcePath: source }));

        expect(reply.status).toBe(200);
        expect(fs.readFileSync(memberFile('settings.json'), 'utf8')).toBe('{"owner":"outside"}');
        expect(fs.existsSync(memberFile('secrets.json'))).toBe(false);
    });
});

describe('POST /api/users/import-sillytavern/extensions', () => {
    const syncExtensions = sourcePath => member.post('/api/users/import-sillytavern/extensions', { sourcePath });

    test('answers 403 to a member for the folder of another account', async () => {
        const reply = await readReply(await syncExtensions(harness.userRoot(ADMIN.handle)));

        expect(reply).toEqual(UNAUTHORIZED);
        expectNoAdminDataInMemberFolder();
    });

    test('answers 403 to a member when the extensions folder of an outside source links into another account', async () => {
        const source = outsideFolder();
        writeTree(source, { 'settings.json': '{"owner":"outside"}' });
        linkFolder(path.join(harness.userRoot(ADMIN.handle), 'extensions'), path.join(source, 'extensions'));

        const reply = await readReply(await syncExtensions(source));

        expect(reply).toEqual(UNAUTHORIZED);
        expectNoAdminDataInMemberFolder();
    });
});
