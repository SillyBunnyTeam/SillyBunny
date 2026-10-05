import { getRequestHeaders } from '../script.js';
import { event_types, eventSource } from './events.js';
import { isAdmin } from './user.js';
import { accountStorage } from './util/AccountStorage.js';

export const INSTALL_NOTICE_STORAGE_KEY = 'sillybunny_install_notice';

/**
 * Shows admins a once-a-day notice when this copy is neither a Git checkout nor Docker.
 * The server answers from local state only, so this never reaches GitHub.
 * @param {object} [deps] Overrides for tests.
 * @returns {Promise<boolean>} True when the notice was shown.
 */
export async function doInstallNoticeCheck({
    storage = accountStorage,
    checkAdmin = isAdmin,
    fetchImpl = globalThis.fetch,
    getHeaders = getRequestHeaders,
    notify = (message, title) => globalThis.toastr?.warning(message, title, { timeOut: 0, extendedTimeOut: 0, closeButton: true }),
    now = new Date(),
} = {}) {
    if (!checkAdmin()) {
        return false;
    }

    const today = now.toDateString();
    if (storage.getItem(INSTALL_NOTICE_STORAGE_KEY) === today) {
        return false;
    }

    let installType = '';
    try {
        const response = await fetchImpl('/api/server-admin/install-type', {
            method: 'POST',
            headers: getHeaders(),
            body: '{}',
        });
        if (!response.ok) {
            return false;
        }
        installType = (await response.json())?.installType ?? '';
    } catch {
        return false;
    }

    storage.setItem(INSTALL_NOTICE_STORAGE_KEY, today);

    if (installType !== 'unsupported') {
        return false;
    }

    notify('This copy of SillyBunny was not installed with Git, so it cannot update. Reinstall with the installer from the latest release to keep getting updates: https://github.com/SillyBunnyTeam/SillyBunny/releases/latest', 'Updates unavailable');
    return true;
}

/**
 * Runs the check once the app is ready. APP_READY auto-fires for late listeners, so this is safe at any point.
 */
export function initInstallNotice() {
    eventSource.once(event_types.APP_READY, () => {
        void doInstallNoticeCheck().catch(error => console.debug('[SillyBunny] Install notice check failed.', error));
    });
}
