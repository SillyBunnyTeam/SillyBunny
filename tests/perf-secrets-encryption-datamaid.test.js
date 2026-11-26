import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
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

    test('SecretManager caches parsed secrets by file stat, returns isolated clones, and invalidates on write', async () => {
        const { SecretManager, clearSecretsCache, readSecret, writeSecret } = await import('../src/endpoints/secrets.js');
        clearSecretsCache();

        const userDir = path.join(tempDir, 'user-secrets');
        fs.mkdirSync(userDir, { recursive: true });
        const directories = { root: userDir };

        writeSecret(directories, 'api_key_openai', 'sk-cached-first', 'primary');
        const readSpy = jest.spyOn(fs, 'readFileSync');

        try {
            const first = readSecret(directories, 'api_key_openai');
            const readsAfterFirst = readSpy.mock.calls.length;
            expect(first).toBe('sk-cached-first');
            expect(readsAfterFirst).toBeGreaterThanOrEqual(1);

            // Second read hits cache without calling fs.readFileSync again.
            const second = readSecret(directories, 'api_key_openai');
            expect(second).toBe('sk-cached-first');
            expect(readSpy.mock.calls.length).toBe(readsAfterFirst);

            // Mutating a cloned secrets object returned by _readSecretsFile must not poison cache.
            const manager = new SecretManager(directories);
            const rawClone = manager._readSecretsFile();
            rawClone.api_key_openai[0].value = 'mutated-in-caller';
            expect(readSecret(directories, 'api_key_openai')).toBe('sk-cached-first');
            expect(readSpy.mock.calls.length).toBe(readsAfterFirst);

            // Writing invalidates the cache immediately.
            writeSecret(directories, 'api_key_openai', 'sk-updated-second', 'primary');
            const afterWrite = readSecret(directories, 'api_key_openai');
            expect(afterWrite).toBe('sk-updated-second');
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
