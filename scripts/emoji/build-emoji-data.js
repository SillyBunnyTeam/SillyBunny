#!/usr/bin/env node
/**
 * Writes the emoji tables of the chooser: `public/scripts/sillybunny-conversation/emoji/data/emoji-<locale>.json` for each
 * locale of `emoji-locales.js`, the names of the default quick reactions (`default-names.js`), the two licence texts and the
 * `data` section of `manifest.json`.
 *
 *   node scripts/emoji/build-emoji-data.js           write the files
 *   node scripts/emoji/build-emoji-data.js --check   rebuild in memory and fail when a committed file differs
 *
 * The input is the emojibase-data tarball that `sources.json` pins (version, sha512, length), fetched by address and checked
 * before it is unpacked; nothing is installed. The tables are cut to the emoji that the font draws
 * (`font-coverage.txt`, written by `build-emoji-font.js`, so run that first), which is why they hold Emoji 17 and not 18.
 * Needs `tar`. A table row is `[emoji, name, keywords joined with "|", group, Emoji version, skin variants?]`; `emoji` is the
 * fully-qualified string, which emojibase's `hexcode` is not for 219 entries.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { EMOJI_LOCALES } from '../../public/scripts/sillybunny-conversation/emoji/emoji-locales.js';
import { DEFAULT_QUICK_REACTIONS } from '../../public/scripts/sillybunny-conversation/emoji/emoji-defaults.js';
import { fetchEmojibase, fetchUnicodeLicense, makeWorkDirectory, repositoryRoot, sha256, sources, writeManifestSection } from './sources.js';

const TABLE_FORMAT = 1;
const TONE_ORDER = ['light', 'medium-light', 'medium', 'medium-dark', 'dark'];
const COMPONENT_GROUP = 2;
const dataDirectory = path.join(repositoryRoot, 'public/scripts/sillybunny-conversation/emoji/data');
const check = process.argv.includes('--check');

const hexcode = text => [...text].map(character => character.codePointAt(0).toString(16).toUpperCase()).join('-');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

/**
 * CLDR writes a section name in the case of running text ("smileys & emotion"). A heading is Title Case in English, as every
 * heading of the program is, and in another language it starts with a capital letter.
 */
function capitalizeHeading(text, locale) {
    const tag = locale === 'zh-hant' ? 'zh-Hant' : locale;
    const upper = word => (word ? word[0].toLocaleUpperCase(tag) + word.slice(1) : word);
    return locale === 'en' ? text.split(' ').map(upper).join(' ') : upper(text);
}

function buildTable(packageDirectory, locale, drawn) {
    const data = readJson(path.join(packageDirectory, locale, 'data.json'));
    const messages = readJson(path.join(packageDirectory, locale, 'messages.json'));
    const groups = messages.groups.filter(group => group.key !== 'component').sort((a, b) => a.order - b.order);
    const groupIndex = new Map(groups.map((group, index) => [group.order, index]));
    const toneName = Object.fromEntries(messages.skinTones.map(tone => [tone.key, tone.message]));

    const rows = [];
    for (const entry of data) {
        // The regional-indicator letters have no group; the components (skin tone swatches, hair) are not items to pick.
        if (entry.group === undefined || entry.group === COMPONENT_GROUP || !drawn.has(hexcode(entry.emoji))) {
            continue;
        }
        const variants = (entry.skins ?? []).filter(skin => drawn.has(hexcode(skin.emoji))).map(skin => skin.emoji);
        const row = [entry.emoji, entry.label, (entry.tags ?? []).join('|'), groupIndex.get(entry.group), entry.version];
        if (variants.length) {
            row.push(variants);
        }
        rows.push(row);
    }
    return { v: TABLE_FORMAT, emojibase: sources.emojibase.version, locale, groups: groups.map(group => capitalizeHeading(group.message, locale)), tones: TONE_ORDER.map(key => toneName[key]), rows };
}

const quote = text => `'${text.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
const renderKey = key => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key));

/** The file is linted with the rest of `public/`, so it is written in the style that the rules ask for. */
function renderDefaultNames(tables) {
    const lines = ['// Written by scripts/emoji/build-emoji-data.js from the tables beside it. Do not edit by hand.', 'export const DEFAULT_REACTION_NAMES = Object.freeze({'];
    for (const table of tables) {
        const byEmoji = new Map(table.rows.map(row => [row[0], row[1]]));
        lines.push(`    ${renderKey(table.locale)}: {`);
        for (const emoji of DEFAULT_QUICK_REACTIONS) {
            if (!byEmoji.has(emoji)) {
                throw new Error(`${table.locale} has no row for the default reaction ${emoji}.`);
            }
            lines.push(`        ${quote(emoji)}: ${quote(byEmoji.get(emoji))},`);
        }
        lines.push('    },');
    }
    lines.push('});', '');
    return lines.join('\n');
}

const work = makeWorkDirectory('data');
try {
    const drawn = new Set(readFileSync(path.join(repositoryRoot, 'scripts/emoji/font-coverage.txt'), 'utf8').split('\n').filter(Boolean));
    console.log('Fetching and checking the emojibase data and the Unicode licence...');
    const packageDirectory = await fetchEmojibase(work);
    const unicodeLicense = await fetchUnicodeLicense();

    const tables = EMOJI_LOCALES.map(locale => buildTable(packageDirectory, locale, drawn));
    const english = tables[0];
    for (const table of tables) {
        const same = table.rows.length === english.rows.length && table.rows.every((row, index) => row[0] === english.rows[index][0] && (row[5]?.length ?? 0) === (english.rows[index][5]?.length ?? 0));
        if (!same) {
            throw new Error(`${table.locale} does not hold the same emoji as English.`);
        }
    }

    /** @type {Map<string, string|Buffer>} */
    const files = new Map(tables.map(table => [`emoji-${table.locale}.json`, `${JSON.stringify(table)}\n`]));
    files.set('default-names.js', renderDefaultNames(tables));
    files.set('LICENSE-UNICODE.txt', unicodeLicense);
    files.set('LICENSE-EMOJIBASE.txt', readFileSync(path.join(packageDirectory, 'LICENSE')));

    const section = {
        format: TABLE_FORMAT,
        emojibase: sources.emojibase.version,
        integrity: sources.emojibase.integrity,
        files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => {
            const bytes = Buffer.from(content);
            return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
        })),
    };

    if (check) {
        const different = [...files].filter(([name, content]) => {
            try {
                return !readFileSync(path.join(dataDirectory, name)).equals(Buffer.from(content));
            } catch {
                return true;
            }
        }).map(([name]) => name);
        const manifestDiffers = JSON.stringify(JSON.parse(readFileSync(path.join(repositoryRoot, 'scripts/emoji/manifest.json'), 'utf8')).data) !== JSON.stringify(section);
        if (different.length || manifestDiffers) {
            console.error(`Out of date: ${[...different, ...(manifestDiffers ? ['manifest.json'] : [])].join(', ')}`);
            process.exitCode = 1;
        } else {
            console.log('The committed tables are the ones that the pinned sources and the font coverage give.');
        }
    } else {
        mkdirSync(dataDirectory, { recursive: true });
        for (const [name, content] of files) {
            writeFileSync(path.join(dataDirectory, name), content);
        }
        writeManifestSection('data', section);
        const total = [...files.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0);
        console.log(`Wrote ${files.size} files, ${total} bytes, ${english.rows.length} rows and ${english.rows.reduce((sum, row) => sum + (row[5]?.length ?? 0), 0)} variants in each table.`);
    }
} finally {
    rmSync(work, { recursive: true, force: true });
}
