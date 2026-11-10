import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';

import archiver from 'archiver';
import PNGtext from 'png-chunk-text';

import encode from '../../src/png/encode.js';

const ARCHIVE_ENTRY_DATE = new Date(Date.UTC(2026, 0, 2, 3, 4, 6));

const SYNTHETIC_LOREBOOK = {
    name: 'Harbor notes',
    description: 'Synthetic lore for import tests.',
    scan_depth: 4,
    token_budget: 256,
    recursive_scanning: false,
    extensions: { synthetic_marker: 'book' },
    entries: [
        {
            id: 1,
            keys: ['harbor', 'dock'],
            secondary_keys: ['tide'],
            comment: 'A place',
            content: 'The harbor smells of salt.',
            constant: false,
            selective: true,
            insertion_order: 100,
            enabled: true,
            position: 'before_char',
            use_regex: false,
            extensions: { depth: 4, synthetic_marker: 'entry' },
        },
        {
            id: 2,
            keys: ['灯台'],
            secondary_keys: [],
            comment: 'Unicode keys',
            content: '灯台の光は遠くまで届く。',
            constant: true,
            selective: false,
            insertion_order: 200,
            enabled: false,
            position: 'after_char',
            use_regex: false,
            extensions: {},
        },
    ],
};

export function createV1Card() {
    return {
        name: 'Zoë Harbor',
        description: 'A lighthouse keeper who writes letters to the sea.',
        personality: 'Patient, with a dry humour.',
        scenario: 'A storm keeps {{user}} at the lighthouse.',
        first_mes: 'The lamp needs oil. Can you carry this?',
        mes_example: '<START>\n{{user}}: Hello.\n{{char}}: Mind the stairs.',
        creatorcomment: 'Synthetic V1 card.',
        talkativeness: 0.7,
        creator: 'Test Author',
        tags: ['lighthouse', 'synthetic'],
    };
}

export function createV2Card() {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        chat: 'A private chat name',
        fav: true,
        data: {
            name: '雪乃 Márquez',
            description: 'A cartographer who maps tide pools. 潮だまりの地図を描く。',
            personality: 'Curious and exact.',
            scenario: '{{user}} finds a map with no land on it.',
            first_mes: 'Hold the lantern higher, please.',
            mes_example: '<START>\n{{char}}: North is a suggestion here.',
            creator_notes: 'Synthetic V2 card.',
            system_prompt: 'Write as {{char}}.',
            post_history_instructions: 'Stay in the scene.',
            alternate_greetings: ['Another tide, another map.', '潮が引いたね。'],
            character_book: structuredClone(SYNTHETIC_LOREBOOK),
            tags: ['cartography', '合成'],
            creator: 'Test Author',
            character_version: '2.1',
            extensions: {
                talkativeness: 0.4,
                fav: true,
                world: '',
                depth_prompt: { prompt: 'Mention the tide.', depth: 2, role: 'system' },
                synthetic_marker: { kept: true },
            },
        },
    };
}

export function createV3Card() {
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name: 'Ренард 🦊',
            description: 'A fox courier who only delivers at dusk.',
            personality: 'Quick and evasive.',
            scenario: 'A parcel arrives for {{user}} with no sender.',
            first_mes: 'Sign here. No, the other here.',
            mes_example: '<START>\n{{char}}: Dusk is a deadline.',
            creator_notes: 'Synthetic V3 card.',
            system_prompt: 'Write as {{char}}.',
            post_history_instructions: 'Keep replies short.',
            alternate_greetings: ['You are late. So am I.'],
            character_book: structuredClone(SYNTHETIC_LOREBOOK),
            tags: ['courier', 'synthetic'],
            creator: 'Test Author',
            character_version: '3.2',
            extensions: {
                talkativeness: 0.6,
                fav: false,
                world: '',
                depth_prompt: { prompt: '', depth: 4, role: 'system' },
                synthetic_marker: { kept: true },
            },
            nickname: 'Ren',
            creator_notes_multilang: { en: 'Synthetic V3 card.', ja: '合成のカード。' },
            source: ['https://example.invalid/cards/ren'],
            group_only_greetings: ['Parcels for everyone, then.'],
            creation_date: 1700000000,
            modification_date: 1700000100,
            assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }],
        },
    };
}

