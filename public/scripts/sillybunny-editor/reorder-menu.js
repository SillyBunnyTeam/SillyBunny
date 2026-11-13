/**
 * The move section of a reorderable row's action menu, shared by every list that keeps one saved order.
 *
 * - reorderMenuItems: Move Up and Move Down, plus Move to Top and Move to Bottom when asked. An item that cannot act at
 *   the row's position is left out, and so is the whole section while a search or filter hides rows.
 * - announceReorder: the new position in a polite live region. Keyboard and drag paths call it too.
 *
 * The adopter keeps its own data change and save path in `move`; this module only builds the items, announces and
 * returns focus.
 */

import { t } from '../i18n.js';
import { getTopmostDialog } from './overlay-host.js';

const REGION_CLASS = 'sb-reorder-status';

/**
 * Returns the shared live region of the topmost modal dialog, or of <body> when none is open. A modal dialog makes
 * everything outside it inert, and assistive technology skips announcements from inert content.
 * @returns {HTMLElement}
 */
function sharedRegion() {
    const host = getTopmostDialog() ?? document.body;
    let region = [...host.children].find(child => child.classList.contains(REGION_CLASS));
    if (!region) {
        region = document.createElement('div');
        region.className = `${REGION_CLASS} sr-only`;
        region.setAttribute('role', 'status');
        region.setAttribute('aria-live', 'polite');
        region.setAttribute('aria-atomic', 'true');
        host.append(region);
    }
    return region;
}

/**
 * Announces where a row now sits.
 * @param {object} options
 * @param {string} options.name Row name.
 * @param {number} options.position One-based position after the move.
 * @param {number} options.count Rows in the list.
 * @param {Element|null} [options.region] A live region the list already owns; the shared one is used otherwise.
 * @returns {void}
 */
export function announceReorder({ name, position, count, region = null }) {
    (region ?? sharedRegion()).textContent = t`Moved ${name} to position ${position} of ${count}`;
}

/**
 * @typedef {object} ReorderMenuOptions
 * @property {number} index Zero-based position of the row in the whole list, as saved.
 * @property {number} count Rows in the whole list.
 * @property {boolean} [filtered] True while a search, filter or non-manual sort hides or reorders rows.
 * @property {boolean} [extremes] Also offer Move to Top and Move to Bottom.
 * @property {string} name Row name, for the announcement.
 * @property {(to: number) => unknown} move The adopter's own change and save; `to` is the new zero-based position.
 *   Returning `false`, or a promise of `false`, says the move did not happen: nothing is announced.
 * @property {() => Element|null} [focus] Returns the control to focus inside the moved row once the list has rendered.
 * @property {Element|null} [region] A live region the list already owns.
 * @property {(error: unknown) => void} [onError] Receives an error that `move` throws or rejects with; without it the
 *   error propagates.
 */

/**
 * Builds the items of the move section, in the shape `openActionMenu` takes. Add the result to a section, or give it a
 * section of its own; an empty result adds nothing to a menu. Each item carries `data-sb-reorder` (`top`, `up`, `down`
 * or `bottom`), which tests and tools read.
 * @param {ReorderMenuOptions} options
 * @returns {import('../sillybunny-action-menu.js').ActionMenuItem[]}
 */
export function reorderMenuItems({ index, count, filtered = false, extremes = false, name, move, focus = null, region = null, onError = null }) {
    if (filtered || !Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count || count < 2) return [];

    const settle = (to, result) => {
        if (result === false) return false;
        announceReorder({ name, position: to + 1, count, region });
        const target = focus?.();
        if (target?.isConnected && document.activeElement !== target) target.focus({ preventScroll: true });
        return true;
    };
    const fail = error => {
        if (!onError) throw error;
        onError(error);
        return false;
    };
    // A synchronous move settles synchronously, so a caller that reads the order right after the click sees it.
    const perform = to => {
        let result;
        try {
            result = move(to);
        } catch (error) {
            return fail(error);
        }
        return typeof result?.then === 'function' ? result.then(value => settle(to, value), fail) : settle(to, result);
    };
    const item = (kind, label, glyph, to) => ({ label, icon: `fa-solid fa-${glyph}`, data: { sbReorder: kind }, onSelect: () => perform(to) });

    const items = [];
    if (extremes && index > 0) items.push(item('top', t`Move to Top`, 'angles-up', 0));
    if (index > 0) items.push(item('up', t`Move Up`, 'arrow-up', index - 1));
    if (index < count - 1) items.push(item('down', t`Move Down`, 'arrow-down', index + 1));
    if (extremes && index < count - 1) items.push(item('bottom', t`Move to Bottom`, 'angles-down', count - 1));
    return items;
}
