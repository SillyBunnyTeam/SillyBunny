/* eslint-disable playwright/no-standalone-expect -- Jest contracts for plain functions. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import '../src/fetch-patch.js';
import { setConfigFilePath } from '../src/util.js';
import { buildManifest, createManagedContent, MANIFEST_FILE_NAME } from '../src/sillybunny-managed-content.js';
import { read as readCardMetadata } from '../src/character-card-parser.js';
import { createCard, createCardFile, createWorldFile } from './fixtures/managed-content/fixture-builder.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalWorkingDirectory = process.cwd();
const diskCacheEnvironmentKey = 'SILLYTAVERN_PERFORMANCE_USEDISKCACHE';
const originalDiskCacheSetting = process.env[diskCacheEnvironmentKey];
process.env[diskCacheEnvironmentKey] = 'false';
process.chdir(repoRoot);
setConfigFilePath(path.join(repoRoot, 'default', 'config.yaml'));

const { router: charactersRouter } = await import('../src/endpoints/characters.js');

const REISEN = 'default_AssistantReisen.png';
const LEXICON = 'SillyBunny Lexicon.json';

/** A bundled card without a depth prompt or a character book, unless the fields give one. */
function createBundledCard(fields = {}) {
    const card = createCard(fields);
    if (!fields.extensions?.depth_prompt) {
        delete card.data.extensions.depth_prompt;
    }
    return card;
}

/**
 * The bundled files the user's folder was seeded from, with the manifest that lists them.
 * @param {string} root
 */
function publishBundle(root, card = createBundledCard()) {
    const bundledDirectory = path.join(root, 'bundled');
    fs.mkdirSync(bundledDirectory, { recursive: true });
    fs.writeFileSync(path.join(bundledDirectory, REISEN), createCardFile({ card }));
    fs.writeFileSync(path.join(bundledDirectory, LEXICON), createWorldFile([{ key: ['alpha'], content: 'Lore.' }]));
    const manifest = buildManifest({
        bundledDirectory,
        entries: [{ filename: REISEN, type: 'character' }, { filename: LEXICON, type: 'world' }],
    });
    fs.writeFileSync(path.join(bundledDirectory, MANIFEST_FILE_NAME), JSON.stringify(manifest));
    return bundledDirectory;
}

/**
 * What the character editor posts when its Save button is pressed, built from the card that the editor showed.
 * @param {Record<string, any>} card
 * @param {Record<string, any>} [changes]
 */
function createEditorForm(card, changes = {}) {
    const { data } = card;
    return {
        avatar_url: REISEN,
        ch_name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
        creator_notes: data.creator_notes,
        system_prompt: data.system_prompt,
        post_history_instructions: data.post_history_instructions,
        creator: data.creator,
        character_version: data.character_version,
        nickname: data.nickname ?? '',
        group_only_greetings: JSON.stringify(data.group_only_greetings ?? []),
        alternate_greetings: data.alternate_greetings,
        tags: data.tags.join(', '),
        talkativeness: String(data.extensions.talkativeness),
        fav: String(data.extensions.fav),
        world: data.extensions.world,
        depth_prompt_prompt: data.extensions.depth_prompt?.prompt ?? '',
        depth_prompt_depth: String(data.extensions.depth_prompt?.depth ?? 4),
        depth_prompt_role: data.extensions.depth_prompt?.role ?? 'system',
        chat: card.chat,
        create_date: card.create_date,
        json_data: JSON.stringify(card),
        ...changes,
    };
}

