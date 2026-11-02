/* eslint-disable playwright/no-standalone-expect -- Jest contracts for shipped data. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

import { buildManifest, readManifest } from '../../src/sillybunny-managed-content.js';

const CONTENT_DIRECTORY = fileURLToPath(new URL('../../default/content/', import.meta.url));
const INDEX = JSON.parse(readFileSync(new URL('../../default/content/index.json', import.meta.url), 'utf8'));
const manifest = readManifest(CONTENT_DIRECTORY);
const LEXICON = 'SillyBunny Lexicon.json';

describe('the managed content that ships in default/content', () => {
    test('has a manifest that is what the build script would write, so a changed file does not ship with an old fingerprint', () => {
        const entries = manifest.items.map(({ filename, type }) => ({ filename, type }));

        expect(entries.length).toBeGreaterThan(0);
        expect(buildManifest({ bundledDirectory: CONTENT_DIRECTORY, entries, previous: manifest })).toEqual(manifest);
    });

    test('is seeded: every item of the manifest has an entry of its type in index.json, which is what copies it to a user', () => {
        const unseeded = manifest.items.filter(item => !INDEX.some(entry => entry.filename === item.filename && entry.type === item.type));

        expect(unseeded).toEqual([]);
    });

    test('manages the SillyBunny Lexicon as a world', () => {
        expect(manifest.items.find(item => item.filename === LEXICON)).toMatchObject({ type: 'world' });
    });
});
