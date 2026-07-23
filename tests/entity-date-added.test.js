import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    createEntityDateAdded,
    ENTITY_DATE_ADDED_FILE,
    ensureEntityDateAdded,
    importEntityDateAdded,
    prepareEntityDateAddedMove,
    reconcileEntityDateAdded,
    removeEntityDateAdded,
} from '../src/entity-date-added.js';

const tempDirectories = [];

function createUserRoot() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-date-added-'));
    tempDirectories.push(directory);
    return directory;
}

afterEach(() => {
    jest.restoreAllMocks();
    for (const directory of tempDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('entity date added metadata', () => {
    test('migrates filesystem timestamps once and preserves them across later saves', () => {
        const userRoot = createUserRoot();
        const migrated = reconcileEntityDateAdded(userRoot, 'characters', [
            { id: 'Alice.png', fallback: 1_000 },
        ], 5_000);

        expect(migrated.get('Alice.png')).toBe(1_000);
        expect(ensureEntityDateAdded(userRoot, 'characters', 'Alice.png', 9_000, 10_000)).toBe(1_000);
        expect(reconcileEntityDateAdded(userRoot, 'characters', [
            { id: 'Alice.png', fallback: 12_000 },
        ], 15_000).get('Alice.png')).toBe(1_000);
    });

    test('uses discovery time for files first seen after migration', () => {
        const userRoot = createUserRoot();
        reconcileEntityDateAdded(userRoot, 'characters', [
            { id: 'Alice.png', fallback: 1_000 },
        ], 5_000);

        const dates = reconcileEntityDateAdded(userRoot, 'characters', [
            { id: 'Alice.png', fallback: 6_000 },
            { id: 'Bob.png', fallback: 2_000 },
        ], 7_000);

        expect(dates.get('Alice.png')).toBe(1_000);
        expect(dates.get('Bob.png')).toBe(7_000);
    });

    test('preserves timestamps across renames and resets them after deletion', () => {
        const userRoot = createUserRoot();
        reconcileEntityDateAdded(userRoot, 'characters', [
            { id: 'Alice.png', fallback: 1_000 },
        ], 5_000);

        expect(prepareEntityDateAddedMove(userRoot, 'characters', 'Alice.png', 'Alicia.png', 6_000, 7_000)).toBe(1_000);
        removeEntityDateAdded(userRoot, 'characters', 'Alice.png', 7_000);
        expect(reconcileEntityDateAdded(userRoot, 'characters', [
            { id: 'Alicia.png', fallback: 8_000 },
        ], 9_000).get('Alicia.png')).toBe(1_000);

        removeEntityDateAdded(userRoot, 'characters', 'Alicia.png');
        expect(ensureEntityDateAdded(userRoot, 'characters', 'Alicia.png', 10_000, 11_000)).toBe(11_000);
    });

    test('tracks character and group dates independently', () => {
        const userRoot = createUserRoot();

        reconcileEntityDateAdded(userRoot, 'characters', [{ id: 'Shared', fallback: 1_000 }], 3_000);
        reconcileEntityDateAdded(userRoot, 'groups', [{ id: 'Shared', fallback: 2_000 }], 4_000);

        expect(ensureEntityDateAdded(userRoot, 'characters', 'Shared', 5_000, 6_000)).toBe(1_000);
        expect(ensureEntityDateAdded(userRoot, 'groups', 'Shared', 7_000, 8_000)).toBe(2_000);
    });

    test('retains unseen identities until an explicit lifecycle deletion', () => {
        const userRoot = createUserRoot();
        reconcileEntityDateAdded(userRoot, 'characters', [{ id: 'Alice.png', fallback: 1_000 }], 2_000);

        reconcileEntityDateAdded(userRoot, 'characters', [], 3_000);

        expect(ensureEntityDateAdded(userRoot, 'characters', 'Alice.png', 4_000, 5_000)).toBe(1_000);
    });

    test('does not resurrect a deleted identity from a stale directory snapshot', () => {
        const userRoot = createUserRoot();
        reconcileEntityDateAdded(userRoot, 'characters', [{ id: 'Alice.png', fallback: 1_000 }], 2_000);

        removeEntityDateAdded(userRoot, 'characters', 'Alice.png', 3_000);
        const staleDates = reconcileEntityDateAdded(userRoot, 'characters', [
            { id: 'Alice.png', fallback: 1_000 },
        ], 4_000);

        expect(staleDates.has('Alice.png')).toBe(false);
        expect(createEntityDateAdded(userRoot, 'characters', 'Alice.png', 5_000)).toBe(5_000);
    });

    test('merges imported metadata without dropping concurrent local entries', () => {
        const userRoot = createUserRoot();
        reconcileEntityDateAdded(userRoot, 'characters', [{ id: 'Local.png', fallback: 1_000 }], 2_000);

        importEntityDateAdded(userRoot, {
            version: 1,
            characters: {
                initialized: true,
                entries: { 'Imported.png': 3_000 },
                deleted: {},
            },
            groups: {
                initialized: false,
                entries: {},
                deleted: {},
            },
        });

        const dates = reconcileEntityDateAdded(userRoot, 'characters', [
            { id: 'Local.png', fallback: 4_000 },
            { id: 'Imported.png', fallback: 5_000 },
        ], 6_000);
        expect(dates.get('Local.png')).toBe(1_000);
        expect(dates.get('Imported.png')).toBe(3_000);
    });

    test('recovers a stale interprocess lock', () => {
        const userRoot = createUserRoot();
        const lockPath = path.join(userRoot, `${ENTITY_DATE_ADDED_FILE}.lock`);
        fs.mkdirSync(lockPath);
        const staleTime = new Date(Date.now() - 60_000);
        fs.utimesSync(lockPath, staleTime, staleTime);

        expect(createEntityDateAdded(userRoot, 'characters', 'Alice.png', 1_000)).toBe(1_000);
        expect(fs.existsSync(lockPath)).toBe(false);
    });

    test('serializes updates from separate processes', async () => {
        const userRoot = createUserRoot();
        const moduleUrl = new URL('../src/entity-date-added.js', import.meta.url).href;
        reconcileEntityDateAdded(userRoot, 'characters', [], 1_000);

        await Promise.all([
            runChild(`import { ensureEntityDateAdded } from ${JSON.stringify(moduleUrl)}; ensureEntityDateAdded(${JSON.stringify(userRoot)}, 'characters', 'Alice.png', 2_000, 2_000);`),
            runChild(`import { ensureEntityDateAdded } from ${JSON.stringify(moduleUrl)}; ensureEntityDateAdded(${JSON.stringify(userRoot)}, 'characters', 'Bob.png', 3_000, 3_000);`),
        ]);

        const dates = reconcileEntityDateAdded(userRoot, 'characters', [
            { id: 'Alice.png', fallback: 4_000 },
            { id: 'Bob.png', fallback: 5_000 },
        ], 6_000);
        expect(dates.get('Alice.png')).toBe(2_000);
        expect(dates.get('Bob.png')).toBe(3_000);
    });

    test('backs up corrupt metadata before rebuilding it', () => {
        const userRoot = createUserRoot();
        fs.writeFileSync(path.join(userRoot, ENTITY_DATE_ADDED_FILE), '{not json');
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const dates = reconcileEntityDateAdded(userRoot, 'characters', [
            { id: 'Alice.png', fallback: 1_000 },
        ], 2_000);

        expect(dates.get('Alice.png')).toBe(1_000);
        expect(fs.readdirSync(userRoot).some(file => file.startsWith(`${ENTITY_DATE_ADDED_FILE}.corrupt-`))).toBe(true);
        expect(() => JSON.parse(fs.readFileSync(path.join(userRoot, ENTITY_DATE_ADDED_FILE), 'utf8'))).not.toThrow();
    });
});

function runChild(script) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let errorOutput = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => errorOutput += chunk);
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(errorOutput || `Child exited with code ${code}.`)));
    });
}