describe('managed cards through the character routes of the app', () => {
    let baseUrl;
    let directories;
    let server;
    let tempRoot;
    let managed;

    beforeAll(async () => {
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        // The server parses the multipart forms of the editor with the same middleware.
        app.use(multer({ storage: multer.memoryStorage() }).single('avatar'));
        app.use((request, _response, next) => {
            request.user = { profile: { handle: 'managed-content-test-user' }, directories };
            next();
        });
        app.use('/api/characters', charactersRouter);
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    beforeEach(() => {
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-managed-roundtrip-'));
        directories = {
            root: tempRoot,
            backups: path.join(tempRoot, 'backups'),
            chats: path.join(tempRoot, 'chats'),
            characters: path.join(tempRoot, 'characters'),
            groupChats: path.join(tempRoot, 'group chats'),
            groups: path.join(tempRoot, 'groups'),
            thumbnailsAvatar: path.join(tempRoot, 'thumbnails', 'avatar'),
            thumbnailsAvatarMobile: path.join(tempRoot, 'thumbnails', 'avatar', 'mobile'),
            worlds: path.join(tempRoot, 'worlds'),
        };
        for (const directory of Object.values(directories)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        fs.writeFileSync(path.join(directories.characters, REISEN), createCardFile({ card: createBundledCard() }));
        managed = createManagedContent({ bundledDirectory: publishBundle(tempRoot), directories });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        if (originalDiskCacheSetting === undefined) {
            delete process.env[diskCacheEnvironmentKey];
        } else {
            process.env[diskCacheEnvironmentKey] = originalDiskCacheSetting;
        }
        process.chdir(originalWorkingDirectory);
    });

    const postJson = (resource, body) => fetch(`${baseUrl}${resource}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    /**
     * Posts a form the way a browser does: as multipart, with every line break of a text value written as CRLF.
     * @param {string} resource
     * @param {Record<string, any>} fields
     */
    const postMultipart = (resource, fields) => {
        const form = new FormData();
        for (const [name, value] of Object.entries(fields)) {
            for (const item of Array.isArray(value) ? value : [value]) {
                form.append(name, String(item).replace(/\r\n|\r|\n/g, '\r\n'));
            }
        }
        return fetch(`${baseUrl}${resource}`, { method: 'POST', body: form });
    };
    /** Replaces the bundled card, with a user card seeded from it. */
    const installBundle = (card) => {
        fs.writeFileSync(path.join(directories.characters, REISEN), createCardFile({ card }));
        managed = createManagedContent({ bundledDirectory: publishBundle(tempRoot, card), directories });
    };
    const readCard = () => JSON.parse(readCardMetadata(fs.readFileSync(path.join(directories.characters, REISEN))));
    const cardStatus = () => managed.status().find(item => item.filename === REISEN)?.status;

    test('starts as the current version', () => {
        expect(cardStatus()).toBe('current');
    });

    test('stays current when the card is marked as a favourite, as the list does it', async () => {
        const response = await postJson('/api/characters/merge-attributes', {
            name: 'Assistant Fixture',
            avatar: REISEN,
            data: { extensions: { fav: true } },
            fav: true,
        });

        expect(response.status).toBe(200);
        expect(readCard().data.extensions.fav).toBe(true);
        expect(cardStatus()).toBe('current');
    });

    test('stays current when tags and talkativeness are changed', async () => {
        const response = await postJson('/api/characters/merge-attributes', {
            avatar: REISEN,
            tags: ['mine', 'edited'],
            data: { tags: ['mine', 'edited'], extensions: { talkativeness: 0.9 } },
        });

        expect(response.status).toBe(200);
        expect(readCard().data.tags).toEqual(['mine', 'edited']);
        expect(cardStatus()).toBe('current');
    });

    test('stays current when the editor saves the card without a change, which adds an empty depth prompt', async () => {
        const response = await postJson('/api/characters/edit', createEditorForm(readCard()));

        expect(response.status).toBe(200);
        expect(readCard().data.extensions.depth_prompt).toEqual({ prompt: '', depth: 4, role: 'system' });
        expect(cardStatus()).toBe('current');
    });

    test('stays current when the editor saves a card whose world exists, which embeds the world as a character book', async () => {
        fs.writeFileSync(path.join(directories.worlds, LEXICON), createWorldFile([{ key: ['alpha'], content: 'Lore.' }]));

        const response = await postJson('/api/characters/edit', createEditorForm(readCard()));

        expect(response.status).toBe(200);
        expect(readCard().data.character_book?.name).toBe('SillyBunny Lexicon');
        expect(cardStatus()).toBe('current');
    });

    test('is modified when the editor saves a change to the description, and an update then keeps the favourite', async () => {
        await postJson('/api/characters/merge-attributes', { avatar: REISEN, data: { extensions: { fav: true } }, fav: true });
        const card = readCard();

        const response = await postJson('/api/characters/edit', createEditorForm(card, { description: 'My own description.', fav: 'true' }));

        expect(response.status).toBe(200);
        expect(cardStatus()).toBe('modified');
        expect(managed.apply(REISEN).backup).toMatch(/^default_AssistantReisen-.*\.png$/);
        expect(readCard().data.description).toBe(createBundledCard().data.description);
        expect(readCard().data.extensions.fav).toBe(true);
        expect(cardStatus()).toBe('current');
    });

    describe('saved from the editor of a browser', () => {
        const multiLineCard = () => createBundledCard({
            description: 'Line one.\nLine two.',
            personality: 'Calm.\nKind.',
            scenario: 'A room.\nA desk.',
            first_mes: 'Hello.\n\nHow are you?',
            mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello',
            creator_notes: 'Notes.\nMore notes.',
            system_prompt: 'Rules.\nMore rules.',
            post_history_instructions: 'After.\nMore.',
            alternate_greetings: ['First.\nAlternate.', 'Second.\nAlternate.'],
            group_only_greetings: ['Group.\nOnly.'],
            extensions: { depth_prompt: { prompt: 'Remember.\nThis.', depth: 4, role: 'system' } },
        });

        test('stays current when the form carries CRLF line breaks in every multi-line field', async () => {
            installBundle(multiLineCard());

            const response = await postMultipart('/api/characters/edit', createEditorForm(readCard()));

            expect(response.status).toBe(200);
            const saved = readCard().data;
            expect(saved.description).toBe('Line one.\r\nLine two.');
            expect(saved.alternate_greetings).toEqual(['First.\r\nAlternate.', 'Second.\r\nAlternate.']);
            expect(saved.extensions.depth_prompt.prompt).toBe('Remember.\r\nThis.');
            expect(cardStatus()).toBe('current');
        });

        test('is modified once a line of a multi-line field is changed in the form', async () => {
            installBundle(multiLineCard());

            await postMultipart('/api/characters/edit', createEditorForm(readCard(), { description: 'Line one.\nAnother line.' }));

            expect(cardStatus()).toBe('modified');
        });

        test('stays current after the world is unlinked in the editor, which leaves the embedded copy on the card', async () => {
            fs.writeFileSync(path.join(directories.worlds, LEXICON), createWorldFile([{ key: ['alpha'], content: 'Lore.' }]));
            await postJson('/api/characters/edit', createEditorForm(readCard()));
            expect(readCard().data.character_book?.name).toBe('SillyBunny Lexicon');

            const response = await postJson('/api/characters/edit', createEditorForm(readCard(), { world: '' }));

            expect(response.status).toBe(200);
            expect(readCard().data.extensions.world).toBe('');
            expect(readCard().data.character_book?.name).toBe('SillyBunny Lexicon');
            expect(cardStatus()).toBe('current');
        });
    });

    describe('renamed in the app', () => {
        test('shows the card as deleted and restores a second one, because a rename moves the file under a new name', async () => {
            fs.writeFileSync(path.join(directories.root, 'content.log'), REISEN);

            const response = await postJson('/api/characters/rename', { avatar_url: REISEN, new_name: 'My Reisen' });

            expect(response.status).toBe(200);
            expect(fs.existsSync(path.join(directories.characters, REISEN))).toBe(false);
            expect(fs.existsSync(path.join(directories.characters, 'My Reisen.png'))).toBe(true);
            expect(cardStatus()).toBe('deleted');
            expect(managed.restore(REISEN)).toEqual({ backup: null });
            expect(fs.readdirSync(directories.characters).filter(name => name.endsWith('.png')).sort()).toEqual([REISEN, 'My Reisen.png'].sort());
            expect(cardStatus()).toBe('current');
        });
    });
});
