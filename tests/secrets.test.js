import { afterEach, describe, test, expect, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDirs = [];

async function importSecrets() {
    jest.resetModules();

    let idCounter = 0;
    await jest.unstable_mockModule('../src/util.js', () => ({
        color: {
            green: value => value,
            red: value => value,
        },
        getConfigValue: jest.fn(() => false),
        tryWriteFileSync: jest.fn((filePath, data) => fs.writeFileSync(filePath, data)),
        uuidv4: jest.fn(() => `secret-id-${++idCounter}`),
    }));

    return await import('../src/endpoints/secrets.js');
}

function createUserDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-secrets-'));
    const backups = path.join(root, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    tempDirs.push(root);
    return { root, backups };
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('secret helpers', () => {
    test('reads a non-active secret by id through the compatibility helper', async () => {
        const { SECRET_KEYS, SecretManager, readSecret } = await importSecrets();
        const directories = createUserDirectories();
        const manager = new SecretManager(directories);
        const firstId = manager.writeSecret(SECRET_KEYS.CUSTOM, 'first-key', 'first');
        const secondId = manager.writeSecret(SECRET_KEYS.CUSTOM, 'second-key', 'second');

        expect(readSecret(directories, SECRET_KEYS.CUSTOM)).toBe('second-key');
        expect(readSecret(directories, SECRET_KEYS.CUSTOM, firstId)).toBe('first-key');
        expect(readSecret(directories, SECRET_KEYS.CUSTOM, secondId)).toBe('second-key');
    });
});
