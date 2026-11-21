import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

import { write } from '../../../src/character-card-parser.js';
import encode from '../../../src/png/encode.js';

const SIZE = 8;

/**
 * An 8 by 8 PNG whose pixels follow the seed, so two seeds give two different images and one seed always gives
 * the same bytes. The fixtures are generated from this file and are never edited by hand.
 * @param {number} seed
 * @returns {Buffer}
 */
export function createPng(seed) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(SIZE, 0);
    header.writeUInt32BE(SIZE, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const rows = [];
    for (let y = 0; y < SIZE; y++) {
        const row = Buffer.alloc(1 + SIZE * 4);
        for (let x = 0; x < SIZE; x++) {
            row.set([(seed * 37 + x * 17) & 255, (seed * 91 + y * 29) & 255, (seed * 13 + x * y) & 255, 255], 1 + x * 4);
        }
        rows.push(row);
    }
    const chunks = [
        { name: 'IHDR', data: new Uint8Array(header) },
        // Level 0 stores the data uncompressed, so the bytes are the same on every zlib and the generated fixtures can be compared byte for byte.
        { name: 'IDAT', data: new Uint8Array(zlib.deflateSync(Buffer.concat(rows), { level: 0 })) },
        { name: 'IEND', data: new Uint8Array(0) },
    ];
    return Buffer.from(encode(chunks));
}

/**
 * A V3 card with every field the managed fingerprint reads, and the personal ones a user changes.
 * @param {Record<string, any>} [overrides] Replaces fields of `data`; `extensions` is merged into the defaults.
 * @returns {Record<string, any>}
 */
export function createCard({ extensions = {}, ...fields } = {}) {
    const data = {
        name: 'Assistant Fixture',
        description: 'The description of the fixture card.',
        personality: 'Calm.',
        scenario: 'A test.',
        first_mes: 'Hello from the fixture.',
        mes_example: '<START>',
        creator_notes: 'Notes for the fixture.',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: ['Another hello.'],
        tags: ['assistant', 'sillybunny'],
        creator: 'SillyBunnyTeam',
        character_version: '1',
        nickname: 'Fixture',
        group_only_greetings: [],
        ...fields,
        extensions: {
            talkativeness: 0.5,
            fav: false,
            world: 'SillyBunny Lexicon',
            depth_prompt: { prompt: '', depth: 4, role: 'system' },
            ...extensions,
        },
    };
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
        creatorcomment: data.creator_notes,
        avatar: 'none',
        chat: 'Assistant Fixture - 2026-01-01 @00h 00m 00s 000ms',
        talkativeness: data.extensions.talkativeness,
        fav: data.extensions.fav,
        tags: data.tags,
        create_date: '2026-01-01 @00h 00m 00s 000ms',
        data,
    };
}

/**
 * A card file: the image of the seed with the card in its metadata.
 * @param {object} [options]
 * @param {number} [options.seed]
 * @param {Record<string, any>} [options.card] A card made by {@link createCard}.
 * @returns {Buffer}
 */
export function createCardFile({ seed = 1, card = createCard() } = {}) {
    return write(createPng(seed), JSON.stringify(card));
}

/** The bytes of the smallest valid lossless WebP, for sprite files that nothing decodes. */
export const SPRITE_FILE = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

/**
 * A sprite file that differs from every other `variant` and from {@link SPRITE_FILE}.
 * @param {number} variant
 * @returns {Buffer}
 */
export function createSpriteFile(variant) {
    return Buffer.concat([SPRITE_FILE, Buffer.from([variant & 255])]);
}

/**
 * A World Info file with the entries the managed fingerprint compares.
 * @param {Array<Record<string, any>>} entries
 * @returns {Buffer}
 */
export function createWorldFile(entries) {
    const byUid = Object.fromEntries(entries.map((entry, index) => [String(index), { uid: index, displayIndex: index, ...entry }]));
    return Buffer.from(JSON.stringify({ entries: byUid }, null, 4));
}
