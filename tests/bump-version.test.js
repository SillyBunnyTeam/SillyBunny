import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { bumpVersion, findVersionMismatches, normalizeVersion, readVersions, VERSION_SOURCES } from '../scripts/bump-version.js';

const repoRoot = path.resolve(process.cwd(), '..');

describe('bump-version', () => {
    test('every hardcoded version copy matches package.json', () => {
        expect(findVersionMismatches(repoRoot)).toEqual([]);
        expect(readVersions(repoRoot)).toHaveLength(3 + VERSION_SOURCES.length);
    });

    test('normalizes a leading v and rejects non-semver input', () => {
        expect(normalizeVersion('v2.0.0')).toBe('2.0.0');
        expect(normalizeVersion('2.0.0-rc.1')).toBe('2.0.0-rc.1');
        expect(() => normalizeVersion('2.0')).toThrow('Invalid version');
        expect(() => normalizeVersion('')).toThrow('Invalid version');
    });

    describe('on a copy of the repo files', () => {
        let directory;

        beforeEach(() => {
            directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bump-version-'));
            const files = new Set(['package.json', 'package-lock.json', ...VERSION_SOURCES.map(source => source.file)]);
            for (const file of files) {
                fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
                fs.copyFileSync(path.join(repoRoot, file), path.join(directory, file));
            }
        });

        afterEach(() => {
            fs.rmSync(directory, { recursive: true, force: true });
        });

        test('rewrites every copy and touches nothing else in the lockfile', () => {
            const lockBefore = fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8');
            const previous = readVersions(directory)[0].version;

            expect(bumpVersion('v9.8.7-rc.2', { repoRoot: directory })).toEqual(expect.arrayContaining(['package.json', 'package-lock.json', 'public/script.js', 'src/endpoints/horde.js']));
            expect(readVersions(directory).every(entry => entry.version === '9.8.7-rc.2')).toBe(true);

            const lockAfter = fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8');
            expect(lockAfter.split('\n').length).toBe(lockBefore.split('\n').length);
            expect(lockAfter.replaceAll('"version": "9.8.7-rc.2"', `"version": "${previous}"`)).toBe(lockBefore);
        });

        test('dry run reports changes without writing', () => {
            const before = fs.readFileSync(path.join(directory, 'package.json'), 'utf8');
            expect(bumpVersion('9.8.7', { repoRoot: directory, dryRun: true })).toContain('package.json');
            expect(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).toBe(before);
        });

        test('fails loudly when a version copy can no longer be found', () => {
            const file = path.join(directory, 'src/endpoints/horde.js');
            fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/'SillyBunny:[^']+'/, '\'renamed\''));
            expect(() => bumpVersion('9.8.7', { repoRoot: directory })).toThrow('src/endpoints/horde.js');
            expect(findVersionMismatches(directory).map(entry => entry.file)).toEqual(['src/endpoints/horde.js']);
        });
    });
});