export function createGradioCard() {
    return {
        char_name: 'Ilse Vane',
        char_persona: 'A retired ferry pilot.',
        char_greeting: 'Mind the rope.',
        world_scenario: '{{user}} misses the last ferry.',
        example_dialogue: '<START>\n{{char}}: The river keeps its own time.',
        creator_notes: 'Synthetic Gradio card.',
        creator: 'Test Author',
        tags: 'river, synthetic',
    };
}

export function createYamlCard() {
    return [
        'name: Tomasz Ż',
        'context: A bell founder with burnt sleeves.',
        'greeting: Stand clear of the mould.',
        '',
    ].join('\n');
}

export function createCharxCard() {
    const card = createV3Card();
    card.data.name = 'Ángel ميرا';
    card.data.assets = [
        { type: 'icon', uri: 'embeded://assets/icon/images/side.png', name: 'side', ext: 'png' },
        { type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' },
        { type: 'emotion', uri: 'embedded://assets/emotion/joy.png', name: 'Joy', ext: 'png' },
        { type: 'background', uri: '__asset:assets/background/beach.png', name: 'Beach Day.png', ext: 'png' },
        { type: 'other', uri: 'embeded://assets/other/poster.png', name: 'Poster', ext: 'png' },
        { type: 'other', uri: 'embeded://assets/other/readme.txt', name: 'Readme', ext: 'txt' },
        { type: 'emotion', uri: 'ccdefault:', name: 'unused', ext: 'png' },
    ];
    return card;
}

export function createByafParts() {
    const characterId = 'character-1';
    return {
        manifest: {
            schemaVersion: 1,
            createdAt: '2026-01-02T03:04:05.000Z',
            characters: ['characters/character-1/character.json'],
            scenarios: ['scenarios/first.json', 'scenarios/second.json'],
            author: { name: 'Test Author', backyardURL: 'https://example.invalid/authors/test' },
        },
        character: {
            schemaVersion: 1,
            id: characterId,
            name: 'soren',
            displayName: 'Søren 桜',
            isNSFW: false,
            persona: '#{character}: I keep bees. {user} visits on Sundays.',
            createdAt: '2026-01-02T03:04:05.000Z',
            updatedAt: '2026-01-02T03:04:05.000Z',
            loreItems: [
                { key: 'hive, apiary', value: '{character} has twelve hives.' },
                { key: '蜂', value: '蜂は日曜に静かになる。' },
            ],
            images: [
                { path: 'images/main.png', label: '' },
                { path: 'images/alt.png', label: 'smile' },
            ],
        },
        scenarios: [
            {
                schemaVersion: 1,
                title: 'Sunday',
                model: 'synthetic-model',
                formattingInstructions: 'Write as {character}.',
                narrative: '{user} arrives at the hives.',
                temperature: 0.8,
                backgroundImage: 'backgrounds/garden.png',
                firstMessages: [{ characterID: characterId, text: 'Mind the bees, {user}.' }],
                exampleMessages: [{ characterID: characterId, text: '#{user}: Hello.\n#{character}: Hush.' }],
                messages: [
                    { type: 'human', id: 'm1', createdAt: '2026-01-02T03:05:00.000Z', updatedAt: '2026-01-02T03:05:00.000Z', text: 'Are they asleep?' },
                    {
                        type: 'ai',
                        id: 'm2',
                        createdAt: '2026-01-02T03:06:00.000Z',
                        updatedAt: '2026-01-02T03:06:00.000Z',
                        outputs: [
                            { createdAt: '2026-01-02T03:06:00.000Z', updatedAt: '2026-01-02T03:06:00.000Z', activeTimestamp: '2026-01-02T03:06:00.000Z', text: 'Not yet.' },
                            { createdAt: '2026-01-02T03:06:30.000Z', updatedAt: '2026-01-02T03:06:30.000Z', activeTimestamp: '2026-01-02T03:07:00.000Z', text: 'Almost.' },
                        ],
                    },
                ],
            },
            {
                schemaVersion: 1,
                title: 'Winter',
                formattingInstructions: '',
                narrative: 'Snow covers the hives.',
                firstMessages: [{ characterID: characterId, text: 'The hives hum under the snow.' }],
                exampleMessages: [],
                messages: [],
            },
        ],
    };
}

/**
 * Builds the IHDR, IDAT and IEND chunks of an 8-bit RGBA image with one color.
 */
export function createImageChunks({ width = 2, height = 3, rgba = [200, 120, 40, 255] } = {}) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: width }, () => Buffer.from(rgba))]);
    const scanlines = Buffer.concat(Array.from({ length: height }, () => row));
    return {
        header: { name: 'IHDR', data: new Uint8Array(header) },
        pixels: { name: 'IDAT', data: new Uint8Array(zlib.deflateSync(scanlines)) },
        end: { name: 'IEND', data: new Uint8Array(0) },
    };
}

