/* global globalThis */
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import storage from 'node-persist';

import { setConfigFilePath } from '../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
const originalDataRoot = globalThis.DATA_ROOT;
const diskCacheEnvironmentKey = 'SILLYTAVERN_PERFORMANCE_USEDISKCACHE';
const originalDiskCacheSetting = process.env[diskCacheEnvironmentKey];
process.env[diskCacheEnvironmentKey] = 'true';
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { diskCache } = await import('../src/endpoints/characters.js');
const { getUserDirectories, getUserDirectoriesList, initUserStorage, toKey } = await import('../src/users.js');

const FIRST_USER = 'default-user';
const SECOND_USER = 'second-user';

describe('character disk cache', () => {
    const intervalCallbacks = [];
    let cache;
    let tempRoot;

    beforeAll(async () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-character-disk-cache-'));
        globalThis.DATA_ROOT = tempRoot;
        jest.spyOn(console, 'log').mockImplementation(() => {});
        await initUserStorage(tempRoot);
        await storage.setItem(toKey(SECOND_USER), { handle: SECOND_USER });

        const setIntervalSpy = jest.spyOn(globalThis, 'setInterval').mockImplementation(callback => {
            intervalCallbacks.push(callback);
            return { ref() {}, unref() {} };
        });
        cache = await diskCache.instance();
        setIntervalSpy.mockRestore();
    });

    beforeEach(async () => {
        await cache.clear();
        diskCache.syncQueue.clear();
        for (const handle of [FIRST_USER, SECOND_USER]) {
            const { characters } = getUserDirectories(handle);
            fs.rmSync(characters, { recursive: true, force: true });
            fs.mkdirSync(characters, { recursive: true });
        }
    });

    afterAll(() => {
        diskCache.dispose();
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
        globalThis.DATA_ROOT = originalDataRoot;
        if (originalDiskCacheSetting === undefined) {
            delete process.env[diskCacheEnvironmentKey];
        } else {
            process.env[diskCacheEnvironmentKey] = originalDiskCacheSetting;
        }
        process.chdir(originalWorkingDirectory);
    });

    test('verify deletes entries for edited and deleted cards', async () => {
        const { characters } = getUserDirectories(FIRST_USER);
        const cardPath = writeCard(characters, 'Alice.png');
        await cache.setItem(currentCacheKey(cardPath), 'current');
        await cache.setItem(`${cardPath}-1`, 'before edit');
        await cache.setItem(`${path.join(characters, 'Deleted.png')}-1`, 'deleted card');

        await diskCache.verify(await getUserDirectoriesList());

        expect(await cache.getItem(currentCacheKey(cardPath))).toBe('current');
        expect(fs.readdirSync(diskCache.cachePath)).toHaveLength(1);
    });

    test('the periodic sync keeps cache entries that belong to other users', async () => {
        const firstCard = writeCard(getUserDirectories(FIRST_USER).characters, 'Alice.png');
        const secondCard = writeCard(getUserDirectories(SECOND_USER).characters, 'Bob.png');
        await cache.setItem(currentCacheKey(firstCard), 'alice');
        await cache.setItem(`${firstCard}-1`, 'alice before edit');
        await cache.setItem(currentCacheKey(secondCard), 'bob');

        diskCache.syncQueue.add(FIRST_USER);
        await Promise.all(intervalCallbacks.map(callback => callback()));

        expect(await cache.getItem(currentCacheKey(firstCard))).toBe('alice');
        expect(await cache.getItem(currentCacheKey(secondCard))).toBe('bob');
        expect(fs.readdirSync(diskCache.cachePath)).toHaveLength(2);
    });
});

function writeCard(directory, fileName) {
    const filePath = path.join(directory, fileName);
    fs.writeFileSync(filePath, 'card');
    return filePath;
}

function currentCacheKey(cardPath) {
    return `${cardPath}-${fs.statSync(cardPath).mtimeMs}`;
}
