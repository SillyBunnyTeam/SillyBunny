/* eslint-disable playwright/no-standalone-expect -- Jest contracts for plain functions. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';

import { buildManifest, fingerprintCard, MANIFEST_FILE_NAME } from '../src/sillybunny-managed-content.js';
import { createCard, createCardFile, createSpriteFile, createWorldFile } from './fixtures/managed-content/fixture-builder.js';

jest.unstable_mockModule('../src/util.js', () => ({
    color: {
        blue: value => value,
        yellow: value => value,
    },
    getConfigValue: jest.fn((_key, defaultValue) => defaultValue),
    isValidUrl: jest.fn(() => false),
    recoverFileWriteSync: jest.fn(),
    setPermissionsSync: jest.fn(),
}));

/** @type {import('../src/endpoints/content-manager.js')} */
let contentManager;

const REISEN = 'default_AssistantReisen.png';
const LEXICON = 'SillyBunny Lexicon.json';
const SPRITES = 'Assistant Reisen';
const ENTRIES = [
    { filename: REISEN, type: 'character' },
    { filename: SPRITES, type: 'sprites' },
    { filename: LEXICON, type: 'world' },
];
const temporaryRoots = [];

beforeAll(async () => {
    contentManager = await import('../src/endpoints/content-manager.js');
});

afterEach(() => {
    jest.restoreAllMocks();
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-managed-seeding-'));
    temporaryRoots.push(root);
    return root;
}

/** A bundled directory with the files of a version, its index and its manifest, as `default/content` will hold them. */
function publish(version, previous = null) {
    const directory = makeRoot();
    const files = {
        [REISEN]: createCardFile({ card: createCard({ character_version: String(version), first_mes: `Hello, version ${version}.` }) }),
        [LEXICON]: createWorldFile([{ key: ['alpha'], content: `Lore of version ${version}.` }]),
        [`${SPRITES}/joy.webp`]: createSpriteFile(version),
    };
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
        fs.writeFileSync(path.join(directory, name), content);
    }
    const manifest = buildManifest({ bundledDirectory: directory, entries: ENTRIES, previous });
    fs.writeFileSync(path.join(directory, MANIFEST_FILE_NAME), JSON.stringify(manifest));
    const index = ENTRIES.map(entry => ({ ...entry, folder: directory }));
    return { directory, manifest, index, files };
}

function createUser() {
    const root = makeRoot();
    const directories = { root, characters: path.join(root, 'characters'), worlds: path.join(root, 'worlds'), backups: path.join(root, 'backups') };
    Object.values(directories).forEach(directory => fs.mkdirSync(directory, { recursive: true }));
    return directories;
}

describe('seeding with managed content', () => {
    test('brings a new filename to a user who already has other content', async () => {
        const { directory, index, files } = publish(1);
        const user = createUser();
        fs.writeFileSync(path.join(user.characters, 'Seraphina.png'), 'the card of the user');
        fs.writeFileSync(path.join(user.root, 'content.log'), 'default_Seraphina.png');

        await contentManager.seedContentForUser(index, user, [], { managedDirectory: directory });

        expect(fs.readFileSync(path.join(user.characters, REISEN))).toEqual(files[REISEN]);
        expect(fs.readFileSync(path.join(user.characters, SPRITES, 'joy.webp'))).toEqual(files[`${SPRITES}/joy.webp`]);
        expect(fs.readFileSync(path.join(user.worlds, LEXICON))).toEqual(files[LEXICON]);
        expect(fs.readFileSync(path.join(user.characters, 'Seraphina.png'), 'utf8')).toBe('the card of the user');
        expect(fs.readFileSync(path.join(user.root, 'content.log'), 'utf8').split('\n')).toEqual(['default_Seraphina.png', REISEN, SPRITES, LEXICON]);
    });

    test('updates what an older release seeded in the same pass, and keeps what the user changed', async () => {
        const first = publish(1);
        const second = publish(2, first.manifest);
        const user = createUser();
        await contentManager.seedContentForUser(first.index, user, [], { managedDirectory: first.directory });
        const edited = path.join(user.worlds, LEXICON);
        fs.writeFileSync(edited, createWorldFile([{ key: ['alpha'], content: 'My lore.' }]));

        await contentManager.seedContentForUser(second.index, user, [], { managedDirectory: second.directory });

        expect(fingerprintCard(fs.readFileSync(path.join(user.characters, REISEN)))).toBe(second.manifest.items[0].fingerprint);
        expect(fs.readFileSync(path.join(user.characters, SPRITES, 'joy.webp'))).toEqual(createSpriteFile(2));
        expect(fs.readFileSync(edited)).toEqual(createWorldFile([{ key: ['alpha'], content: 'My lore.' }]));
    });

    test('does not bring back a card that the user deleted', async () => {
        const { directory, index } = publish(1);
        const user = createUser();
        await contentManager.seedContentForUser(index, user, [], { managedDirectory: directory });
        fs.rmSync(path.join(user.characters, REISEN));

        await contentManager.seedContentForUser(index, user, [], { managedDirectory: directory });

        expect(fs.existsSync(path.join(user.characters, REISEN))).toBe(false);
    });

    test('does nothing more than seeding where the bundled content has no manifest', async () => {
        const user = createUser();
        fs.writeFileSync(path.join(user.characters, REISEN), createCardFile());

        await contentManager.seedContentForUser([], user, []);

        expect(fs.readdirSync(user.characters)).toEqual([REISEN]);
        expect(fs.existsSync(path.join(user.backups, 'managed'))).toBe(false);
    });

    test('seeds anyway when the manifest is broken', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { directory, index, files } = publish(1);
        fs.writeFileSync(path.join(directory, MANIFEST_FILE_NAME), '{ not json');
        const user = createUser();

        await contentManager.seedContentForUser(index, user, [], { managedDirectory: directory });

        expect(fs.readFileSync(path.join(user.characters, REISEN))).toEqual(files[REISEN]);
    });
});
