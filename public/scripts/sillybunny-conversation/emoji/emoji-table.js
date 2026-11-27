/**
 * Loads the emoji table of the interface language, and the English one when a search needs it. A table is a JSON file
 * under `data/` that `scripts/emoji/build-emoji-data.js` writes; the chooser fetches it when it first opens and nothing
 * fetches it at start-up. It is fetched with `fetch()` and not imported: JSON import attributes need Safari 17.2.
 *
 * @typedef {[string, string, string, number, number, string[]?]} EmojiRow Emoji, name, keywords joined with "|", group, Emoji version, skin variants.
 * @typedef {object} EmojiTable
 * @property {string} locale
 * @property {string[]} groups The names of the nine sections.
 * @property {string[]} tones The names of the five skin tones, light to dark.
 * @property {EmojiRow[]} rows
 * @property {() => ReturnType<typeof buildSearchIndex>} getIndex The search index, built when it is first asked for.
 */

import { buildSearchIndex } from './emoji-search.js';
import { pickEmojiLocale } from './emoji-locales.js';

/** The emojibase version and the format revision of the files. Raised with `manifest.json` when the tables are written again. */
export const DATA_VERSION = '18.0.0.1';
const TABLE_FORMAT = 1;
const DATA_DIRECTORY = new URL('./data/', import.meta.url);

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`The emoji table could not be loaded (${response.status}).`);
    }
    return response.json();
}

function getDocumentLocale() {
    return globalThis.document?.documentElement?.lang || globalThis.navigator?.language || 'en';
}

function createTable(json) {
    if (!json || json.v !== TABLE_FORMAT || !Array.isArray(json.rows) || !Array.isArray(json.groups) || !Array.isArray(json.tones)) {
        throw new Error('The emoji table is not in the format that this version reads.');
    }
    let index = null;
    return {
        locale: String(json.locale),
        groups: json.groups,
        tones: json.tones,
        rows: json.rows,
        getIndex() {
            index ??= buildSearchIndex(json.rows);
            return index;
        },
    };
}

export function createEmojiTableLoader({ fetchJson: request = fetchJson, getLocale = getDocumentLocale } = {}) {
    /** @type {Map<string, Promise<EmojiTable>>} */
    const loads = new Map();

    function loadLocale(locale) {
        if (!loads.has(locale)) {
            const load = request(`${new URL(`emoji-${locale}.json`, DATA_DIRECTORY).href}?v=${DATA_VERSION}`).then(createTable);
            loads.set(locale, load);
            // A load that failed is forgotten, so that the next open tries again.
            load.catch(() => loads.delete(locale));
        }
        return loads.get(locale);
    }

    return {
        /** The table of the interface language. */
        load: () => loadLocale(pickEmojiLocale(getLocale())),
        /** The English table, which is the one above when the interface is English. */
        loadEnglish: () => loadLocale('en'),
    };
}

export const emojiTables = createEmojiTableLoader();
