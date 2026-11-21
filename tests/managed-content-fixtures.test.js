/* eslint-disable playwright/no-standalone-expect -- Jest contracts for plain functions. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from '@jest/globals';
import extract from 'png-chunks-extract';

import { fingerprintCard, readManifest } from '../src/sillybunny-managed-content.js';
import { createPng } from './fixtures/managed-content/fixture-builder.js';
import { FIXTURE_ITEMS, generateFixtureContent } from './fixtures/managed-content/generate.js';

const committedDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'managed-content', 'content');
const temporaryRoots = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

/** Every file under a directory, by relative path. */
function readTree(directory, prefix = '') {
    return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => (entry.isDirectory()
        ? Object.entries(readTree(path.join(directory, entry.name), `${prefix}${entry.name}/`))
        : [[`${prefix}${entry.name}`, fs.readFileSync(path.join(directory, entry.name))]])));
}

describe('the managed content fixtures', () => {
    test('are what the generator writes, so nobody edited them by hand', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-managed-fixtures-'));
        temporaryRoots.push(directory);

        generateFixtureContent(directory);

        const generated = readTree(directory);
        const committed = readTree(committedDirectory);
        expect(Object.keys(committed).sort()).toEqual(Object.keys(generated).sort());
        for (const name of Object.keys(generated)) {
            expect([name, committed[name].equals(generated[name])]).toEqual([name, true]);
        }
    });

    test('have image data in stored blocks, so their bytes do not depend on the zlib of the runtime that generated them', () => {
        const [imageData] = extract(new Uint8Array(createPng(3))).filter(chunk => chunk.name === 'IDAT');

        // 0x78 0x01 is the zlib header of level 0; the first deflate block is final and stored (BFINAL 1, BTYPE 00).
        expect([...imageData.data.subarray(0, 3)]).toEqual([0x78, 0x01, 0x01]);
    });

    test('list every item in the manifest with the fingerprint of its file', () => {
        const manifest = readManifest(committedDirectory);

        expect(manifest.items.map(({ type, filename }) => ({ type, filename }))).toEqual(FIXTURE_ITEMS);
        for (const item of manifest.items.filter(({ type }) => type === 'character')) {
            expect(item.fingerprint).toBe(fingerprintCard(fs.readFileSync(path.join(committedDirectory, item.filename))));
        }
    });

    test('are not what the default index seeds: an item that ships under a fixture name is a different file', () => {
        const shipped = path.join(committedDirectory, '..', '..', '..', '..', 'default', 'content');
        const index = JSON.parse(fs.readFileSync(path.join(shipped, 'index.json'), 'utf8'));
        const readItem = file => (fs.statSync(file).isDirectory() ? readTree(file) : fs.readFileSync(file));

        for (const { filename } of FIXTURE_ITEMS.filter(item => index.some(entry => entry.filename === item.filename))) {
            expect([filename, fs.existsSync(path.join(shipped, filename))]).toEqual([filename, true]);
            expect([filename, readItem(path.join(shipped, filename))]).not.toEqual([filename, readItem(path.join(committedDirectory, filename))]);
        }
    });
});
