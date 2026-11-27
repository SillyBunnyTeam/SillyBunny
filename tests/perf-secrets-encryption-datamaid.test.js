import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SETTINGS_FILE, USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { decrypt, encrypt } from '../src/encryption.js';
import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

describe('encryption scrypt maxmem parity and bounded secrets cache', () => {
    let tempDir = '';

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perf-secrets-'));
    });

    afterAll(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('SCRYPT_OPTIONS includes maxmem >= 64 MiB and encrypt()/decrypt() round-trip cleanly', () => {
        const encryptionSource = fs.readFileSync(path.join(repoRoot, 'src', 'encryption.js'), 'utf8');
        expect(encryptionSource).toMatch(/maxmem:\s*64\s*\*\s*1024\s*\*\s*1024/);
        const secretPayload = JSON.stringify({ api_key_openai: [{ id: '1', value: 'sk-test-secret-1234' }] });
        const encrypted = encrypt(secretPayload, 'unit-test-passphrase');
        expect(Buffer.isBuffer(encrypted)).toBe(true);
        expect(encrypted.toString('utf8')).not.toContain('sk-test-secret-1234');
        expect(decrypt(encrypted, 'unit-test-passphrase')).toBe(secretPayload);
    });

    test('SecretManager reads a plaintext secrets file on every call, keeps nothing in memory, and shows a write at once', async () => {
        const { SecretManager, clearSecretsCache, getSecretsCacheSize, readSecret, writeSecret } = await import('../src/endpoints/secrets.js');
        clearSecretsCache();

        const userDir = path.join(tempDir, 'user-secrets');
        fs.mkdirSync(userDir, { recursive: true });
        const directories = { root: userDir };

        writeSecret(directories, 'api_key_openai', 'sk-plain-first', 'primary');
        const secretsPath = path.join(userDir, 'secrets.json');
        const readSpy = jest.spyOn(fs, 'readFileSync');
        const secretsReads = () => readSpy.mock.calls.filter(([target]) => target === secretsPath).length;

        try {
            expect(readSecret(directories, 'api_key_openai')).toBe('sk-plain-first');
            expect(readSecret(directories, 'api_key_openai')).toBe('sk-plain-first');
            expect(secretsReads()).toBe(2);
            expect(getSecretsCacheSize()).toBe(0);

            // A change of the returned object does not reach the next read.
            const manager = new SecretManager(directories);
            const rawObject = manager._readSecretsFile();
            rawObject.api_key_openai[0].value = 'mutated-in-caller';
            expect(readSecret(directories, 'api_key_openai')).toBe('sk-plain-first');

            writeSecret(directories, 'api_key_openai', 'sk-updated-second', 'primary');
            expect(readSecret(directories, 'api_key_openai')).toBe('sk-updated-second');
        } finally {
            readSpy.mockRestore();
            clearSecretsCache();
        }
    });
});

