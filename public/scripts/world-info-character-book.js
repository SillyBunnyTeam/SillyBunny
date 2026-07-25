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

/**
 * Escapes regex delimiter slashes without adding duplicate escaping on repeated conversions.
 * @param {string} value Raw CharacterBook regex
 * @returns {string} Regex body safe for slash-delimited storage
 */
export function escapeCharacterBookRegex(value) {
    return String(value).replace(/(\\*)\//g, (_match, backslashes) => {
        const delimiterEscape = backslashes.length % 2 === 0 ? '\\' : '';
        return `${backslashes}${delimiterEscape}/`;
    });
}

function unescapeCharacterBookRegex(value) {
    return String(value).replace(/(\\*)\//g, (_match, backslashes) => {
        const rawBackslashes = backslashes.length % 2 === 1 ? backslashes.slice(0, -1) : backslashes;
        return `${rawBackslashes}/`;
    });
}

function parseWorldInfoRegexKey(value) {
    const match = String(value).match(/^\/([\s\S]+)\/([gimsuy]*)$/);
    if (!match) {
        return null;
    }

    const body = match[1];
    for (let index = 0; index < body.length; index++) {
        if (body[index] !== '/') {
            continue;
        }
        let backslashes = 0;
        for (let cursor = index - 1; cursor >= 0 && body[cursor] === '\\'; cursor--) {
            backslashes++;
        }
        if (backslashes % 2 === 0) {
            return null;
        }
    }

    try {
        RegExp(body, match[2]);
        return match;
    } catch {
        return null;
    }
}

/**
 * Serializes internal slash-delimited keys for CharacterBook storage.
 * @param {string[]} primaryKeys Primary entry keys
 * @param {string[]} secondaryKeys Secondary entry keys
 * @returns {{keys: string[], secondaryKeys: string[], useRegex: boolean}} Serialized keys and regex mode
 */
export function serializeCharacterBookKeys(primaryKeys = [], secondaryKeys = []) {
    const allKeys = [...primaryKeys, ...secondaryKeys];
    const parsedKeys = allKeys.map(parseWorldInfoRegexKey);
    const useRegex = allKeys.length > 0 && parsedKeys.every(Boolean);
    const serializeKey = key => {
        if (!useRegex) {
            return key;
        }
        const match = parseWorldInfoRegexKey(key);
        return match?.[2] ? key : unescapeCharacterBookRegex(match?.[1] ?? key);
    };
    return {
        keys: primaryKeys.map(serializeKey),
        secondaryKeys: secondaryKeys.map(serializeKey),
        useRegex,
    };
}

/**
 * Serializes a native World Info entry into a CharacterBook-format record.
 *
 * Uses the per-entry layout of the server-side character book converter
 * (src/endpoints/characters.js, convertWorldInfoToCharacterBook) so records
 * appended to a book's originalData are complete rather than lossy. Legacy
 * positions (e.g. the string '0') are normalized before choosing the
 * before_char/after_char label; anything that does not normalize to
 * `positions.before` serializes as 'after_char', matching server semantics.
 *
 * @param {object} entry Native World Info entry
 * @param {{ before: number, after: number, ANTop: number, ANBottom: number, atDepth: number, EMTop: number, EMBottom: number, outlet: number }} positions World Info position enum
 * @param {object} [originalEntry={}] Existing CharacterBook record whose unknown metadata should be preserved
 * @returns {object} CharacterBook-format entry record
 */
export function serializeWorldInfoEntry(entry, positions, originalEntry = {}) {
    const { keys, secondaryKeys, useRegex } = serializeCharacterBookKeys(entry.key ?? [], entry.keysecondary ?? []);
    const normalizedPosition = normalizeWorldInfoPosition(entry.position, positions);
    const serializedEntry = {
        ...originalEntry,
        id: entry.uid,
        keys,
        secondary_keys: secondaryKeys,
        comment: entry.comment ?? '',
        content: entry.content ?? '',
        constant: entry.constant ?? false,
        selective: entry.selective ?? false,
        insertion_order: entry.order ?? 100,
        enabled: !entry.disable,
        position: normalizedPosition === positions.before ? 'before_char' : 'after_char',
        use_regex: useRegex,
        case_sensitive: entry.caseSensitive ?? null,
        extensions: {
            ...originalEntry.extensions,
            ...entry.extensions,
            position: normalizedPosition ?? entry.position,
            exclude_recursion: entry.excludeRecursion ?? false,
            display_index: entry.displayIndex,
            probability: entry.probability ?? null,
            useProbability: entry.useProbability ?? false,
            depth: entry.depth ?? 4,
            selectiveLogic: entry.selectiveLogic ?? 0,
            outlet_name: entry.outletName ?? '',
            group: entry.group ?? '',
            group_override: entry.groupOverride ?? false,
            group_weight: entry.groupWeight ?? null,
            prevent_recursion: entry.preventRecursion ?? false,
            delay_until_recursion: entry.delayUntilRecursion ?? false,
            scan_depth: entry.scanDepth ?? null,
            match_whole_words: entry.matchWholeWords ?? null,
            use_group_scoring: entry.useGroupScoring ?? false,
            case_sensitive: entry.caseSensitive ?? null,
            automation_id: entry.automationId ?? '',
            role: entry.role ?? 0,
            vectorized: entry.vectorized ?? false,
            sticky: entry.sticky ?? null,
            cooldown: entry.cooldown ?? null,
            delay: entry.delay ?? null,
            match_persona_description: entry.matchPersonaDescription ?? false,
            match_character_description: entry.matchCharacterDescription ?? false,
            match_character_personality: entry.matchCharacterPersonality ?? false,
            match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
            match_scenario: entry.matchScenario ?? false,
            match_creator_notes: entry.matchCreatorNotes ?? false,
            triggers: entry.triggers ?? [],
            ignore_budget: entry.ignoreBudget ?? false,
            agent_blacklisted: entry.agentBlacklisted ?? false,
        },
    };

    if (entry.characterFilter === undefined) {
        delete serializedEntry.character_filter;
    } else {
        serializedEntry.character_filter = entry.characterFilter;
    }

    return serializedEntry;
}
