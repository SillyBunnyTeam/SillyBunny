/* eslint-disable playwright/no-standalone-expect -- Jest contracts for plain functions. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';

import { MANIFEST_FILE_NAME, fingerprintCard } from '../src/sillybunny-managed-content.js';
import { parseArguments, updateManagedManifest } from '../scripts/build-managed-manifest.js';
import { createCard, createCardFile, createSpriteFile } from './fixtures/managed-content/fixture-builder.js';

const REISEN = 'default_AssistantReisen.png';
const SPRITES = 'Assistant Reisen';
const temporaryRoots = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function makeBundle(version = 1) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-manifest-script-'));
    temporaryRoots.push(directory);
    fs.writeFileSync(path.join(directory, REISEN), createCardFile({ card: createCard({ character_version: String(version) }) }));
    fs.mkdirSync(path.join(directory, SPRITES));
    fs.writeFileSync(path.join(directory, SPRITES, 'joy.webp'), createSpriteFile(1));
    return directory;
}

const readManifestText = directory => fs.readFileSync(path.join(directory, MANIFEST_FILE_NAME), 'utf8');

describe('the manifest script', () => {
    test('reads the directory and the items from the command line', () => {
        expect(parseArguments(['content', `character:${REISEN}`, `sprites:${SPRITES}`])).toEqual({
            bundledDirectory: 'content',
            entries: [{ type: 'character', filename: REISEN }, { type: 'sprites', filename: SPRITES }],
        });
        expect(parseArguments(['content'])).toEqual({ bundledDirectory: 'content', entries: [] });
    });

    test.each([
        ['no directory', []],
        ['an item without a type', ['content', REISEN]],
        ['an item of an unknown type', ['content', 'theme:Dark.json']],
    ])('refuses %s', (_name, argv) => {
        expect(() => parseArguments(argv)).toThrow(/usage|type/i);
    });

    test('writes the manifest of the listed items, with the fingerprint of each', () => {
        const directory = makeBundle();

        const { changed } = updateManagedManifest({ bundledDirectory: directory, entries: [{ type: 'character', filename: REISEN }] });

        expect(changed).toBe(true);
        const manifest = JSON.parse(readManifestText(directory));
        expect(manifest.items).toEqual([{
            filename: REISEN,
            type: 'character',
            version: 1,
            fingerprint: fingerprintCard(fs.readFileSync(path.join(directory, REISEN))),
            previousFingerprints: [],
        }]);
        expect(readManifestText(directory).endsWith('}\n')).toBe(true);
    });

    test('keeps the items of the manifest that is there, and leaves the file as it is when nothing changed', () => {
        const directory = makeBundle();
        updateManagedManifest({ bundledDirectory: directory, entries: [{ type: 'character', filename: REISEN }, { type: 'sprites', filename: SPRITES }] });
        const before = readManifestText(directory);
        const modifiedBefore = fs.statSync(path.join(directory, MANIFEST_FILE_NAME)).mtimeMs;

        const { changed } = updateManagedManifest({ bundledDirectory: directory, entries: [] });

        expect(changed).toBe(false);
        expect(readManifestText(directory)).toBe(before);
        expect(fs.statSync(path.join(directory, MANIFEST_FILE_NAME)).mtimeMs).toBe(modifiedBefore);
    });

    test('raises the version of a card that changed, and keeps its old fingerprint', () => {
        const directory = makeBundle();
        const entries = [{ type: 'character', filename: REISEN }];
        updateManagedManifest({ bundledDirectory: directory, entries });
        const first = JSON.parse(readManifestText(directory)).items[0];
        fs.writeFileSync(path.join(directory, REISEN), createCardFile({ card: createCard({ character_version: '2', first_mes: 'A new greeting.' }) }));

        updateManagedManifest({ bundledDirectory: directory, entries });

        const second = JSON.parse(readManifestText(directory)).items[0];
        expect(second.version).toBe(2);
        expect(second.previousFingerprints).toEqual([first.fingerprint]);
    });

    test('is refused without items when there is no manifest to take them from', () => {
        expect(() => updateManagedManifest({ bundledDirectory: makeBundle(), entries: [] })).toThrow(/no items/i);
    });
});
