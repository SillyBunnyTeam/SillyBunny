import { getRequestHeaders } from '../../script.js';
import { t } from '../i18n.js';
import { isActionMenuOpen } from '../sillybunny-action-menu.js';
import { accountStorage } from '../util/AccountStorage.js';
import { reportFailure } from './assistant-chat.js';
import { createManagedActions } from './assistant-managed-actions.js';
import { remountWhenIdle } from './assistants-refresh.js';
import { DISMISSED_KEY, createManagedContentClient, parseDismissed, serializeDismissed } from './managed-content.js';
import { createManagedStatus } from './managed-status.js';

// The first render of Home waits this long for the status at most. A later answer replaces the cards when it arrives.
const FIRST_MOUNT_WAIT_MS = 300;
// A request that takes longer than this is given up, so a hung server does not leave a read open for good.
const REQUEST_TIMEOUT_MS = 5000;

const isOverlayOpen = () => isActionMenuOpen() || document.querySelector('dialog[open]') !== null;

/**
 * Restore and Update Available over the app: the managed content routes of the server, the account's kept versions
 * and the dialogs of Home.
 * @param {object} options
 * @param {(change: { filename: string, fileChanged: boolean }) => Promise<void>} options.afterChange Shows the result
 *   in Home, which reads the library again when a file changed.
 */
export function createAppManagedAssistants({ afterChange }) {
    const client = createManagedContentClient({ fetch: (...request) => fetch(...request), getHeaders: () => getRequestHeaders() });
    const status = createManagedStatus({
        loadStatus: options => client.loadStatus(options),
        firstMountWaitMs: FIRST_MOUNT_WAIT_MS,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });

    const getDismissed = () => parseDismissed(accountStorage.getItem(DISMISSED_KEY));

    const actions = createManagedActions({
        client,
        askUpdate: async card => (await import('./managed-update-alert.js')).openManagedUpdateAlert(card.name),
        getDismissed,
        saveDismissed: dismissed => accountStorage.setItem(DISMISSED_KEY, serializeDismissed(dismissed)),
        notifyUpdated: card => globalThis.toastr?.success(t`Updated ${card.name}. A backup of your version was kept.`),
        afterChange: async (change) => {
            if (change.fileChanged) {
                status.markCurrent(change.filename);
            }
            await afterChange(change);
        },
        reportFailure,
    });

    return {
        /** Starts a read of the status for a render of Home. @returns {Promise<void>} */
        refreshStatus: () => status.refresh(),
        waitForFirstAnswer: pending => status.waitForFirstAnswer(pending),
        getManaged: () => ({ items: status.read(), dismissed: getDismissed() }),
        actions,
        /**
         * Replaces the cards of a panel when the status that arrives later differs from the one they were made from.
         * @param {object} options
         * @param {HTMLElement} options.panel
         * @param {{ remountAssistants: () => void }} options.home What `mountHome` returned for the panel.
         * @param {Promise<void>} options.pending The read that the render of the panel started.
         */
        keepCardsCurrent({ panel, home, pending }) {
            void pending.then(() => remountWhenIdle({ panel, isStale: status.isStale, isBusy: isOverlayOpen, remount: home.remountAssistants }));
        },
    };
}
