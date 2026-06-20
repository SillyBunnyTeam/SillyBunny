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
