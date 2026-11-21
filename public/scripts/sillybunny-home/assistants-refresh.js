const RETRY_MS = 250;

/**
 * Makes the assistant cards of a Home panel again once their status changed after they were made. The section is not
 * replaced while an action menu or any open dialog is there, because that would close the menu under the pointer or
 * move what the dialog was opened from. This holds for every dialog, not only the ones that Home opens, so a dialog
 * that stays open holds the change back until it closes. The check is made again until nothing is open, the status is
 * current, or the panel is replaced by a newer render, which reads the status itself.
 * @param {object} options
 * @param {HTMLElement} options.panel The Home panel the cards belong to.
 * @param {() => boolean} options.isStale Whether the status differs from the one the cards were made from.
 * @param {() => boolean} options.isBusy Whether a menu or a dialog is open.
 * @param {() => void} options.remount
 * @param {(callback: () => void, milliseconds: number) => unknown} [options.schedule]
 */
export function remountWhenIdle({ panel, isStale, isBusy, remount, schedule = setTimeout }) {
    const attempt = () => {
        if (!panel.isConnected || !isStale()) {
            return;
        }
        if (isBusy()) {
            schedule(attempt, RETRY_MS);
            return;
        }
        remount();
    };
    attempt();
}
