/**
 * Search over the rows of an emoji table. Pure: the chooser builds the index once after the table loads and asks for
 * the ranked row indexes of each query.
 *
 * A row is `[emoji, name, keywords joined with "|", group, version, variants?]` (`emoji-table.js`).
 */

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const DEFAULT_LIMIT = 200;

/** NFKD, no combining marks, lower case: what a name and a query are compared as. */
export function foldText(text) {
    return String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

function splitWords(text) {
    return text.split(WORD_SPLIT).filter(Boolean);
}

/**
 * @param {Array<Array<any>>} rows
 * @returns {Array<{ name: string, nameWords: string[], keywordWords: string[], haystack: string }>}
 */
export function buildSearchIndex(rows) {
    return rows.map((row) => {
        const name = foldText(row[1]);
        const keywords = foldText(row[2]);
        return { name, nameWords: splitWords(name), keywordWords: splitWords(keywords), haystack: `${name}|${keywords}` };
    });
}

const startsAWord = (words, token) => words.some(word => word.startsWith(token));

/** 0 exact name, 1 name starts with the query, 2 every word starts a word of the name, 3 or of a keyword, 4 inside the text, -1 no match. */
function rankEntry(entry, query, tokens) {
    if (entry.name === query) {
        return 0;
    }
    if (entry.name.startsWith(query)) {
        return 1;
    }
    if (tokens.every(token => startsAWord(entry.nameWords, token))) {
        return 2;
    }
    if (tokens.every(token => startsAWord(entry.nameWords, token) || startsAWord(entry.keywordWords, token))) {
        return 3;
    }
    return tokens.every(token => entry.haystack.includes(token)) ? 4 : -1;
}

/**
 * @param {ReturnType<typeof buildSearchIndex>} index
 * @param {string} rawQuery
 * @returns {number[]} Row indexes, best rank first, the order of the table among equal ranks.
 */
export function searchRows(index, rawQuery, { limit = DEFAULT_LIMIT } = {}) {
    const query = foldText(rawQuery);
    if (!query) {
        return [];
    }
    const tokens = query.split(/\s+/).filter(Boolean);
    const ranked = [];
    index.forEach((entry, position) => {
        const rank = rankEntry(entry, query, tokens);
        if (rank >= 0) {
            ranked.push({ position, rank });
        }
    });
    ranked.sort((left, right) => left.rank - right.rank || left.position - right.position);
    return ranked.slice(0, limit).map(item => item.position);
}
