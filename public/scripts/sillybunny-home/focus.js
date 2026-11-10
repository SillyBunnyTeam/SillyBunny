import { findRecentChatRow, readRecentChatIdentity } from './recent-chat.js';

const ROW_CONTROLS = Object.freeze({
    open: '.recentChatOpen',
    pin: '.pinChat',
    'chat-menu': '.chatMenu',
});
const SHOWN_ROW_SELECTOR = '.recentChat:not(.hidden):not(.recentChatFiltered)';
const MAIN_MENU_SELECTOR = '.sbHomeMenuButton';
const KEYED_SELECTOR = '[data-sb-home-key]';
const CONNECT_SELECTOR = '.sbHomeCardConnect';
// The Connect a Model button is not counted: it is hidden while the app is online, so counting it would move every later position.
const KEYED_CONTROLS_SELECTOR = `button:not(${CONNECT_SELECTOR}), a[href]`;

/**
 * Where focus was in a Home panel that is about to be replaced.
 * `section` is a control of a tile or an assistant card, found again by the element's `data-sb-home-key`.
 * `main-menu` stands for any other control that is not part of a Recent Chats row.
 * @typedef {object} HomeFocusTarget
 * @property {'open'|'pin'|'chat-menu'|'section'|'main-menu'} control
 * @property {import('./recent-chat.js').RecentChatIdentity|null} identity
 * @property {number} index Position among the shown rows, or -1 outside a row.
 * @property {{ key: string, part: 'self'|'connect'|number }} [section] Set for `section`. `part` is `self` when the keyed element itself holds focus, `connect` for the Connect a Model button, or the position of the control among its other controls.
 */

function getShownRows(panel) {
    return /** @type {HTMLElement[]} */ (Array.from(panel.querySelectorAll(SHOWN_ROW_SELECTOR)));
}

/**
 * @param {HTMLElement|null} panel The Home panel that is about to be replaced.
 * @param {Element|null} [active] The control that holds focus, or has just been activated.
 * @returns {HomeFocusTarget|null} Null when `active` is not inside the panel.
 */
export function captureHomeFocus(panel, active = document.activeElement) {
    if (!panel || !(active instanceof HTMLElement) || !panel.contains(active)) {
        return null;
    }

    const row = active.closest('.recentChat');
    const control = row && Object.keys(ROW_CONTROLS).find(name => active.matches(ROW_CONTROLS[name]));
    if (!row || !control) {
        return captureSectionControl(active) ?? { control: 'main-menu', identity: null, index: -1 };
    }

    return {
        control: /** @type {HomeFocusTarget['control']} */ (control),
        identity: readRecentChatIdentity(row),
        index: getShownRows(panel).indexOf(/** @type {HTMLElement} */ (row)),
    };
}

function captureSectionControl(active) {
    const keyed = active.closest(KEYED_SELECTOR);
    const key = keyed instanceof HTMLElement ? keyed.dataset.sbHomeKey : undefined;
    if (!(keyed instanceof HTMLElement) || !key) {
        return null;
    }
    const position = active.matches(CONNECT_SELECTOR) ? 'connect' : Array.from(keyed.querySelectorAll(KEYED_CONTROLS_SELECTOR)).indexOf(active);
    const part = active === keyed ? 'self' : position;
    return part === -1 ? null : { control: 'section', identity: null, index: -1, section: { key, part } };
}

/** The control to focus, then the first control of the card, for when the first one is gone or hidden. */
function findSectionControls(panel, { key, part }) {
    const keyed = Array.from(panel.querySelectorAll(KEYED_SELECTOR))
        .find(candidate => candidate instanceof HTMLElement && candidate.dataset.sbHomeKey === key);
    if (part === 'self') {
        return [keyed];
    }
    const controls = keyed?.querySelectorAll(KEYED_CONTROLS_SELECTOR);
    if (part === 'connect') {
        return [keyed?.querySelector(CONNECT_SELECTOR), controls?.[0]];
    }
    // A card can come back with fewer controls, such as the third assistant card after Remove Assistant.
    return [controls?.[part] ?? controls?.[0]];
}

function focusFirstTaking(candidates) {
    for (const candidate of candidates) {
        candidate?.focus({ preventScroll: true });
        if (candidate && document.activeElement === candidate) {
            return candidate;
        }
    }
    return null;
}

/**
 * Focuses the same control in the same row of the new panel. When the row is gone, focus goes to the
 * open control of the row that took its position, and last to the main menu button. A card control that is gone
 * falls back to the first control of the card, and a tile or card that is gone, for example the Getting Started tile
 * after it was hidden, falls back to the main menu button.
 * @param {HTMLElement} panel The Home panel that replaced the old one.
 * @param {HomeFocusTarget|null} target
 * @returns {HTMLElement|null} The control that took focus.
 */
export function restoreHomeFocus(panel, target) {
    if (!target) {
        return null;
    }

    const menuButton = panel.querySelector(MAIN_MENU_SELECTOR);
    if (target.control === 'section' && target.section) {
        return focusFirstTaking([...findSectionControls(panel, target.section), menuButton]);
    }
    if (target.control === 'main-menu' || !target.identity) {
        return focusFirstTaking([menuButton]);
    }

    const row = findRecentChatRow(panel, target.identity);
    const shownRows = getShownRows(panel);
    const successor = shownRows[Math.min(Math.max(target.index, 0), shownRows.length - 1)];
    return focusFirstTaking([
        row?.querySelector(ROW_CONTROLS[target.control]),
        successor?.querySelector(ROW_CONTROLS.open),
        menuButton,
    ]);
}
