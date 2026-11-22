/*
 * SillyBunny: the Toasts position setting (`power_user.toast_position`). The Notifications setting
 * (`power_user.toastr_position`) is upstream's and keeps its own code in power-user.js.
 */

import { setToastPosition } from './sillybunny-toast-motion.js';

export const TOAST_POSITION_SELECT_ID = 'toast_position';
export const DEFAULT_TOAST_POSITION = 'toast-bottom-center';

/**
 * @param {unknown} value A saved position.
 * @param {readonly string[]} positionClasses The positions that the setting offers.
 * @returns {string} The value when the setting offers it, otherwise the default.
 */
export function parseToastPosition(value, positionClasses) {
    return positionClasses.includes(value) ? value : DEFAULT_TOAST_POSITION;
}

/**
 * Moves the toast overlay to the saved position and shows it in the select. A saved value that is not a position is
 * replaced with the default in `settings`.
 * @param {{ toast_position?: unknown }} settings
 * @param {readonly string[]} positionClasses
 * @returns {string} The position in use.
 */
export function applyToastPosition(settings, positionClasses) {
    const position = parseToastPosition(settings.toast_position, positionClasses);
    if (position !== settings.toast_position) {
        console.warn(`applyToastPosition: invalid toast position, defaulting to ${DEFAULT_TOAST_POSITION}`);
        settings.toast_position = position;
    }
    setToastPosition(position);
    showInSelect(position);
    return position;
}

/**
 * A change of the select stores the position, moves the overlay and runs `onChange` when the stored position is a new one.
 * @param {{ toast_position?: unknown }} settings
 * @param {readonly string[]} positionClasses
 * @param {() => void} onChange Saves the settings.
 */
export function bindToastPositionSelect(settings, positionClasses, onChange) {
    const select = document.getElementById(TOAST_POSITION_SELECT_ID);
    select?.addEventListener('change', () => {
        const previous = settings.toast_position;
        settings.toast_position = select.value;
        applyToastPosition(settings, positionClasses);
        if (settings.toast_position !== previous) {
            onChange();
        }
    });
}

/**
 * The select row redraws on a `change` event, and a value written by script does not fire one. The event is skipped when
 * the select already shows the position, so that the handler of the select does not run again on its own write.
 */
function showInSelect(position) {
    const select = document.getElementById(TOAST_POSITION_SELECT_ID);
    if (!(select instanceof HTMLSelectElement) || select.value === position) {
        return;
    }
    select.value = position;
    select.dispatchEvent(new Event('change', { bubbles: true }));
}
