import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';

import { DEFAULT_USER, UPLOADS_DIRECTORY } from '../src/constants.js';
import { readReply, startAccountServer } from './util/user-account-harness.js';

const harness = await startAccountServer();

// A successful import copies the default content into the account, which can pass the default Jest timeout on a busy machine.
jest.setTimeout(30000);

const IMPORTED_METADATA = {
    'entity-date-added.json': JSON.stringify({ version: 1, characters: { initialized: true, entries: { 'Ada.png': 1000 } } }),
    'entity-last-chat.json': JSON.stringify({ version: 1, characters: { entries: { 'Ada.png': 'first' } } }),
};
const EXISTING_METADATA = {
    'entity-date-added.json': JSON.stringify({ version: 1, characters: { initialized: true, entries: { 'Existing.png': 500 } } }),
    'entity-last-chat.json': JSON.stringify({ version: 1, characters: { entries: { 'Existing.png': 'earlier' } } }),
};
const CORRUPT_METADATA = {
    'entity-date-added.json': 'not json',
    'entity-last-chat.json': 'not json',
};

const sourceTemp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-st-import-'));
const sourceBase = path.join(sourceTemp, 'st-source');
const targetRoot = harness.userRoot(DEFAULT_USER.handle);

let admin;

function writeTree(root, files) {
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

function targetFile(...segments) {
    return path.join(targetRoot, ...segments);
}

function readTargetFile(...segments) {
    return fs.readFileSync(targetFile(...segments), 'utf8');
}

function readTargetJson(...segments) {
    return JSON.parse(readTargetFile(...segments));
}

function expectMergedMetadata() {
    expect(readTargetJson('entity-date-added.json').characters.entries).toEqual({ 'Ada.png': 1000, 'Existing.png': 500 });
    expect(readTargetJson('entity-last-chat.json').characters.entries).toEqual({ 'Ada.png': 'first', 'Existing.png': 'earlier' });
}

function expectNoImportedMetadata() {
    expect(fs.existsSync(targetFile('entity-date-added.json'))).toBe(false);
    expect(fs.existsSync(targetFile('entity-last-chat.json'))).toBe(false);
}

function canCreateSymlinks(directory) {
    const target = path.join(directory, 'symlink-probe-target');
    const link = path.join(directory, 'symlink-probe-link');
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

function underFolder(folder, entries) {
    return Object.fromEntries(Object.entries(entries).map(([name, content]) => [`${folder}/${name}`, content]));
}

function createZip(entries) {
    return new Promise((resolve, reject) => {
        const archive = archiver('zip');
        const chunks = [];
        archive.on('data', chunk => chunks.push(chunk));
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        archive.on('error', reject);
        for (const [name, content] of Object.entries(entries)) {
            archive.append(content, { name });
        }
        archive.finalize();
    });
}

/**
 * Waits for a folder to become empty, because the ZIP route removes the upload after it answers.
 * @param {string} folder Folder to read
 * @returns {Promise<string[]>} Folder contents when the folder became empty or when the wait ended
 */
async function contentsOnceEmpty(folder) {
    const deadline = Date.now() + 5000;
    while (fs.readdirSync(folder).length > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return fs.readdirSync(folder);
}

beforeEach(async () => {
    await harness.reset();
    fs.rmSync(sourceBase, { recursive: true, force: true, maxRetries: 5 });
    admin = await harness.loginAs(DEFAULT_USER);
});

afterAll(async () => {
    await harness.close();
    fs.rmSync(sourceTemp, { recursive: true, force: true, maxRetries: 5 });
});

describe('POST /api/users/import-sillytavern/folder', () => {
    const importFolder = sourcePath => admin.post('/api/users/import-sillytavern/folder', { sourcePath });

    test('copies the account data of the default user from a SillyTavern app folder', async () => {
        writeTree(path.join(sourceBase, 'data'), {
            'cookie-secret.txt': 'not a user folder',
            '_storage/item': 'not a user folder',
            'other-user/settings.json': '{"imported":"other"}',
            'other-user/chats/Other/other.jsonl': '{}',
            ...underFolder('default-user', {
                'settings.json': '{"imported":true}',
                'secrets.json': '{"api_key":"synthetic"}',
                'characters/Ada.png': 'card',
                'chats/Ada/first.jsonl': '{}',
                'extensions/sample/manifest.json': '{}',
                'extensions/sample/.git/HEAD': 'ref',
                'notes.txt': 'not account data',
                ...IMPORTED_METADATA,
            }),
        });
        writeTree(targetRoot, {
            'settings.json': '{"imported":false}',
            'characters/Ada.png': 'older card',
            'characters/Existing.png': 'existing card',
            ...EXISTING_METADATA,
        });

        const { status, body } = await readReply(await importFolder(sourceBase));

        expect(status).toBe(200);
        expect(body.sourceRoot).toBe(path.join(sourceBase, 'data', 'default-user'));
        expect(body.copiedEntries).toBe(7);
        expect(body.message).toContain('Imported 7 data sections');
        expect(readTargetJson('settings.json')).toEqual({ imported: true });
        expect(readTargetJson('secrets.json')).toEqual({ api_key: 'synthetic' });
        expect(readTargetFile('characters', 'Ada.png')).toBe('card');
        expect(readTargetFile('characters', 'Existing.png')).toBe('existing card');
        expect(readTargetFile('chats', 'Ada', 'first.jsonl')).toBe('{}');
        expect(readTargetFile('extensions', 'sample', 'manifest.json')).toBe('{}');
        expect(fs.existsSync(targetFile('extensions', 'sample', '.git'))).toBe(false);
        expect(fs.existsSync(targetFile('notes.txt'))).toBe(false);
        expect(fs.existsSync(targetFile('chats', 'Other'))).toBe(false);
        expectMergedMetadata();
    });

    test('skips corrupt metadata files and adds the missing default content', async () => {
        writeTree(sourceBase, { 'characters/Ada.png': 'card', ...CORRUPT_METADATA });

        const { status, body } = await readReply(await importFolder(sourceBase));

        expect(status).toBe(200);
        expect(body.copiedEntries).toBe(1);
        expect(readTargetFile('characters', 'Ada.png')).toBe('card');
        expect(fs.existsSync(targetFile('settings.json'))).toBe(true);
        expectNoImportedMetadata();
    });

    test('answers 400 for a missing source folder and copies nothing', async () => {
        writeTree(targetRoot, { 'settings.json': '{"imported":false}' });

        const reply = await readReply(await importFolder(path.join(sourceTemp, 'st-missing')));

        expect(reply).toEqual({ status: 400, body: { error: 'That SillyTavern path does not exist or is not a folder.' } });
        expect(readTargetJson('settings.json')).toEqual({ imported: false });
    });
});

const describeWithSymlinks = canCreateSymlinks(sourceTemp) ? describe : describe.skip;

describeWithSymlinks('POST /api/users/import-sillytavern/folder, where the system user can create symbolic links', () => {
    test('skips symbolic links in the source', async () => {
        const linkTargets = path.join(sourceTemp, 'st-link-targets');
        writeTree(linkTargets, { 'linked.png': 'linked card', 'nested/linked.jsonl': '{}' });
        writeTree(sourceBase, { 'characters/Ada.png': 'card', 'chats/Ada/first.jsonl': '{}' });
        fs.symlinkSync(path.join(linkTargets, 'linked.png'), path.join(sourceBase, 'characters', 'Linked.png'));
        fs.symlinkSync(path.join(linkTargets, 'nested'), path.join(sourceBase, 'chats', 'Linked'), 'dir');

        const { status } = await readReply(await admin.post('/api/users/import-sillytavern/folder', { sourcePath: sourceBase }));

        expect(status).toBe(200);
        expect(readTargetFile('characters', 'Ada.png')).toBe('card');
        expect(fs.existsSync(targetFile('characters', 'Linked.png'))).toBe(false);
        expect(fs.existsSync(targetFile('chats', 'Linked'))).toBe(false);
    });
});

describe('POST /api/users/import-sillytavern/extensions', () => {
    const syncExtensions = sourcePath => admin.post('/api/users/import-sillytavern/extensions', { sourcePath });
    const extensionRoot = path.join(sourceBase, 'data', 'only-user', 'extensions');

    test('replaces the third-party extensions and reports the state of each one', async () => {
        writeTree(path.join(sourceBase, 'data'), {
            'cookie-secret.txt': 'not a user folder',
            '_storage/item': 'not a user folder',
        });
        writeTree(extensionRoot, {
            'ready/manifest.json': JSON.stringify({ display_name: ' Ready Extension ', version: '1.2.3', author: 'Tester', js: ' index.js ' }),
            'ready/index.js': 'export {};',
            'ready/nested/data.txt': 'data',
            'checkout/manifest.json': JSON.stringify({ js: 'index.js' }),
            'checkout/index.js': 'export {};',
            'checkout/.git/HEAD': 'ref',
            'no-manifest/index.js': 'export {};',
            'bad-manifest/manifest.json': 'not json',
            'no-entry/manifest.json': JSON.stringify({ display_name: '  ' }),
            'lost-entry/manifest.json': JSON.stringify({ js: 'missing.js' }),
            '.hidden/manifest.json': '{}',
            'a-file.txt': 'not an extension',
        });
        writeTree(targetRoot, { 'extensions/ready/stale.txt': 'stale', 'extensions/kept/manifest.json': '{}' });

        const { status, body } = await readReply(await syncExtensions(path.join(sourceBase, 'data')));

        expect(status).toBe(200);
        expect(body).toMatchObject({
            sourceRoot: path.join(sourceBase, 'data', 'only-user'),
            sourceExtensionsRoot: extensionRoot,
            targetExtensionsRoot: targetFile('extensions'),
            readyCount: 1,
            warningCount: 5,
            failedCount: 0,
            gitMetadataSkippedCount: 1,
            message: 'Synced 6 third-party extensions. 5 need attention. Review the sync report before reloading.',
        });
        const resultByName = Object.fromEntries(body.results.map(result => [result.name, result]));
        expect(body.results.map(result => result.name)).toEqual(['bad-manifest', 'checkout', 'lost-entry', 'no-entry', 'no-manifest', 'ready']);
        expect(resultByName.ready).toMatchObject({
            displayName: 'Ready Extension',
            version: '1.2.3',
            author: 'Tester',
            sourcePath: path.join(extensionRoot, 'ready'),
            targetPath: targetFile('extensions', 'ready'),
            status: 'ready',
            copiedFiles: 3,
            warnings: [],
            checks: { manifestFound: true, manifestValid: true, jsEntry: 'index.js', jsEntryExists: true, gitMetadataSkipped: false },
        });
        expect(resultByName.checkout).toMatchObject({ status: 'warning', checks: { gitMetadataSkipped: true } });
        expect(resultByName['no-manifest']).toMatchObject({ status: 'warning', checks: { manifestFound: false } });
        expect(resultByName['bad-manifest']).toMatchObject({ status: 'warning', checks: { manifestFound: true, manifestValid: false } });
        expect(resultByName['no-entry']).toMatchObject({ status: 'warning', displayName: 'no-entry', checks: { jsEntry: '' } });
        expect(resultByName['lost-entry']).toMatchObject({ status: 'warning', checks: { jsEntry: 'missing.js', jsEntryExists: false } });
        expect(readTargetFile('extensions', 'ready', 'nested', 'data.txt')).toBe('data');
        expect(fs.existsSync(targetFile('extensions', 'ready', 'stale.txt'))).toBe(false);
        expect(fs.existsSync(targetFile('extensions', 'kept', 'manifest.json'))).toBe(true);
        expect(fs.existsSync(targetFile('extensions', 'checkout', '.git'))).toBe(false);
        expect(fs.existsSync(targetFile('extensions', '.hidden'))).toBe(false);
        expect(fs.readdirSync(targetFile('extensions')).filter(name => name.includes('-sync-'))).toEqual([]);
        expect(fs.existsSync(targetFile('settings.json'))).toBe(true);
    });

    test('reports a failed extension and still syncs the others', async () => {
        writeTree(extensionRoot, {
            'first/manifest.json': JSON.stringify({ js: 'index.js' }),
            'first/index.js': 'export {};',
            'second/manifest.json': JSON.stringify({ js: 'index.js' }),
            'second/index.js': 'export {};',
        });
        const copyFile = jest.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(new Error('copy failure'));

        const { status, body } = await readReply(await syncExtensions(sourceBase));
        copyFile.mockRestore();

        expect(status).toBe(200);
        expect(body).toMatchObject({
            readyCount: 1,
            failedCount: 1,
            message: 'Synced 1 third-party extension. 1 failed. Review the sync report before reloading.',
        });
        expect(body.results[0]).toMatchObject({ name: 'first', status: 'failed', copiedFiles: 0, error: 'copy failure' });
        expect(body.results[1]).toMatchObject({ name: 'second', status: 'ready' });
        expect(fs.existsSync(targetFile('extensions', 'second', 'index.js'))).toBe(true);
        expect(fs.readdirSync(targetFile('extensions')).filter(name => name.includes('-sync-'))).toEqual([]);
    });

    test('answers 400 for a source folder without an extensions folder', async () => {
        writeTree(sourceBase, { 'settings.json': '{}' });

        const reply = await readReply(await syncExtensions(sourceBase));

        expect(reply).toEqual({ status: 400, body: { error: 'No third-party extensions folder was found in that SillyTavern account.' } });
    });
});

describe('POST /api/users/import-sillytavern/zip', () => {
    const importZip = async entries => admin.upload('/api/users/import-sillytavern/zip', 'backup.zip', await createZip(entries));
    const uploads = path.join(harness.dataRoot, UPLOADS_DIRECTORY);

    test('imports the default user from a backup ZIP and removes the upload', async () => {
        writeTree(targetRoot, EXISTING_METADATA);

        const response = await importZip({
            ...underFolder('backup/default-user', {
                'settings.json': '{"imported":true}',
                'characters/': '',
                'characters/Ada.png': 'card',
                'chats/Ada/first.jsonl': '{}',
                'notes.txt': 'not account data',
                ...IMPORTED_METADATA,
            }),
            ...underFolder('backup/user-with-a-longer-name', {
                'settings.json': '{"imported":"other"}',
                'characters/': '',
                'characters/Other.png': 'other card',
                'chats/Other/other.jsonl': '{}',
                ...IMPORTED_METADATA,
            }),
        });

        const { status, body } = await readReply(response);

        expect(status).toBe(200);
        expect(body.importedFiles).toBe(5);
        expect(body.message).toContain('Imported 5 files');
        expect(readTargetJson('settings.json')).toEqual({ imported: true });
        expect(readTargetFile('characters', 'Ada.png')).toBe('card');
        expect(readTargetFile('chats', 'Ada', 'first.jsonl')).toBe('{}');
        expect(fs.existsSync(targetFile('characters', 'Other.png'))).toBe(false);
        expect(fs.existsSync(targetFile('notes.txt'))).toBe(false);
        expectMergedMetadata();
        expect(await contentsOnceEmpty(uploads)).toEqual([]);
    });

    test('imports the folder with the most account files and ignores __MACOSX entries', async () => {
        const response = await importZip({
            'small/other-user/settings.json': '{"imported":"small"}',
            ...underFolder('large/other-user', {
                'settings.json': '{"imported":"large"}',
                'characters/Other.png': 'other card',
            }),
            ...underFolder('__MACOSX/large/other-user', {
                'settings.json': 'resource fork',
                'characters/Other.png': 'resource fork',
                'chats/Other/other.jsonl': 'resource fork',
            }),
        });

        const { status, body } = await readReply(response);

        expect(status).toBe(200);
        expect(body.importedFiles).toBe(2);
        expect(readTargetJson('settings.json')).toEqual({ imported: 'large' });
        expect(readTargetFile('characters', 'Other.png')).toBe('other card');
        expect(fs.existsSync(targetFile('chats', 'Other'))).toBe(false);
    });

    test('skips corrupt metadata files and adds the missing default content', async () => {
        const response = await importZip({ 'characters/Ada.png': 'card', ...CORRUPT_METADATA });

        const { status, body } = await readReply(response);

        expect(status).toBe(200);
        expect(body.importedFiles).toBe(1);
        expect(readTargetFile('characters', 'Ada.png')).toBe('card');
        expect(fs.existsSync(targetFile('settings.json'))).toBe(true);
        expectNoImportedMetadata();
    });

    test('answers 400 without an uploaded file', async () => {
        const reply = await readReply(await admin.post('/api/users/import-sillytavern/zip'));

        expect(reply).toEqual({ status: 400, body: { error: 'A SillyTavern backup ZIP is required.' } });
    });
});
