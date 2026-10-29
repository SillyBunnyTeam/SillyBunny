import { findRecentChatRow, readRecentChatIdentity } from './recent-chat.js';

const ROW_CONTROLS = Object.freeze({
    open: '.recentChatOpen',
    pin: '.pinChat',
    'chat-menu': '.chatMenu',
});
const SHOWN_ROW_SELECTOR = '.recentChat:not(.hidden):not(.recentChatFiltered)';
const MAIN_MENU_SELECTOR = '.sbHomeMenuButton';
const FIELD_SELECTOR = '[data-sb-editor-field]';
const FIELD_CONTROLS_SELECTOR = 'button, summary, a[href]';

/**
 * Where focus was in a Home panel that is about to be replaced.
 * `section` is a control of a section row, found again by the row's `data-sb-editor-field`.
 * `main-menu` stands for any other control that is not part of a Recent Chats row.
 * @typedef {object} HomeFocusTarget
 * @property {'open'|'pin'|'chat-menu'|'section'|'main-menu'} control
 * @property {import('./recent-chat.js').RecentChatIdentity|null} identity
 * @property {number} index Position among the shown rows, or -1 outside a row.
 * @property {{ field: string, part: 'self'|number }} [section] Set for `section`. `part` is `self` when the row itself holds focus, or the position of the control among the row's controls.
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
    const fieldElement = active.closest(FIELD_SELECTOR);
    const field = fieldElement instanceof HTMLElement ? fieldElement.dataset.sbEditorField : undefined;
    if (!(fieldElement instanceof HTMLElement) || !field) {
        return null;
    }
    const position = Array.from(fieldElement.querySelectorAll(FIELD_CONTROLS_SELECTOR)).indexOf(active);
    const part = active === fieldElement ? 'self' : position;
    return part === -1 ? null : { control: 'section', identity: null, index: -1, section: { field, part } };
}

function findSectionControl(panel, { field, part }) {
    const fieldElement = Array.from(panel.querySelectorAll(FIELD_SELECTOR))
        .find(candidate => candidate instanceof HTMLElement && candidate.dataset.sbEditorField === field);
    return part === 'self' ? fieldElement : fieldElement?.querySelectorAll(FIELD_CONTROLS_SELECTOR)[part];
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
 * open control of the row that took its position, and last to the main menu button. A section control
 * that is gone, for example inside a row that is collapsed again, falls back to the main menu button.
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
        return focusFirstTaking([findSectionControl(panel, target.section), menuButton]);
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
