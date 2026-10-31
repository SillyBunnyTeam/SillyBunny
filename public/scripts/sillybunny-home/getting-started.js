import { t } from '../i18n.js';
import { CHARACTER_VARIANTS } from './getting-started-storage.js';

/**
 * @typedef {object} GettingStartedStep
 * @property {'connect' | 'preset' | 'character' | 'chat'} id
 * @property {string} title
 * @property {boolean} optional
 * @property {string} slot Copy placeholder slot of the step's description.
 * @property {import('./shell-targets.js').SHELL_TARGETS[number]} target What Show Me opens.
 */

/** @returns {GettingStartedStep[]} */
export function getGettingStartedSteps() {
    return [
        { id: 'connect', title: t`Connect a Model`, optional: false, slot: 'GS-1-BODY', target: 'connections' },
        { id: 'preset', title: t`Set Up a Preset`, optional: true, slot: 'GS-2-BODY', target: 'presets' },
        { id: 'character', title: t`Get a Character Card`, optional: false, slot: 'GS-3-BODY', target: 'characters' },
        { id: 'chat', title: t`Start Chatting`, optional: false, slot: 'GS-4-BODY', target: 'mode-menu' },
    ];
}

/**
 * One translatable string, so a language can reorder the numbers.
 * @param {number} resolved
 * @param {number} total
 */
export function formatProgress(resolved, total) {
    return t`${resolved} of ${total}`;
}

/**
 * Reisen's art in the Getting Started window: the done pose once every step is resolved, done or skipped.
 * @param {number} resolved
 * @param {number} total
 * @returns {'gs-reisen' | 'gs-reisen-done'}
 */
export function getIntroArtName(resolved, total) {
    return total > 0 && resolved === total ? 'gs-reisen-done' : 'gs-reisen';
}

/**
 * Reisen's line in the Getting Started window: the done line once every step is resolved, done or skipped.
 * @param {number} resolved
 * @param {number} total
 * @returns {'GS-INTRO' | 'GS-INTRO-DONE'}
 */
export function getIntroLineSlot(resolved, total) {
    return total > 0 && resolved === total ? 'GS-INTRO-DONE' : 'GS-INTRO';
}

/**
 * The slot of the line under a step in the Getting Started window. A finished step 3 has a line of its own, which
 * follows the kind of card that finished it; every other row keeps the body of its step.
 * @param {GettingStartedStep} step
 * @param {Pick<ReturnType<typeof createGettingStartedState>, 'isDone' | 'getCharacterVariant'>} state
 * @param {string} [bodySlot] The slot to use while the step is open.
 * @returns {string}
 */
export function getStepLineSlot(step, state, bodySlot = step.slot) {
    if (step.id === 'character' && state.isDone('character')) {
        return `GS-3-DONE-${(state.getCharacterVariant() ?? 'other').toUpperCase()}`;
    }
    return bodySlot;
}

/**
 * The state behind the Getting Started tile, the window and the What's Next row. Home reads the state only
 * through this interface. Without `save` it lives in memory only; with it every change is written once.
 *
 * Each step is open, skipped or done, and done is never overwritten: a skipped step that gets its signal becomes
 * done, and Skip does nothing to a done step. The state hides itself once every step is resolved, and remembers
 * that it was the auto-hide, so un-skipping a step brings the tile back. A tile that an existing account starts
 * without stays hidden until `setHidden(false)`, which is what Show Getting Started does.
 * @param {readonly string[]} stepIds
 * @param {object} [options]
 * @param {import('./getting-started-storage.js').GettingStartedSnapshot} [options.snapshot] The stored value to start from.
 * @param {(snapshot: import('./getting-started-storage.js').GettingStartedSnapshot) => void} [options.save]
 */
