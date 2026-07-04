/**
 * Pure helpers for batch embedded lorebook import.
 * Separated from world-info.js for testability.
 */

/**
 * Detects which characters have embedded lorebooks and whether their book names collide with existing worlds.
 * @param {Array<{chid: number, character: object}>} charList - Characters to check
 * @param {string[]} existingWorldNames - Currently saved world/lorebook names
 * @returns {Array<{chid: number, characterName: string, bookName: string, collision: boolean}>} Candidates with embedded lorebooks
 */
export function detectEmbeddedLorebookCandidates(charList, existingWorldNames) {
    const result = [];
    for (const { chid, character } of charList) {
        if (!character?.data?.character_book) {
            continue;
        }
        const bookName = character.data.character_book.name || `${character.name}'s Lorebook`;
        result.push({
            chid,
            characterName: character.name,
            bookName,
            collision: existingWorldNames.includes(bookName),
        });
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
