/**
 * Normalizes probability fields from native and CharacterBook-shaped entries.
 * @param {object} entry World Info entry
 * @returns {object} Entry with native probability fields
 */
export function normalizeWorldInfoProbability(entry) {
    const rawProbability = entry.probability ?? entry.extensions?.probability ?? 100;
    const probability = Number(rawProbability);
    return {
        ...entry,
        probability: Number.isFinite(probability) ? probability : 100,
        useProbability: entry.useProbability ?? entry.extensions?.useProbability ?? true,
    };
}

/**
 * Tests whether an entry passes its probability check.
 * @param {object} entry Normalized World Info entry
 * @param {() => number} random Random source returning a value in [0, 1)
 * @param {boolean} isSticky Whether the entry is currently sticky
 * @returns {boolean} Whether the entry passes
 */
export function passesWorldInfoProbability(entry, random = Math.random, isSticky = false) {
    if (!entry.useProbability || isSticky) {
        return true;
    }

    const probability = Number(entry.probability);
    if (!Number.isFinite(probability) || probability >= 100) {
        return true;
    }
    if (probability <= 0) {
        return false;
    }

    return random() * 100 < probability;
}

/**
 * Substitutes and trims a World Info key.
 * @param {unknown} key Raw key
 * @param {(value: string) => string} substitute Substitution function
 * @returns {string|null} A usable key, or null when empty
 */
export function normalizeWorldInfoKey(key, substitute) {
    if (typeof key !== 'string') {
        return null;
    }

    const normalized = substitute(key)?.trim();
    return normalized || null;
}

/**
 * Parses an entry's comma-separated inclusion groups.
 * @param {unknown} group Raw group field
 * @returns {string[]} Trimmed unique group names
 */
export function getWorldInfoGroupNames(group) {
    if (typeof group !== 'string') {
        return [];
    }

    return [...new Set(group.split(',').map(value => value.trim()).filter(Boolean))];
}

/**
 * Gets the stable identity used across scan passes.
 * @param {object} entry World Info entry
 * @returns {string} Stable identity
 */
export function getWorldInfoEntryKey(entry) {
    return `${entry.world}.${entry.uid}`;
}

/**
 * Computes the persisted activity window for a World Info timed effect.
 *
 * `start` is the chat length when the effect is created. The scanner removes an
 * effect once `chat.length >= end`, and discards a non-protected effect when
 * `chat.length <= start` (the chat did not advance, e.g. a swipe). A
 * non-protected effect of duration `d` created at chat length `N` is therefore
 * active for scans at chat lengths `N+1` through `N+d` — the extra message in
 * `end` keeps a duration-1 effect from expiring before it ever applies.
 * Protected effects (a cooldown started by an ended sticky) already cover the
 * creating scan via an immediate buffer push, so their persisted window is not
 * extended: scans `N+1` through `N+d-1` plus the creating scan give `d` total.
 *
 * @param {number} chatLength Chat length when the effect is created
 * @param {number} duration Effect duration in messages
 * @param {boolean} isProtected Whether the effect survives without the chat advancing
 * @returns {{ start: number, end: number }} Effect window
 */
export function getTimedEffectWindow(chatLength, duration, isProtected) {
    return {
        start: chatLength,
        end: chatLength + Number(duration) + (isProtected ? 0 : 1),
    };
}
