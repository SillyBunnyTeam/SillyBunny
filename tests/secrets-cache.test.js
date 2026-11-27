/* global globalThis */
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

describe('decrypted secrets stay in memory only while they save a key derivation', () => {
    const encryptedConfig = { 'encryptSecrets.enabled': true, 'encryptSecrets.passphrase': PASSPHRASE };
    const plainConfig = { 'encryptSecrets.enabled': false };

    afterEach(() => {
        jest.useRealTimers();
    });

    /** Fake timers that start long after the files that the test just wrote, so that a stamp of them is settled. */
    function startClockAfterWrites() {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'], now: Date.now() + 60_000 });
    }

    test('keeps nothing in memory and reads the file on every call when encryption is off', async () => {
        const { SECRET_KEYS, SECRETS_FILE, getSecretsCacheSize, readSecret, writeSecret } = await importSecrets(plainConfig);
        const directories = createUserDirectories();
        const filePath = path.join(directories.root, SECRETS_FILE);

        writeSecret(directories, SECRET_KEYS.CUSTOM, 'key-plain', 'label');
        startClockAfterWrites();
        const readSpy = jest.spyOn(fs, 'readFileSync');
        const statSpy = jest.spyOn(fs, 'statSync');

        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-plain');
        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-plain');

        expect(readSpy.mock.calls.filter(([target]) => target === filePath)).toHaveLength(2);
        expect(statSpy.mock.calls.filter(([target]) => target === filePath)).toHaveLength(0);
        expect(getSecretsCacheSize()).toBe(0);
    });

    test('caches a decrypted file and drops the plaintext after the time to live, with no further read', async () => {
        const { SECRET_KEYS, SECRETS_CACHE_TTL_MS, SECRETS_FILE, getSecretsCacheSize, readSecret, writeSecret } = await importSecrets(encryptedConfig);
        const directories = createUserDirectories();
        const filePath = path.join(directories.root, SECRETS_FILE);

        writeSecret(directories, SECRET_KEYS.CUSTOM, 'key-secret', 'label');
        startClockAfterWrites();
        const readSpy = jest.spyOn(fs, 'readFileSync');
        const fileReads = () => readSpy.mock.calls.filter(([target]) => target === filePath).length;

        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-secret');
        expect(getSecretsCacheSize()).toBe(1);
        expect(fileReads()).toBe(1);

        jest.advanceTimersByTime(SECRETS_CACHE_TTL_MS - 1);
        expect(getSecretsCacheSize()).toBe(1);
        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-secret');
        expect(fileReads()).toBe(1);

        // A hit does not extend the life of the entry.
        jest.advanceTimersByTime(1);
        expect(getSecretsCacheSize()).toBe(0);

        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-secret');
        expect(fileReads()).toBe(2);
        expect(getSecretsCacheSize()).toBe(1);
    });

    test('does not serve an entry whose time to live ran out even when its timer is late', async () => {
        const { SECRET_KEYS, SECRETS_CACHE_TTL_MS, SECRETS_FILE, readSecret, writeSecret } = await importSecrets(encryptedConfig);
        const directories = createUserDirectories();
        const filePath = path.join(directories.root, SECRETS_FILE);

        writeSecret(directories, SECRET_KEYS.CUSTOM, 'key-secret', 'label');
        startClockAfterWrites();
        const readSpy = jest.spyOn(fs, 'readFileSync');
        readSecret(directories, SECRET_KEYS.CUSTOM);

        jest.setSystemTime(Date.now() + SECRETS_CACHE_TTL_MS + 1);
        readSecret(directories, SECRET_KEYS.CUSTOM);
        expect(readSpy.mock.calls.filter(([target]) => target === filePath)).toHaveLength(2);
    });

    test('a timer of the cache does not keep the process alive', async () => {
        const { SECRET_KEYS, SECRETS_FILE, readSecret, writeSecret } = await importSecrets(encryptedConfig);
        const directories = createUserDirectories();
        writeSecret(directories, SECRET_KEYS.CUSTOM, 'key-secret', 'label');
        fs.utimesSync(path.join(directories.root, SECRETS_FILE), OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);
        await sleep(RACY_WINDOW_MS + 20);

        const unref = jest.fn();
        const realSetTimeout = globalThis.setTimeout;
        jest.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
            const timer = realSetTimeout(...args);
            timer.unref = () => {
                unref();
                return timer;
            };
            return timer;
        });
        readSecret(directories, SECRET_KEYS.CUSTOM);
        expect(unref).toHaveBeenCalled();
    });

    test('a read after a write returns the new value, and a changed passphrase does not serve the old plaintext', async () => {
        const config = { ...encryptedConfig };
        const { SECRET_KEYS, SECRETS_FILE, readSecret, writeSecret } = await importSecrets(config);
        const directories = createUserDirectories();
        const filePath = path.join(directories.root, SECRETS_FILE);

        writeSecret(directories, SECRET_KEYS.CUSTOM, 'key-one', 'label');
        fs.utimesSync(filePath, OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);
        await sleep(RACY_WINDOW_MS + 20);
        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-one');

        writeSecret(directories, SECRET_KEYS.CUSTOM, 'key-two', 'label');
        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-two');

        fs.utimesSync(filePath, OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);
        await sleep(RACY_WINDOW_MS + 20);
        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-two');
        config['encryptSecrets.passphrase'] = 'another-passphrase';
        expect(() => readSecret(directories, SECRET_KEYS.CUSTOM)).toThrow();
    });

    test('hands out a copy, so a change of the returned secrets does not reach the cache', async () => {
        const { SECRET_KEYS, SECRETS_FILE, SecretManager, readSecret, writeSecret } = await importSecrets(encryptedConfig);
        const directories = createUserDirectories();
        writeSecret(directories, SECRET_KEYS.CUSTOM, 'key-secret', 'label');
        fs.utimesSync(path.join(directories.root, SECRETS_FILE), OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);
        await sleep(RACY_WINDOW_MS + 20);

        const manager = new SecretManager(directories);
        manager._readSecretsFile()[SECRET_KEYS.CUSTOM][0].value = 'mutated-in-caller';
        manager._readSecretsFile()[SECRET_KEYS.CUSTOM][0].value = 'mutated-again';

        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('key-secret');
    });

    test('keeps the secrets of two users apart', async () => {
        const { SECRET_KEYS, SECRETS_FILE, readSecret, writeSecret } = await importSecrets(encryptedConfig);
        const first = createUserDirectories();
        const second = createUserDirectories();

        writeSecret(first, SECRET_KEYS.CUSTOM, 'key-first', 'label');
        writeSecret(second, SECRET_KEYS.CUSTOM, 'key-second', 'label');
        for (const directories of [first, second]) {
            fs.utimesSync(path.join(directories.root, SECRETS_FILE), OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);
        }
        await sleep(RACY_WINDOW_MS + 20);

        for (let round = 0; round < 2; round++) {
            expect(readSecret(first, SECRET_KEYS.CUSTOM)).toBe('key-first');
            expect(readSecret(second, SECRET_KEYS.CUSTOM)).toBe('key-second');
        }
    });
});
