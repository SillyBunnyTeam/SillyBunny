import { t } from '../i18n.js';
import { CHARACTER_VARIANTS } from './getting-started-storage.js';

/**
 * @typedef {object} GettingStartedStep
 * @property {'connect' | 'preset' | 'character' | 'chat'} id
 * @property {string} title
 * @property {boolean} optional
 * @property {() => string} getBody The description of the step while it is open.
 * @property {import('./shell-targets.js').SHELL_TARGETS[number]} target What Show Me opens.
 * @property {string} helpTopic Id of the Help topic that Learn More opens.
 */

/** @returns {GettingStartedStep[]} */
export function getGettingStartedSteps() {
    return [
        {
            id: 'connect',
            title: t`Connect a Model`,
            optional: false,
            getBody: () => t`A model is the AI that writes the replies. You'll need a key from a provider, or a model running on your own computer. I'll mark this off once you've established a connection.`,
            target: 'connections',
            helpTopic: 'connect-to-a-model',
        },
        {
            id: 'preset',
            title: t`Set Up a Preset`,
            optional: true,
            getBody: () => t`A preset shapes how replies are written: their length, writing style, and rules. Of course, you can skip this and stick to the defaults if you'd like - we've provided a few to get you started!`,
            target: 'presets',
            helpTopic: 'choose-a-preset',
        },
        {
            id: 'character',
            title: t`Get a Character Card`,
            optional: false,
            getBody: () => t`A character card holds a character's personality and their written scenario. Feel free to import a card you like, or open a chat with a character you already have, like Tewi or me!`,
            target: 'characters',
            helpTopic: 'add-a-character',
        },
        {
            id: 'chat',
            title: t`Start Chatting`,
            optional: false,
            getBody: () => t`Well done! Now you can send your first message! Roleplay is the traditional way to interact with your character, following their greeting and scenario. Conversation is a direct, messenger-style chat.`,
            target: 'mode-menu',
            helpTopic: 'start-a-chat',
        },
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
 * @returns {string}
 */
export function getIntroLine(resolved, total) {
    return total > 0 && resolved === total
        ? t`You did it! Everything's set up. Start a chat whenever you're ready, and come find me in your Home screen if anything puzzles you.`
        : t`Just follow these four small steps, and you'll be ready for your first chat! I'll show you where everything is.`;
}

/**
 * The line under a step in the Getting Started window. A finished step 3 has a line of its own, which follows the
 * kind of card that finished it; every other row keeps the body of its step.
 * @param {GettingStartedStep} step
 * @param {Pick<ReturnType<typeof createGettingStartedState>, 'isDone' | 'getCharacterVariant'>} state
 * @returns {string}
 */
export function getStepLine(step, state) {
    if (step.id !== 'character' || !state.isDone('character')) {
        return step.getBody();
    }
    switch (state.getCharacterVariant()) {
        case 'reisen': return t`You picked me? I'll do my very best to help you!`;
        case 'tewi': return t`Gege~ Of course you picked me. Better luck next time, Udonge!`;
        default: return t`Ooh, a good pick! We hope you two get along well.`;
    }
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
