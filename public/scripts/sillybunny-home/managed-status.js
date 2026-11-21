import { describeOffers } from './managed-content.js';

const signatureOf = items => JSON.stringify(describeOffers(items));
const wait = milliseconds => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

/**
 * The last status that the server answered with, which Home reads at once on every render. A render never waits for
 * a new answer after the first one, because a slow server would then hold up every pin, rename and pointer change.
 * The answer is read in the background, and `isStale` tells Home when it would change what the cards offer.
 * @param {object} options
 * @param {(options: { signal: AbortSignal }) => Promise<import('./managed-content.js').ManagedItem[]>} options.loadStatus
 * @param {number} options.firstMountWaitMs How long the first render of Home may wait for the first answer.
 * @param {number} options.requestTimeoutMs How long a request may take before it is given up.
 * @param {(milliseconds: number) => Promise<void>} [options.delay]
 */
export function createManagedStatus({ loadStatus, firstMountWaitMs, requestTimeoutMs, delay = wait }) {
    /** @type {import('./managed-content.js').ManagedItem[] | null} */
    let items = null;
    let shown = signatureOf(items);
    let latestRequest = 0;
    let answered = false;

    return {
        /**
         * Reads the status. It never rejects: a status that could not be read leaves the last known one in place, so
         * a server that fails for a moment does not take the offers away from Home.
         * @returns {Promise<void>}
         */
        async refresh() {
            const request = ++latestRequest;
            let loaded = null;
            try {
                loaded = await loadStatus({ signal: AbortSignal.timeout(requestTimeoutMs) });
            } catch (error) {
                console.warn('Could not read the status of the bundled assistants.', error);
            }
            answered = true;
            // Two reads can overlap, and an answer that arrives after a newer read began must not replace the newer one.
            if (loaded !== null && request === latestRequest) {
                items = loaded;
            }
        },

        /**
         * Lets the first render of Home wait for the first answer, but only so long. Every later render gets no wait.
         * @param {Promise<void>} pending The read that this render started.
         * @returns {Promise<void>}
         */
        async waitForFirstAnswer(pending) {
            if (!answered) {
                await Promise.race([pending, delay(firstMountWaitMs)]);
            }
        },

        /**
         * The server answers `current` for a file after a Restore or an Update went through. Home takes that as known
         * at once, and a read that began earlier is dropped, because it may still describe the file as it was.
         * @param {string} filename
         */
        markCurrent(filename) {
            latestRequest += 1;
            items = items?.map(item => (item.filename === filename ? { ...item, status: 'current', updateAvailable: false } : item)) ?? null;
        },

        /** @returns {import('./managed-content.js').ManagedItem[] | null} What the cards that are made now are made from. */
        read() {
            shown = signatureOf(items);
            return items;
        },

        /** @returns {boolean} Whether the status differs from the one that `read` last returned. */
        isStale() {
            return signatureOf(items) !== shown;
        },
    };
}
