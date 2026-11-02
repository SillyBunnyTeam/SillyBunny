import { withKeptVersion } from './managed-content.js';

/**
 * What Restore and Update Available do for a card. The requests, the question and the account are `deps`, so this
 * module only decides the order of the steps and stays a unit that runs without the app.
 *
 * @typedef {object} ManagedActionDeps
 * @property {{ apply: (filename: string) => Promise<unknown>, restore: (filename: string) => Promise<unknown> }} client
 * @property {() => Promise<'update' | 'keep' | 'cancel'>} askUpdate Asks whether the edited card becomes the bundled one.
 * @property {() => Map<string, number>} getDismissed The versions that the user kept their card against.
 * @property {(dismissed: Map<string, number>) => void} saveDismissed
 * @property {(card: OfferingCard) => void} notifyUpdated Tells the user that the update went through.
 * @property {(change: { filename: string, fileChanged: boolean }) => Promise<void>} afterChange Shows the result: reads
 *   the cards again when a file changed, and renders Home.
 * @property {() => void} reportFailure Tells the user that the request could not be done.
 *
 * @typedef {{ name: string, offers: import('./managed-content.js').ManagedOffers }} OfferingCard
 */

/** The status the server answers with when a request no longer matches the file, which the offer was read from. */
const CONFLICT = 409;

/**
 * @param {ManagedActionDeps} deps
 */
export function createManagedActions({ client, askUpdate, getDismissed, saveDismissed, notifyUpdated, afterChange, reportFailure }) {
    let busy = false;

    /**
     * Shows a change that the server has already made. A failure here is not a failure of the action, so the user is
     * not told that it failed: the file is as they asked, and the next render of Home shows it.
     * @param {{ filename: string, fileChanged: boolean }} change
     */
    async function show(change) {
        try {
            await afterChange(change);
        } catch (error) {
            console.error('Could not show the change of the bundled assistant.', error);
        }
    }

    /**
     * Runs one action. An activation while another action runs is dropped, which is what a double click is, and the
     * question of an update counts as running. Nothing escapes: a request that fails is told to the user.
     * @param {string} filename
     * @param {() => Promise<boolean>} work Resolves whether the user's choice changed anything.
     * @returns {Promise<boolean>} What `work` resolved, or false when it did not run or failed.
     */
    async function run(filename, work) {
        if (busy) {
            return false;
        }
        busy = true;
        try {
            return await work();
        } catch (error) {
            console.error('Could not change the bundled assistant.', error);
            reportFailure();
            // A refusal for a state that has changed leaves an offer on Home that can never succeed, so Home reads it again.
            if (error?.httpStatus === CONFLICT) {
                await show({ filename, fileChanged: false });
            }
            return false;
        } finally {
            busy = false;
        }
    }

    /** @param {OfferingCard} card */
    function restore(card) {
        const { filename, restore: canRestore } = card.offers;
        if (!canRestore || !filename) {
            return Promise.resolve(false);
        }
        // The card coming back is the answer the user sees, so there is no message for it.
        return run(filename, async () => {
            await client.restore(filename);
            await show({ filename, fileChanged: true });
            return true;
        });
    }

    /** @param {OfferingCard} card */
    function update(card) {
        const { filename, update: offered } = card.offers;
        if (!offered || !filename) {
            return Promise.resolve(false);
        }
        return run(filename, async () => {
            const answer = await askUpdate();
            if (answer === 'keep') {
                saveDismissed(withKeptVersion(getDismissed(), filename, offered.version));
                await show({ filename, fileChanged: false });
                return true;
            }
            if (answer !== 'update') {
                return false;
            }
            await client.apply(filename);
            notifyUpdated(card);
            await show({ filename, fileChanged: true });
            return true;
        });
    }

    return { restore, update };
}