export function encodePng(chunks) {
    return Buffer.from(encode(chunks));
}

export function createImagePng(options) {
    const { header, pixels, end } = createImageChunks(options);
    return encodePng([header, pixels, end]);
}

export function encodeCardText(card) {
    return Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
}

export function createCardTextChunk(keyword, card) {
    return PNGtext.encode(keyword, encodeCardText(card));
}

/**
 * Builds a PNG that carries the card in one text chunk per keyword, in the order of the keywords.
 */
export function createCardPng(card, keywords = ['chara']) {
    const { header, pixels, end } = createImageChunks();
    return encodePng([header, pixels, ...keywords.map(keyword => createCardTextChunk(keyword, card)), end]);
}

/**
 * Builds a ZIP archive whose bytes depend only on the entries.
 * @param {{name: string, content: string|Buffer}[]} entries
 */
export function createZip(entries) {
    return new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 9 } });
        const parts = [];
        archive.on('data', part => parts.push(part));
        archive.on('error', reject);
        archive.on('end', () => resolve(Buffer.concat(parts)));
        for (const { name, content } of entries) {
            archive.append(content, { name, date: ARCHIVE_ENTRY_DATE });
        }
        archive.finalize();
    });
}

/**
 * A test reads these sizes back from the stored card to tell which archive image the route used.
 */
export const CHARX_ICON_SIZES = {
    main: { width: 4, height: 6 },
    side: { width: 3, height: 3 },
};

export function createCharxArchive(card = createCharxCard()) {
    return createZip([
        { name: 'card.json', content: JSON.stringify(card) },
        { name: 'assets/icon/images/main.png', content: createImagePng(CHARX_ICON_SIZES.main) },
        { name: 'assets/icon/images/side.png', content: createImagePng(CHARX_ICON_SIZES.side) },
        { name: 'assets/emotion/joy.png', content: createImagePng({ rgba: [10, 200, 10, 255] }) },
        { name: 'assets/background/beach.png', content: createImagePng({ rgba: [10, 10, 200, 255] }) },
        { name: 'assets/other/poster.png', content: createImagePng({ rgba: [90, 90, 90, 255] }) },
        { name: 'assets/other/readme.txt', content: 'This file is not an image.' },
    ]);
}

/**
 * A test reads these sizes back from the stored card to tell which archive image the route used.
 */
export const BYAF_ICON_SIZES = {
    main: { width: 5, height: 7 },
    alt: { width: 2, height: 2 },
};

export function createByafArchive({ manifest, character, scenarios } = createByafParts()) {
    const scenarioEntries = manifest.scenarios.map((name, index) => ({ name, content: JSON.stringify(scenarios[index]) }));
    return createZip([
        { name: 'manifest.json', content: JSON.stringify(manifest) },
        { name: manifest.characters[0], content: JSON.stringify(character) },
        { name: 'characters/character-1/images/main.png', content: createImagePng(BYAF_ICON_SIZES.main) },
        { name: 'characters/character-1/images/alt.png', content: createImagePng(BYAF_ICON_SIZES.alt) },
        ...scenarioEntries,
        { name: 'scenarios/backgrounds/garden.png', content: createImagePng({ rgba: [30, 120, 30, 255] }) },
    ]);
}

export function toJsonl(records) {
    return records.map(record => JSON.stringify(record)).join('\n');
}

const NATIVE_CHAT_MESSAGES = [
    { name: 'Keeper', is_user: false, send_date: '2026-01-02T03:04:05.000Z', mes: 'Hello again.', extra: { reasoning: 'kept' } },
    { name: 'Tester', is_user: true, send_date: '2026-01-02T03:05:05.000Z', mes: 'こんにちは。', extra: {} },
    { name: 'Narrator', is_user: false, is_system: true, send_date: '2026-01-02T03:06:05.000Z', mes: 'A hidden note.', extra: {} },
    { name: 'Keeper', is_user: false, send_date: '2026-01-02T03:07:05.000Z', mes: 'Raw text.', extra: { display_text: 'Shown text.' } },
];