export function createGettingStartedState(stepIds, { snapshot, save } = {}) {
    const known = new Set(stepIds);
    /** @type {Map<string, import('./getting-started-storage.js').StepStatus>} */
    const statuses = new Map(stepIds.map(id => [id, snapshot?.steps?.[id] ?? null]));
    const listeners = new Set();
    let hidden = snapshot?.hidden ?? false;
    /** @type {'auto' | 'account' | null} */
    let hiddenBy = snapshot?.hiddenBy ?? null;
    /** @type {import('./getting-started-storage.js').CharacterVariant | null} */
    let characterVariant = snapshot?.characterVariant ?? null;

    function requireKnown(id) {
        if (!known.has(id)) {
            throw new Error(`Unknown Getting Started step: ${id}`);
        }
    }

    const isDone = (id) => {
        requireKnown(id);
        return statuses.get(id) === 'done';
    };

    function getResolvedCount() {
        return [...known].filter(id => statuses.get(id) !== null).length;
    }

    function getSnapshot() {
        return {
            hidden,
            hiddenBy,
            steps: Object.fromEntries(stepIds.map(id => [id, statuses.get(id) ?? null])),
            characterVariant,
        };
    }

    /** Hides the tile when the last step is resolved, and shows it again when the auto-hide no longer holds. */
    function followResolvedCount() {
        const finished = getResolvedCount() === known.size;
        if (finished && !hidden) {
            hidden = true;
            hiddenBy = 'auto';
        } else if (!finished && hidden && hiddenBy === 'auto') {
            hidden = false;
            hiddenBy = null;
        }
    }

    /** One change is one write and one notification, however many of the fields it moved. */
    function commit() {
        save?.(getSnapshot());
        listeners.forEach(listener => listener());
    }

    return {
        getTotal: () => known.size,
        isDone,
        isSkipped(id) {
            requireKnown(id);
            return statuses.get(id) === 'skipped';
        },
        /**
         * Marks a step done, because the app saw what the step asks for. A skipped step becomes done as well.
         * @param {string} id
         * @param {{ variant?: string }} [details] The kind of card, for the character step.
         * @returns {boolean} Whether the step was not done before.
         */
        markDone(id, { variant } = {}) {
            requireKnown(id);
            if (statuses.get(id) === 'done') {
                return false;
            }
            statuses.set(id, 'done');
            if (id === 'character') {
                characterVariant = CHARACTER_VARIANTS.includes(/** @type {any} */ (variant)) ? /** @type {any} */ (variant) : 'other';
            }
            followResolvedCount();
            commit();
            return true;
        },
        setSkipped(id, isSkipped) {
            requireKnown(id);
            const status = statuses.get(id);
            if (status === 'done' || (status === 'skipped') === Boolean(isSkipped)) {
                return;
            }
            statuses.set(id, isSkipped ? 'skipped' : null);
            followResolvedCount();
            commit();
        },
        getResolvedCount,
        getCharacterVariant: () => characterVariant,
        isHidden: () => hidden,
        setHidden(isHidden) {
            if (hidden === Boolean(isHidden)) {
                return;
            }
            hidden = Boolean(isHidden);
            hiddenBy = hidden ? 'account' : null;
            commit();
        },
        getSnapshot,
        /** Writes the current value, for one that was never stored. */
        persist() {
            save?.(getSnapshot());
        },
        /** @param {() => void} listener @returns {() => void} Stops the listener. */
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

/** @type {ReturnType<typeof createGettingStartedState> | null} */
let sharedState = null;

/**
 * Home renders its panel again after many actions. One state for the page's lifetime keeps the progress
 * across those renders. The boot code installs the stored state before Home first renders; a state that nothing
 * installed lives in memory only.
 */
export function getSharedGettingStartedState() {
    sharedState ??= createGettingStartedState(getGettingStartedSteps().map(step => step.id));
    return sharedState;
}

/**
 * @param {ReturnType<typeof createGettingStartedState>} state The stored state for this account.
 */
export function setSharedGettingStartedState(state) {
    sharedState = state;
}
