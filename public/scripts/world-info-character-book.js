/**
 * Resolves a single position value into a known World Info position enum ID.
 *
 * Numbers are accepted only when they belong to the enum (rejects out-of-range values
 * that the prompt builder would silently drop). Strings are trimmed and lowercased;
 * numeric strings undergo the same enum-membership check, and common CC/ST aliases
 * (`before_char`, `after_char`, `at_depth`, etc.) are mapped to their enum counterparts.
 *
 * @param {unknown} position Raw position value (number, string, or other)
 * @param {{ before: number, after: number, ANTop: number, ANBottom: number, atDepth: number, EMTop: number, EMBottom: number, outlet: number }} positions World Info position enum
 * @returns {number|undefined} A valid enum position, or `undefined` if unrecognizable
 */
export function normalizeWorldInfoPosition(position, positions) {
    const validValues = new Set(Object.values(positions));

    if (typeof position === 'number' && Number.isFinite(position)) {
        return validValues.has(position) ? position : undefined;
    }

    if (typeof position !== 'string') {
        return undefined;
    }

    const value = position.trim().toLowerCase();
    if (!value) {
        return undefined;
    }

    const numeric = Number(value);
    if (Number.isInteger(numeric)) {
        return validValues.has(numeric) ? numeric : undefined;
    }

    switch (value) {
        case 'before':
        case 'before_char':
        case 'before character':
            return positions.before;
        case 'after':
        case 'after_char':
        case 'after character':
            return positions.after;
        case 'an_top':
        case 'author_note_top':
            return positions.ANTop;
        case 'an_bottom':
        case 'author_note_bottom':
            return positions.ANBottom;
        case 'at_depth':
        case 'depth':
            return positions.atDepth;
        case 'em_top':
        case 'examples_top':
            return positions.EMTop;
        case 'em_bottom':
        case 'examples_bottom':
            return positions.EMBottom;
        case 'outlet':
            return positions.outlet;
        default:
            return undefined;
    }
}

/**
 * Normalizes character-book entry positions into SillyTavern/SillyBunny World Info position IDs.
 *
 * Character cards commonly store positions as CC/ST strings such as `before_char` or `after_char`.
 * Imported World Info entries must use numeric position IDs; leaving the strings intact prevents
 * activated entries from being inserted into the prompt.
 *
 * @param {unknown} extensionPosition Position from entry.extensions.position
 * @param {unknown} entryPosition Position from entry.position
 * @param {{ before: number, after: number, ANTop: number, ANBottom: number, atDepth: number, EMTop: number, EMBottom: number, outlet: number }} positions World Info position enum
 * @returns {number} Normalized World Info position
 */
export function normalizeCharacterBookPosition(extensionPosition, entryPosition, positions) {
    return normalizeWorldInfoPosition(extensionPosition, positions)
        ?? normalizeWorldInfoPosition(entryPosition, positions)
        ?? positions.after;
}
