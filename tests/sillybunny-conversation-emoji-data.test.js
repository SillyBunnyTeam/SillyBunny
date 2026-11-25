import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const root = new URL('../', import.meta.url);
const read = (path, encoding) => readFileSync(new URL(path, root), encoding);
const json = path => JSON.parse(read(path, 'utf8'));
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const hexcode = text => [...text].map(character => character.codePointAt(0).toString(16).toUpperCase()).join('-');

const DATA = 'public/scripts/sillybunny-conversation/emoji/data/';
const sources = json('scripts/emoji/sources.json');
const manifest = json('scripts/emoji/manifest.json');
const { EMOJI_LOCALES } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-locales.js');
const { DATA_VERSION } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-table.js');
const { isSingleEmoji, qualifyEmoji } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-validate.js');
const { DEFAULT_QUICK_REACTIONS } = await import('../public/scripts/sillybunny-conversation/emoji/emoji-defaults.js');
const { DEFAULT_REACTION_NAMES } = await import('../public/scripts/sillybunny-conversation/emoji/data/default-names.js');

const tables = Object.fromEntries(EMOJI_LOCALES.map(locale => [locale, json(`${DATA}emoji-${locale}.json`)]));
const flatten = table => table.rows.flatMap(row => [row[0], ...(row[5] ?? [])]);