describe('Data Maid single-pass scan, Conversation Mode media protection, and mobile thumbnails', () => {
    let tempDir = '';
    let DataMaidService;

    beforeAll(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perf-datamaid-'));
        ({ DataMaidService } = await import('../src/endpoints/data-maid.js'));
    });

    afterAll(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('protects Conversation Mode images, files, attachments, and group avatars while reporting real orphans and mobile thumbnails in a single chat scan', async () => {
        const userRoot = path.join(tempDir, 'user-dm');
        const directories = { root: userRoot };
        for (const [key, relative] of Object.entries(USER_DIRECTORY_TEMPLATE)) {
            directories[key] = path.join(userRoot, relative);
            fs.mkdirSync(directories[key], { recursive: true });
        }
        directories.backups = path.join(userRoot, 'backups');
        fs.mkdirSync(directories.backups, { recursive: true });

        // Regular chat referencing one image and one file.
        const charChatDir = path.join(directories.chats, 'Alice');
        fs.mkdirSync(charChatDir, { recursive: true });
        const chatPath = path.join(charChatDir, 'session1.jsonl');
        fs.writeFileSync(chatPath, [
            JSON.stringify({ user_name: 'User', character_name: 'Alice', chat_metadata: { attachments: [{ url: '/user/files/chat-meta.txt' }] } }),
            JSON.stringify({ mes: 'hi', extra: { image: '/user/images/Alice/rp-image.png', file: { url: '/user/files/rp-file.txt' } } }),
        ].join('\n') + '\n');

        // Create user images (RP + Conversation Mode + group avatar + true orphan).
        fs.mkdirSync(path.join(directories.userImages, 'Alice'), { recursive: true });
        fs.mkdirSync(path.join(directories.userImages, 'Conversation'), { recursive: true });
        fs.writeFileSync(path.join(directories.userImages, 'Alice', 'rp-image.png'), 'img');
        fs.writeFileSync(path.join(directories.userImages, 'Conversation', 'conv-msg.png'), 'img');
        fs.writeFileSync(path.join(directories.userImages, 'Conversation', 'conv-branch.png'), 'img');
        fs.writeFileSync(path.join(directories.userImages, 'Conversation', 'conv-group-avatar.png'), 'img');
        fs.writeFileSync(path.join(directories.userImages, 'Conversation', 'orphan-img.png'), 'img');

        // Create user files (RP + metadata + Conversation Mode + true orphan).
        fs.writeFileSync(path.join(directories.files, 'rp-file.txt'), 'f');
        fs.writeFileSync(path.join(directories.files, 'chat-meta.txt'), 'f');
        fs.writeFileSync(path.join(directories.files, 'conv-doc.pdf'), 'f');
        fs.writeFileSync(path.join(directories.files, 'conv-attach.md'), 'f');
        fs.writeFileSync(path.join(directories.files, 'orphan-file.txt'), 'f');

        // Create real character + persona + mobile/desktop thumbnails (kept + orphaned).
        fs.writeFileSync(path.join(directories.characters, 'Alice.png'), 'char');
        fs.writeFileSync(path.join(directories.avatars, 'PersonaA.png'), 'persona');
        fs.writeFileSync(path.join(directories.thumbnailsAvatar, 'Alice.png'), 't');
        fs.writeFileSync(path.join(directories.thumbnailsAvatarMobile, 'Alice.png'), 't');
        fs.writeFileSync(path.join(directories.thumbnailsAvatarMobile, 'GhostChar.png'), 't');
        fs.writeFileSync(path.join(directories.thumbnailsPersona, 'PersonaA.png'), 't');
        fs.writeFileSync(path.join(directories.thumbnailsPersonaMobile, 'PersonaA.png'), 't');
        fs.writeFileSync(path.join(directories.thumbnailsPersonaMobile, 'GhostPersona.png'), 't');

        fs.writeFileSync(path.join(userRoot, SETTINGS_FILE), JSON.stringify({
            extension_settings: {
                sillybunny_conversation: {
                    groups: [
                        { id: 'grp-1', avatar_url: '/user/images/Conversation/conv-group-avatar.png' },
                    ],
                    characters: {
                        'Alice.png': {
                            messages: [
                                {
                                    text: 'hello',
                                    extra: {
                                        image_url: '/user/images/Conversation/conv-msg.png',
                                        file: { url: '/user/files/conv-doc.pdf' },
                                        attachments: [{ url: '/user/files/conv-attach.md' }],
                                    },
                                },
                            ],
                            branches: {
                                main: {
                                    messages: [
                                        {
                                            extra: {
                                                media: [{ url: '/user/images/Conversation/conv-branch.png' }],
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    },
                },
            },
        }));

        const streamSpy = jest.spyOn(fs, 'createReadStream');
        let report;
        try {
            report = await new DataMaidService('dm-perf-test', directories).generateReport();
        } finally {
            const chatStreamCalls = streamSpy.mock.calls.filter(args => String(args[0]) === chatPath);
            streamSpy.mockRestore();
            expect(chatStreamCalls).toHaveLength(1);
        }

        expect(report.images.map(p => path.basename(p))).toEqual(['orphan-img.png']);
        expect(report.files.map(p => path.basename(p))).toEqual(['orphan-file.txt']);
        expect(report.avatarThumbnails.map(p => path.basename(p))).toEqual(['GhostChar.png']);
        expect(report.personaThumbnails.map(p => path.basename(p))).toEqual(['GhostPersona.png']);
    });
});

describe('Data Maid reference scan fails closed', () => {
    const canBlockReads = typeof process.getuid === 'function' && process.getuid() !== 0 && process.platform !== 'win32';
    const describeWhenReadsCanBeBlocked = canBlockReads ? describe : describe.skip;
    let tempDir = '';
    let DataMaidService;
    let dataMaidRouter;
    const blockedPaths = [];

    beforeAll(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-datamaid-closed-'));
        ({ DataMaidService, router: dataMaidRouter } = await import('../src/endpoints/data-maid.js'));
    });

    afterEach(() => {
        for (const blocked of blockedPaths.splice(0)) {
            fs.chmodSync(blocked, 0o755);
        }
    });

    afterAll(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    /**
     * A user whose only chat names one image and one file, next to one loose image and one loose file.
     * @param {string} name Folder of the user under the temp directory
     */
    function createUser(name) {
        const root = path.join(tempDir, name);
        const directories = { root };
        for (const [key, relative] of Object.entries(USER_DIRECTORY_TEMPLATE)) {
            directories[key] = path.join(root, relative);
            fs.mkdirSync(directories[key], { recursive: true });
        }
        directories.backups = path.join(root, 'backups');
        fs.mkdirSync(directories.backups, { recursive: true });

        fs.mkdirSync(path.join(directories.chats, 'Alice'), { recursive: true });
        fs.writeFileSync(path.join(directories.characters, 'Alice.png'), 'char');
        const chatFile = path.join(directories.chats, 'Alice', 'session.jsonl');
        fs.writeFileSync(chatFile, [
            JSON.stringify({ user_name: 'User', character_name: 'Alice', chat_metadata: {} }),
            JSON.stringify({ mes: 'hi', extra: { image: '/user/images/used.png', file: { url: '/user/files/used.txt' } } }),
        ].join('\n') + '\n');
        fs.writeFileSync(path.join(directories.userImages, 'used.png'), 'img');
        fs.writeFileSync(path.join(directories.userImages, 'loose.png'), 'img');
        fs.writeFileSync(path.join(directories.files, 'used.txt'), 'f');
        fs.writeFileSync(path.join(directories.files, 'loose.txt'), 'f');
        return { directories, chatFile };
    }

    function blockAccess(target) {
        fs.chmodSync(target, 0o000);
        blockedPaths.push(target);
    }

    const baseNames = paths => paths.map(item => path.basename(item));

    test('a missing optional directory counts as empty, so the chat references still protect their files', async () => {
        const { directories } = createUser('missing-groups');
        fs.rmSync(directories.groups, { recursive: true, force: true });
        fs.rmSync(directories.groupChats, { recursive: true, force: true });

        const report = await new DataMaidService('closed-missing', directories).generateReport();

        expect(baseNames(report.images)).toEqual(['loose.png']);
        expect(baseNames(report.files)).toEqual(['loose.txt']);
    });

    test('a chat folder removed during the scan counts as empty', async () => {
        const { directories } = createUser('missing-chats');
        fs.rmSync(directories.chats, { recursive: true, force: true });

        const report = await new DataMaidService('closed-missing-chats', directories).generateReport();

        expect(baseNames(report.images).sort()).toEqual(['loose.png', 'used.png']);
    });

    test.each([
        ['groups', 'groups'],
        ['groupChats', 'group chats'],
        ['chats', 'chats'],
    ])('a %s directory that cannot be listed for a reason other than "missing" rejects the report', async (key) => {
        const { directories } = createUser(`not-a-directory-${key}`);
        fs.rmSync(directories[key], { recursive: true, force: true });
        fs.writeFileSync(directories[key], 'a file where the directory belongs');
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        try {
            await expect(new DataMaidService(`closed-${key}`, directories).generateReport()).rejects.toMatchObject({ code: 'ENOTDIR' });
        } finally {
            consoleSpy.mockRestore();
        }
    });

    describeWhenReadsCanBeBlocked('an unreadable path', () => {
        test('an unreadable chat folder rejects the report', async () => {
            const { directories } = createUser('blocked-folder');
            blockAccess(path.join(directories.chats, 'Alice'));

            await expect(new DataMaidService('closed-folder', directories).generateReport()).rejects.toMatchObject({ code: 'EACCES' });
        });

        test('an unreadable chat file rejects the report', async () => {
            const { directories, chatFile } = createUser('blocked-chat');
            blockAccess(chatFile);

            await expect(new DataMaidService('closed-chat', directories).generateReport()).rejects.toMatchObject({ code: 'EACCES' });
        });

        test('an unreadable group definition rejects the report', async () => {
            const { directories } = createUser('blocked-group');
            const groupFile = path.join(directories.groups, 'group.json');
            fs.writeFileSync(groupFile, JSON.stringify({ id: 'group', chats: [] }));
            blockAccess(groupFile);

            await expect(new DataMaidService('closed-group', directories).generateReport()).rejects.toMatchObject({ code: 'EACCES' });
        });

        test('an unreadable conversation chat rejects the report', async () => {
            const { directories } = createUser('blocked-conversation');
            const chatsDirectory = path.join(directories.conversations, 'conv_1700000000000_abcdef0123', 'chats');
            fs.mkdirSync(chatsDirectory, { recursive: true });
            const conversationChat = path.join(chatsDirectory, 'chat_1700000000000_abcdef0123.jsonl');
            fs.writeFileSync(conversationChat, JSON.stringify({ extra: { media: [{ url: '/user/images/used.png' }] } }) + '\n');
            blockAccess(conversationChat);

            await expect(new DataMaidService('closed-conversation', directories).generateReport()).rejects.toMatchObject({ code: 'EACCES' });
        });

        test('an unreadable settings.json rejects the report', async () => {
            const { directories } = createUser('blocked-settings');
            const settingsPath = path.join(directories.root, SETTINGS_FILE);
            fs.writeFileSync(settingsPath, JSON.stringify({ extension_settings: { attachments: [{ url: 'user/files/used.txt' }] } }));
            blockAccess(settingsPath);

            await expect(new DataMaidService('closed-settings', directories).generateReport()).rejects.toMatchObject({ code: 'EACCES' });
        });
    });

    describe('routes', () => {
        const handle = 'closed-routes';
        /** @type {import('node:http').Server} */
        let server;
        let baseUrl = '';
        let user;

        beforeAll(async () => {
            user = createUser('routes');
            const { default: express } = await import('express');
            const app = express();
            app.use(express.json());
            app.use((req, _res, next) => {
                req.user = { profile: { handle }, directories: user.directories };
                next();
            });
            app.use('/api/data-maid', dataMaidRouter);
            await new Promise(resolve => {
                server = app.listen(0, '127.0.0.1', resolve);
            });
            baseUrl = `http://127.0.0.1:${server.address().port}/api/data-maid`;
        });

        afterAll(async () => {
            server?.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        });

        const post = (route, body) => fetch(`${baseUrl}/${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
        });

        test('answers a failed scan with an error, no list of loose files and no deletable token', async () => {
            const groupsBackup = `${user.directories.groups}.moved`;
            fs.renameSync(user.directories.groups, groupsBackup);
            fs.writeFileSync(user.directories.groups, 'a file where the directory belongs');
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
            try {
                const response = await post('report');
                const text = await response.text();
                expect(response.status).toBe(500);
                expect(text).not.toMatch(/used|loose|token|report/i);
                expect([...DataMaidService.TOKENS.values()].some(entry => entry.handle === handle)).toBe(false);

                // A token that the failed scan never made must not delete anything.
                const deleteResponse = await post('delete', { token: 'a'.repeat(64), hashes: ['0'.repeat(64)] });
                expect(deleteResponse.status).toBe(403);
                expect(fs.existsSync(path.join(user.directories.userImages, 'used.png'))).toBe(true);
                expect(fs.existsSync(path.join(user.directories.files, 'used.txt'))).toBe(true);
            } finally {
                consoleSpy.mockRestore();
                fs.rmSync(user.directories.groups);
                fs.renameSync(groupsBackup, user.directories.groups);
            }
        });

        test('keeps the files that a chat names out of the report when the optional groups folder is missing', async () => {
            fs.rmSync(user.directories.groups, { recursive: true, force: true });
            const response = await post('report');
            expect(response.status).toBe(200);
            const { report, token } = await response.json();
            fs.mkdirSync(user.directories.groups, { recursive: true });

            expect(report.images.map(item => item.name)).toEqual(['loose.png']);
            expect(report.files.map(item => item.name)).toEqual(['loose.txt']);
            expect(typeof token).toBe('string');
        });
    });
});
