import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import storage from 'node-persist';
import yaml from 'yaml';

import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const { recoverPassword } = await import('../src/recover-password.js');
const { getPasswordHash, toKey } = await import('../src/users.js');

const HANDLE = 'locked-user';
const SALT = 'fixed-salt';

describe('recoverPassword', () => {
    const originalDataRoot = global.DATA_ROOT;
    let tempRoot;
    let configPath;
    let exit;

    beforeAll(() => {
        tempRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sillybunny-recover-password-'));
        configPath = path.join(tempRoot, 'config.yaml');
        fs.writeFileSync(configPath, yaml.stringify({ dataRoot: tempRoot }));
    });

    beforeEach(async () => {
        for (const method of ['info', 'warn', 'error', 'log']) {
            jest.spyOn(console, method).mockImplementation(() => {});
        }
        exit = jest.spyOn(process, 'exit').mockImplementation(code => {
            throw new Error(`process.exit(${code})`);
        });
        await storage.init({ dir: path.join(tempRoot, '_storage') });
        await storage.clear();
        await storage.setItem(toKey(HANDLE), {
            handle: HANDLE,
            name: 'Locked User',
            created: 1000,
            enabled: false,
            admin: false,
            salt: SALT,
            password: getPasswordHash('forgotten-secret', SALT),
        });
    });

    afterEach(() => {
        storage.stopWriteQueueInterval();
        jest.restoreAllMocks();
    });

    afterAll(() => {
        global.DATA_ROOT = originalDataRoot;
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
    });

    test('sets the new password and enables a disabled account', async () => {
        await recoverPassword(configPath, HANDLE, 'recovered-secret');

        const record = await storage.getItem(toKey(HANDLE));
        expect(record.enabled).toBe(true);
        expect(record.salt).not.toBe(SALT);
        expect(record.password).toBe(getPasswordHash('recovered-secret', record.salt));
        expect(exit).not.toHaveBeenCalled();
    });

    test('clears the password when no new password is given', async () => {
        await recoverPassword(configPath, HANDLE);

        const record = await storage.getItem(toKey(HANDLE));
        expect(record).toMatchObject({ enabled: true, password: '', salt: '' });
        expect(exit).not.toHaveBeenCalled();
    });

    test('exits with status 1 for an unknown account and writes nothing', async () => {
        const before = await storage.getItem(toKey(HANDLE));

        await expect(recoverPassword(configPath, 'no-such-user', 'recovered-secret')).rejects.toThrow('process.exit(1)');

        expect(exit).toHaveBeenCalledWith(1);
        expect(await storage.getItem(toKey('no-such-user'))).toBeUndefined();
        expect(await storage.getItem(toKey(HANDLE))).toEqual(before);
    });

    test('exits with status 1 when the config has no dataRoot', async () => {
        const noDataRootPath = path.join(tempRoot, 'no-data-root.yaml');
        fs.writeFileSync(noDataRootPath, yaml.stringify({ port: 8000 }));

        await expect(recoverPassword(noDataRootPath, HANDLE, 'recovered-secret')).rejects.toThrow('process.exit(1)');

        expect(exit).toHaveBeenCalledWith(1);
    });
});
