/** The account storage key that keeps the progress of Getting Started. */
export const GETTING_STARTED_STORAGE_KEY = 'WelcomePage_GettingStarted';

const STEP_STATUSES = Object.freeze(['done', 'skipped']);
const HIDDEN_REASONS = Object.freeze(['auto', 'account']);
export const CHARACTER_VARIANTS = Object.freeze(['reisen', 'tewi', 'other']);

/**
 * @typedef {'done' | 'skipped' | null} StepStatus
 * @typedef {'reisen' | 'tewi' | 'other'} CharacterVariant
 * @typedef {object} GettingStartedSnapshot
 * @property {boolean} hidden
 * @property {'auto' | 'account' | null} hiddenBy Why the tile is hidden: Hide Getting Started on a finished list, or
 *   the default of an account that existed before Getting Started. Only the first one ends when a step is open again.
 * @property {Record<string, StepStatus>} steps
 * @property {CharacterVariant | null} characterVariant The kind of card that finished the character step, which
 *   picks the line of its done row.
 */

/**
 * @param {readonly string[]} stepIds
 * @param {boolean} existingAccount
 * @returns {GettingStartedSnapshot}
 */
function createDefaults(stepIds, existingAccount) {
    return {
        hidden: existingAccount,
        hiddenBy: existingAccount ? 'account' : null,
        steps: Object.fromEntries(stepIds.map(id => [id, null])),
        characterVariant: null,
    };
}

/**
 * @param {string | null | undefined} raw
 * @returns {Record<string, unknown> | null} The parsed object, or null for anything that is not one.
 */
function parseObject(raw) {
    if (typeof raw !== 'string') {
        return null;
    }
    try {
        const value = JSON.parse(raw);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Reads the stored value. A value that is missing, damaged or only partly valid never throws: each part that is not
 * valid takes the default of the account. A fresh install starts shown. An account that existed before Getting
 * Started (no value, and the first run is over) starts hidden until the user chooses Show Getting Started.
 * @param {object} options
 * @param {string | null | undefined} options.raw What the account storage holds.
 * @param {readonly string[]} options.stepIds
 * @param {boolean} options.firstRun Whether this boot is the first run of a fresh install.
 * @returns {{ snapshot: GettingStartedSnapshot, isNew: boolean }} `isNew` tells that nothing usable was stored, so
 *   the caller has to write the defaults, or a fresh install would look like an old account on the next boot.
 */
export function loadGettingStartedSnapshot({ raw, stepIds, firstRun }) {
    const defaults = createDefaults(stepIds, !firstRun);
    const stored = parseObject(raw);
    if (!stored) {
        return { snapshot: defaults, isNew: true };
    }

    const storedSteps = stored.steps !== null && typeof stored.steps === 'object' ? /** @type {Record<string, unknown>} */ (stored.steps) : {};
    const steps = Object.fromEntries(stepIds.map(id => [id, STEP_STATUSES.includes(/** @type {string} */ (storedSteps[id])) ? storedSteps[id] : null]));
    const hidden = typeof stored.hidden === 'boolean' ? stored.hidden : defaults.hidden;
    const hiddenBy = hidden
        ? (HIDDEN_REASONS.includes(/** @type {string} */ (stored.hiddenBy)) ? stored.hiddenBy : 'account')
        : null;
    const characterVariant = steps.character === 'done' && CHARACTER_VARIANTS.includes(/** @type {string} */ (stored.characterVariant))
        ? stored.characterVariant
        : null;

    return { snapshot: /** @type {GettingStartedSnapshot} */ ({ hidden, hiddenBy, steps, characterVariant }), isNew: false };
}

/**
 * @param {GettingStartedSnapshot} snapshot
 * @returns {string}
 */
export function serializeGettingStartedSnapshot(snapshot) {
    const value = { hidden: snapshot.hidden, steps: snapshot.steps };
    if (snapshot.hiddenBy) {
        value.hiddenBy = snapshot.hiddenBy;
    }
    if (snapshot.characterVariant) {
        value.characterVariant = snapshot.characterVariant;
    }
    return JSON.stringify(value);
}