describe('the pinned sources', () => {
    test('name every input by a hash that a script can check', () => {
        expect(sources.emojibase.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
        expect(sources.emojibase.shasum).toMatch(/^[0-9a-f]{40}$/);
        expect(sources.emojibase.licenseSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(sources.unicodeLicense.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(sources.twemoji.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(sources.twemoji.archive).toContain(sources.twemoji.commit);
        expect(sources.twemoji.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(sources.twemoji.svgTreeSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(sources.twemoji.graphicsLicenseSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(sources.nanoemoji.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    test('are the ones that the manifest says the committed files were made from', () => {
        expect(manifest.data.emojibase).toBe(sources.emojibase.version);
        expect(manifest.data.integrity).toBe(sources.emojibase.integrity);
        expect(manifest.font.twemoji.commit).toBe(sources.twemoji.commit);
        expect(manifest.font.twemoji.svgTreeSha256).toBe(sources.twemoji.svgTreeSha256);
        expect(manifest.font.nanoemoji).toBe(sources.nanoemoji.version);
    });
});

describe('the emoji tables', () => {
    test('are one file for each locale that an interface language reads, and no other', () => {
        const files = readdirSync(new URL(DATA, root)).filter(name => /^emoji-.+\.json$/.test(name)).sort();
        expect(files).toEqual(EMOJI_LOCALES.map(locale => `emoji-${locale}.json`).sort());
        expect(EMOJI_LOCALES.length).toBe(15);
    });

    test.each(EMOJI_LOCALES)('%s has the shape that the chooser reads', (locale) => {
        const table = tables[locale];
        expect(table).toMatchObject({ v: 1, emojibase: sources.emojibase.version, locale });
        expect(table.groups).toHaveLength(9);
        expect(table.tones).toHaveLength(5);
        for (const text of [...table.groups, ...table.tones]) {
            expect(typeof text === 'string' && text.length > 0).toBe(true);
        }
        expect(table.rows).toHaveLength(1914);
        for (const [emoji, name, keywords, group, version, variants] of table.rows) {
            expect(typeof emoji).toBe('string');
            expect(typeof name === 'string' && name.length > 0).toBe(true);
            expect(typeof keywords).toBe('string');
            expect(Number.isInteger(group) && group >= 0 && group < 9).toBe(true);
            expect(version).toBeGreaterThan(0);
            expect(version).toBeLessThanOrEqual(17);
            expect(variants === undefined || (Array.isArray(variants) && variants.length > 0)).toBe(true);
        }
    });

    test('name the sections like headings: Title Case in English and a capital first letter elsewhere', () => {
        expect(tables.en.groups).toEqual(['Smileys & Emotion', 'People & Body', 'Animals & Nature', 'Food & Drink', 'Travel & Places', 'Activities', 'Objects', 'Symbols', 'Flags']);
        for (const locale of EMOJI_LOCALES) {
            for (const name of tables[locale].groups) {
                expect([locale, name]).toEqual([locale, name[0].toLocaleUpperCase() + name.slice(1)]);
            }
        }
    });

    test('hold the same emoji in the same order in every locale, 1,914 and 2,030 variants', () => {
        const english = flatten(tables.en);
        expect(english.length).toBe(1914 + 2030);
        for (const locale of EMOJI_LOCALES) {
            expect(flatten(tables[locale])).toEqual(english);
        }
    });

    test('hold only emoji that pass the validator and are in their qualified form, so a reply and a pick agree with the data', () => {
        for (const emoji of flatten(tables.en)) {
            expect([emoji, isSingleEmoji(emoji), qualifyEmoji(emoji) === emoji]).toEqual([emoji, true, true]);
        }
    });

    test('are the emoji that the font draws, no more and no fewer', () => {
        const drawn = read('scripts/emoji/font-coverage.txt', 'utf8').split('\n').filter(Boolean);
        expect(new Set(drawn).size).toBe(drawn.length);
        expect(new Set(flatten(tables.en).map(hexcode))).toEqual(new Set(drawn));
        expect(manifest.font.coverage.count).toBe(drawn.length);
        expect(manifest.font.coverage.sha256).toBe(sha256(read('scripts/emoji/font-coverage.txt')));
    });

    test('are small enough to fetch on the first open', () => {
        for (const locale of EMOJI_LOCALES) {
            expect(read(`${DATA}emoji-${locale}.json`).length).toBeLessThan(300 * 1024);
        }
    });
});

describe('the manifest and the licences', () => {
    test('list every table and licence with the size and the hash of the committed bytes', () => {
        const files = Object.keys(manifest.data.files).sort();
        expect(files).toEqual([...EMOJI_LOCALES.map(locale => `emoji-${locale}.json`), 'default-names.js', 'LICENSE-EMOJIBASE.txt', 'LICENSE-UNICODE.txt'].sort());
        for (const [name, entry] of Object.entries(manifest.data.files)) {
            const bytes = read(`${DATA}${name}`);
            expect([name, bytes.length, sha256(bytes)]).toEqual([name, entry.bytes, entry.sha256]);
        }
    });

    test('carry the licence texts that the sources pin, word for word', () => {
        expect(sha256(read(`${DATA}LICENSE-UNICODE.txt`))).toBe(sources.unicodeLicense.sha256);
        expect(sha256(read(`${DATA}LICENSE-EMOJIBASE.txt`))).toBe(sources.emojibase.licenseSha256);
        expect(read(`${DATA}LICENSE-UNICODE.txt`, 'utf8')).toMatch(/^UNICODE LICENSE V3/);
        expect(read(`${sources.font.directory}/LICENSE-GRAPHICS`, 'utf8')).toMatch(/Attribution 4\.0 International/);
        expect(sha256(read(`${sources.font.directory}/LICENSE-GRAPHICS`))).toBe(sources.twemoji.graphicsLicenseSha256);
    });

    test('name the version of the tables, so the address of a table changes when the files do', () => {
        expect(DATA_VERSION).toBe(`${sources.emojibase.version}.${manifest.data.format}`);
    });
});

describe('the default quick reactions', () => {
    test('are the six of the decision, each with a name in every locale that has a table', () => {
        expect(DEFAULT_QUICK_REACTIONS).toEqual(['❤️', '😂', '✨', '👍', '😮', '😢']);
        for (const locale of EMOJI_LOCALES) {
            const names = Object.fromEntries(tables[locale].rows.map(row => [row[0], row[1]]));
            for (const emoji of DEFAULT_QUICK_REACTIONS) {
                expect([locale, emoji, DEFAULT_REACTION_NAMES[locale][emoji]]).toEqual([locale, emoji, names[emoji]]);
            }
        }
    });
});

describe('the font file', () => {
    test('is a real WOFF2 file, the one that the manifest and the sources name', () => {
        const path = `${sources.font.directory}/${sources.font.file}`;
        expect(existsSync(new URL(path, root))).toBe(true);
        const bytes = read(path);
        expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
        expect(manifest.font.file).toBe(sources.font.file);
        expect([bytes.length, sha256(bytes)]).toEqual([manifest.font.bytes, manifest.font.sha256]);
    });
});
