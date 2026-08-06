/**
 * Pure helpers for batch embedded lorebook import.
 * Separated from world-info.js for testability.
 */

function normalizeLorebookName(value) {
    return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Finds a persisted lorebook name, preferring an exact match before equivalent spellings.
 * @param {string[]} names Persisted lorebook names
 * @param {string} target Requested lorebook name
 * @returns {string|undefined} Matching persisted name
 */
export function findMatchingLorebookName(names, target) {
    return names.find(name => name === target)
        ?? names.find(name => normalizeLorebookName(name) === normalizeLorebookName(target));
}

/**
 * Detects which characters have embedded lorebooks and whether their book names collide with existing worlds.
 * @param {Array<{chid: number, character: object}>} charList - Characters to check
 * @param {string[]} existingWorldNames - Currently saved world/lorebook names
 * @param {Map<number, string>} [canonicalNames] Canonical book names keyed by character ID
 * @returns {Array<{chid: number, characterName: string, bookName: string, collision: boolean}>} Candidates with embedded lorebooks
 */
export function detectEmbeddedLorebookCandidates(charList, existingWorldNames, canonicalNames = new Map()) {
    const result = [];
    const reservedNames = new Set(existingWorldNames.map(normalizeLorebookName));
    for (const { chid, character } of charList) {
        if (!character?.data?.character_book) {
            continue;
        }
        const rawBookName = character.data.character_book.name || `${character.name}'s Lorebook`;
        const bookName = canonicalNames.get(chid) ?? rawBookName;
        if (!bookName) {
            continue;
        }
        result.push({
            chid,
            characterName: character.name,
            bookName,
            collision: reservedNames.has(normalizeLorebookName(bookName)),
        });
        reservedNames.add(normalizeLorebookName(bookName));
    }
    return result;
}

/**
 * Checks whether a character's embedded lorebook is already covered by a saved world link,
 * either via the primary character world or via an auxiliary world book.
 * @param {string} bookName - The embedded lorebook name
 * @param {string|undefined} primaryWorld - The character's primary world (data.extensions.world)
 * @param {string[]} auxBooks - Auxiliary world book names linked to the character
 * @param {string[]} worldNames - Currently saved world/lorebook names
 * @returns {boolean} True when the embedded book does not need an import prompt
 */
export function isEmbeddedBookLinked(bookName, primaryWorld, auxBooks, worldNames) {
    if (primaryWorld && worldNames.includes(primaryWorld)) {
        return true;
    }
    return Array.isArray(auxBooks) && auxBooks.includes(bookName) && worldNames.includes(bookName);
}

/**
 * Returns the list of auxiliary world book names already linked to a character file name.
 * @param {Array<{name: string, extraBooks?: string[]}>} charLore - The charLore settings array
 * @param {string} fileName - The character file name (avatar without extension)
 * @returns {string[]} Already linked auxiliary book names
 */
export function getLinkedAuxBooks(charLore, fileName) {
    if (!Array.isArray(charLore) || !fileName) {
        return [];
    }
    const entry = charLore.find(e => e.name === fileName);
    return Array.isArray(entry?.extraBooks) ? entry.extraBooks : [];
}
