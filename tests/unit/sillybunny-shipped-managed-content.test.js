/* eslint-disable playwright/no-standalone-expect -- Jest contracts for shipped data. */
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';
import PNGtext from 'png-chunk-text';
import extract from 'png-chunks-extract';

import { buildManifest, readManifest } from '../../src/sillybunny-managed-content.js';
import { getHomeAssistants } from '../../public/scripts/sillybunny-home/assistant-registry.js';

const CONTENT_DIRECTORY = fileURLToPath(new URL('../../default/content/', import.meta.url));
const INDEX = JSON.parse(readFileSync(new URL('../../default/content/index.json', import.meta.url), 'utf8'));
const manifest = readManifest(CONTENT_DIRECTORY);
const LEXICON = 'SillyBunny Lexicon.json';
const LEXICON_NAME = path.parse(LEXICON).name;

/** The card of each text chunk of a PNG card, by the keyword of the chunk: `chara` is V2 and `ccv3` is V3. */
function readCardChunks(file) {
    return Object.fromEntries(extract(new Uint8Array(file))
        .filter(chunk => chunk.name === 'tEXt')
        .map(chunk => PNGtext.decode(chunk.data))
        .map(({ keyword, text }) => [keyword, JSON.parse(Buffer.from(text, 'base64').toString('utf8'))]));
}

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

    describe('the cards of the assistants that Home lists', () => {
        const avatars = getHomeAssistants().map(assistant => assistant.defaultAvatar);

        test('are managed and seeded under the avatar that the registry expects', () => {
            expect(avatars.length).toBeGreaterThan(0);
            for (const avatar of avatars) {
                expect([avatar, existsSync(path.join(CONTENT_DIRECTORY, avatar))]).toEqual([avatar, true]);
                expect([avatar, manifest.items.find(item => item.filename === avatar)?.type]).toEqual([avatar, 'character']);
                expect([avatar, INDEX.some(entry => entry.filename === avatar && entry.type === 'character')]).toEqual([avatar, true]);
            }
        });

        test.each(avatars)('%s is a V2 and a V3 card that link the SillyBunny Lexicon and bring no book of their own', (avatar) => {
            const chunks = readCardChunks(readFileSync(path.join(CONTENT_DIRECTORY, avatar)));

            expect(Object.keys(chunks).sort()).toEqual(['ccv3', 'chara']);
            for (const card of Object.values(chunks)) {
                expect(card.data.extensions.world).toBe(LEXICON_NAME);
                expect(card.data.character_book).toBeUndefined();
            }
        });

        test('link a world that the manifest manages, so a card and its lexicon are never out of step', () => {
            expect(manifest.items.some(item => item.type === 'world' && path.parse(item.filename).name === LEXICON_NAME)).toBe(true);
        });
    });
});
