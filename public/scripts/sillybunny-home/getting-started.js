import { t } from '../i18n.js';

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
 * The state behind the Getting Started tile. This one lives in memory only. Home reads the state only
 * through this interface, so a state that is stored and driven by real signals can take its place.
 * The state hides itself once every step is resolved; `setHidden(false)` shows it again.
 * @param {readonly string[]} stepIds
 */
export function createGettingStartedState(stepIds) {
    const known = new Set(stepIds);
    const skipped = new Set();
    const listeners = new Set();
    let hidden = false;

    function requireKnown(id) {
        if (!known.has(id)) {
            throw new Error(`Unknown Getting Started step: ${id}`);
        }
    }

    // Real signals will decide this later; until then no step finishes by itself.
    function isDone(id) {
        requireKnown(id);
        return false;
    }

    function getResolvedCount() {
        return [...known].filter(id => skipped.has(id) || isDone(id)).length;
    }

    function notify() {
        listeners.forEach(listener => listener());
    }

    return {
        getTotal: () => known.size,
        isDone,
        isSkipped(id) {
            requireKnown(id);
            return skipped.has(id);
        },
        setSkipped(id, isSkipped) {
            requireKnown(id);
            if (skipped.has(id) === Boolean(isSkipped)) {
                return;
            }
            if (isSkipped) {
                skipped.add(id);
            } else {
                skipped.delete(id);
            }
            hidden ||= getResolvedCount() === known.size;
            notify();
        },
        getResolvedCount,
        isHidden: () => hidden,
        setHidden(isHidden) {
            if (hidden === Boolean(isHidden)) {
                return;
            }
            hidden = Boolean(isHidden);
            notify();
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
 * across those renders, until a stored state replaces this one.
 */
export function getSharedGettingStartedState() {
    sharedState ??= createGettingStartedState(getGettingStartedSteps().map(step => step.id));
    return sharedState;
}
