import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RACY_WINDOW_MS } from '../src/file-stamp.js';

const tempDirs = [];
const PASSPHRASE = 'stamp-test-passphrase';
const OLD_MTIME_SECONDS = 1_700_000_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Loads the secrets module against a fake config, so that encryption can be switched on for a test.
 * @param {Record<string, unknown>} config Config values by key
 */
async function importSecrets(config) {
    jest.resetModules();

    let idCounter = 0;
    await jest.unstable_mockModule('../src/util.js', () => ({
        color: {
            green: value => value,
            red: value => value,
        },
        getConfigValue: jest.fn((key, defaultValue) => (key in config ? config[key] : defaultValue)),
        tryWriteFileSync: jest.fn((filePath, data) => fs.writeFileSync(filePath, data)),
        uuidv4: jest.fn(() => `secret-id-${++idCounter}`),
    }));

    const secrets = await import('../src/endpoints/secrets.js');
    const encryption = await import('../src/encryption.js');
    return { ...secrets, ...encryption };
}

function createUserDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-secrets-cache-'));
    fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
    tempDirs.push(root);
    return { root, backups: path.join(root, 'backups') };
}

afterEach(() => {
    jest.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('secrets cache validation', () => {
    const encryptedConfig = { 'encryptSecrets.enabled': true, 'encryptSecrets.passphrase': PASSPHRASE };

    test('reads a same-size encrypted rewrite that keeps the old mtime', async () => {
        const { SECRET_KEYS, SECRETS_FILE, encrypt, readSecret, writeSecret } = await importSecrets(encryptedConfig);
        const directories = createUserDirectories();
        const filePath = path.join(directories.root, SECRETS_FILE);

        writeSecret(directories, SECRET_KEYS.CUSTOM, 'key-AAAA', 'label');
        fs.utimesSync(filePath, OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);
        await sleep(RACY_WINDOW_MS + 20);
        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-AAAA');

        const current = JSON.parse(await import('../src/encryption.js').then(({ decrypt }) => decrypt(fs.readFileSync(filePath), PASSPHRASE)));
        current[SECRET_KEYS.CUSTOM][0].value = 'key-BBBB';
        const replacement = encrypt(JSON.stringify(current, null, 4), PASSPHRASE);
        expect(replacement.length).toBe(fs.statSync(filePath).size);
        fs.writeFileSync(filePath, replacement);
        fs.utimesSync(filePath, OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);

        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-BBBB');
    });

    test('serves an unchanged, settled encrypted file from the cache without reading or decrypting it again', async () => {
        const { SECRET_KEYS, SECRETS_FILE, readSecret, writeSecret } = await importSecrets(encryptedConfig);
        const directories = createUserDirectories();
        const filePath = path.join(directories.root, SECRETS_FILE);

        writeSecret(directories, SECRET_KEYS.CUSTOM, 'key-AAAA', 'label');
        fs.utimesSync(filePath, OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);
        await sleep(RACY_WINDOW_MS + 20);
        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-AAAA');

        const readSpy = jest.spyOn(fs, 'readFileSync');
        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-AAAA');
        expect(readSpy).not.toHaveBeenCalled();
    });
});
