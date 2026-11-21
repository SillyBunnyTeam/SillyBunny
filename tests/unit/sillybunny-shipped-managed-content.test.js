/* eslint-disable playwright/no-standalone-expect -- Jest contracts for shipped data. */
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';
import PNGtext from 'png-chunk-text';
import extract from 'png-chunks-extract';

import { buildManifest, fingerprintSpriteFile, readManifest } from '../../src/sillybunny-managed-content.js';
import { getHomeAssistants } from '../../public/scripts/sillybunny-home/assistant-registry.js';

const CONTENT_DIRECTORY = fileURLToPath(new URL('../../default/content/', import.meta.url));
const INDEX = JSON.parse(readFileSync(new URL('../../default/content/index.json', import.meta.url), 'utf8'));
const manifest = readManifest(CONTENT_DIRECTORY);
const LEXICON = 'SillyBunny Lexicon.json';
const LEXICON_NAME = path.parse(LEXICON).name;

/** The labels that the Expressions extension asks a sprite folder for, read from its source so the two cannot drift. */
const EXPRESSION_LABELS = [...readFileSync(new URL('../../public/scripts/extensions/expressions/index.js', import.meta.url), 'utf8')
    .match(/const DEFAULT_EXPRESSIONS = \[([^\]]+)\]/)[1].matchAll(/'([a-z]+)'/g)].map(([, label]) => label);

/** The folder of a pack is the name of the card, because the extension looks sprites up by the name of the character. */
const EXPRESSION_PACKS = [
    { folder: 'Assistant Reisen', avatar: 'default_AssistantReisen.png' },
    { folder: 'Assistant Tewi', avatar: 'default_AssistantTewi.png' },
];

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

    describe.each(EXPRESSION_PACKS)('the expression pack $folder', ({ folder, avatar }) => {
        const directory = path.join(CONTENT_DIRECTORY, folder);
        const item = manifest.items.find(entry => entry.filename === folder);
        const filesOnDisk = readdirSync(directory).sort();

        test('asks for the labels of the Expressions extension, with a file for each and nothing else in the folder', () => {
            expect(EXPRESSION_LABELS).toHaveLength(28);
            expect(filesOnDisk).toEqual(EXPRESSION_LABELS.map(label => `${label}.webp`).sort());
        });

        test('is seeded and managed as a sprites item', () => {
            expect(item).toMatchObject({ type: 'sprites' });
            expect(INDEX.filter(entry => entry.filename === folder)).toEqual([{ filename: folder, type: 'sprites' }]);
        });

        test('fingerprints every file in the folder by its bytes, and no other', () => {
            expect(item.files.map(file => file.name).sort()).toEqual(filesOnDisk);
            for (const file of item.files) {
                expect([file.name, file.sha256]).toEqual([file.name, fingerprintSpriteFile(readFileSync(path.join(directory, file.name)))]);
            }
        });

        test('is named like the card that it belongs to', () => {
            const { chara } = readCardChunks(readFileSync(path.join(CONTENT_DIRECTORY, avatar)));

            expect(chara.data.name).toBe(folder);
        });
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

    describe.each([
        {
            avatar: 'default_AssistantReisen.png',
            earlier: [
                { commit: '48b7ea7c7', fingerprint: 'fb75a20e467163fc02412c187be5e5ee9fbce03fd28a257fc2d9c6e0aafeca3f' },
                { commit: '77fe236fd', fingerprint: '926f62bc3a1c6a4ec33da49b8903957db5ebc9ef41de04cf7ff7ccb649f52820' },
            ],
        },
        {
            avatar: 'default_AssistantTewi.png',
            earlier: [
                { commit: '48b7ea7c7', fingerprint: 'c6fae718bf7b840656ce13a80a74a8bb30e2150944a0f6fb57616e2024028f9f' },
                { commit: '77fe236fd', fingerprint: 'cfa541cabd82301e9a87b35a54bea4b0773ce77c547a741d73d54ee3c8a6f241' },
            ],
        },
    ])('the pre-release versions of $avatar', ({ avatar, earlier }) => {
        const item = manifest.items.find(entry => entry.filename === avatar);

        test('stay at the end of the earlier fingerprints, newest first, so an unedited copy of a pre-release card is updated at start', () => {
            // A later version of the card adds its fingerprint in front of these.
            expect(item.previousFingerprints.slice(-earlier.length).map(fingerprint => earlier.find(version => version.fingerprint === fingerprint)?.commit ?? fingerprint))
                .toEqual(earlier.map(version => version.commit));
            expect(item.previousFingerprints).not.toContain(item.fingerprint);
        });
    });

    describe('the pre-release versions of the SillyBunny Lexicon', () => {
        const earlier = [
            { commit: '6c7e09798', fingerprint: '8fc16bdbf7ad190744c53b5a0f5f8f80895872747506d72e30e1de93cef53d42' },
            { commit: '34e1b7fa9', fingerprint: '92324dece7df4e01b161efea80e2af0bd163ccecf272f7c44f6c6ed2b8b2eac9' },
            { commit: '01ce1da42', fingerprint: '41ac10a6a3ecd125c4dec9209d2bbb55768d02ca4b83402171125631dbf096d1' },
            { commit: '904867673', fingerprint: '8e9a96bfdc2c25f90dde17c93ecf259078f0914009ea76b51b94de964ffadca8' },
            { commit: '98589ae32', fingerprint: '897d27373696defb9156830e066d37e713c83a5a0d4155524d28c62b90d94fea' },
            { commit: '2e44363de', fingerprint: 'e3080d2951a589f59b57eb29256ab51cc0ecad5c28925891544f36c0c6a796fd' },
            { commit: 'b207a8101', fingerprint: '10ef1c6dc724b2bf9b3bf62ac2970737994fdb0769722695e9185b590e21e2b8' },
        ];
        const item = manifest.items.find(entry => entry.filename === LEXICON);

        test('stay at the end of the earlier fingerprints, newest first, so an unedited copy of a pre-release Lexicon is updated at start', () => {
            // A later version of the Lexicon adds its fingerprint in front of these.
            expect(item.previousFingerprints.slice(-earlier.length).map(fingerprint => earlier.find(version => version.fingerprint === fingerprint)?.commit ?? fingerprint))
                .toEqual(earlier.map(version => version.commit));
            expect(item.previousFingerprints).not.toContain(item.fingerprint);
        });
    });
});