/**
 * Chat files for `POST /api/chats/import`, with the messages each one must produce.
 * The expected names assume requests that name the user `Tester` and the character `Keeper`.
 */
export function createChatCorpus() {
    const convertedHeader = { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
    const nativeHeader = { user_name: 'Tester', character_name: 'Keeper', create_date: '2026-01-02@03h04m05s', chat_metadata: { note: 'kept' } };
    const chubHeader = { user_name: 'Tester', character_name: 'Keeper' };
    return [
        {
            id: 'Kobold Lite',
            fileType: 'json',
            expectedHeader: convertedHeader,
            content: JSON.stringify({
                savedsettings: { chatname: 'Mara', chatopponent: 'Oren||$||Other' },
                prompt: '{{[OUTPUT]}}The door creaks.',
                actions: ['{{[INPUT]}}Who is there?', '{{[OUTPUT]}}Only the wind. 風だけだ。'],
            }),
            expectedMessages: [
                { name: 'Oren', is_user: false, mes: 'The door creaks.' },
                { name: 'Mara', is_user: true, mes: 'Who is there?' },
                { name: 'Oren', is_user: false, mes: 'Only the wind. 風だけだ。' },
            ],
        },
        {
            id: 'oobabooga',
            fileType: 'json',
            expectedHeader: convertedHeader,
            content: JSON.stringify({
                data_visible: [['', 'Welcome back.'], ['Thanks. ありがとう。', 'Tea?']],
            }),
            expectedMessages: [
                { name: 'Keeper', is_user: false, mes: 'Welcome back.' },
                { name: 'Tester', is_user: true, mes: 'Thanks. ありがとう。' },
                { name: 'Keeper', is_user: false, mes: 'Tea?' },
            ],
        },
        {
            id: 'Agnaistic',
            fileType: 'json',
            expectedHeader: convertedHeader,
            content: JSON.stringify({
                messages: [
                    { characterId: 'c1', msg: 'The tide is out.' },
                    { userId: 'u1', msg: 'Shall we walk? 歩こうか。' },
                ],
            }),
            expectedMessages: [
                { name: 'Keeper', is_user: false, mes: 'The tide is out.' },
                { name: 'Tester', is_user: true, mes: 'Shall we walk? 歩こうか。' },
            ],
        },
        {
            id: 'RisuAI',
            fileType: 'json',
            expectedHeader: convertedHeader,
            content: JSON.stringify({
                type: 'risuChat',
                data: {
                    message: [
                        { role: 'char', data: 'Lanterns up.', time: 1767323045000 },
                        { role: 'user', data: 'Already lit. もう点いている。', time: 1767323105000 },
                        { role: 'char', name: 'Guest', data: 'May I come in?', time: 1767323165000 },
                    ],
                },
            }),
            expectedMessages: [
                { name: 'Keeper', is_user: false, mes: 'Lanterns up.', send_date: '2026-01-02T03:04:05.000Z' },
                { name: 'Tester', is_user: true, mes: 'Already lit. もう点いている。', send_date: '2026-01-02T03:05:05.000Z' },
                { name: 'Guest', is_user: false, mes: 'May I come in?', send_date: '2026-01-02T03:06:05.000Z' },
            ],
        },
        {
            id: 'native JSONL',
            fileType: 'jsonl',
            expectedHeader: nativeHeader,
            content: toJsonl([nativeHeader, ...NATIVE_CHAT_MESSAGES]),
            expectedMessages: NATIVE_CHAT_MESSAGES,
        },
        {
            id: 'Chub JSONL',
            fileType: 'jsonl',
            expectedHeader: chubHeader,
            content: toJsonl([
                chubHeader,
                { name: 'Keeper', is_user: false, send_date: '2026-01-02T03:04:05.000Z', mes: { message: 'Pick one.' }, swipes: [{ message: 'Pick one.' }, { message: 'Or the other.' }, 'A plain swipe.'] },
                { name: 'Tester', is_user: true, send_date: '2026-01-02T03:05:05.000Z', mes: 'The first.' },
            ]),
            expectedMessages: [
                { name: 'Keeper', is_user: false, send_date: '2026-01-02T03:04:05.000Z', mes: 'Pick one.', swipes: ['Pick one.', 'Or the other.', 'A plain swipe.'] },
                { name: 'Tester', is_user: true, send_date: '2026-01-02T03:05:05.000Z', mes: 'The first.' },
            ],
        },
    ];
}
