export const COPY_PLACEHOLDER = 'TODO(copy)';

/**
 * Fills an element with the copy placeholder and tags it, so every missing text can be found by its slot.
 * @param {HTMLElement} element
 * @param {string} slot Names the text that belongs here, for example `GS-INTRO`.
 * @returns {HTMLElement}
 */
export function markCopyPlaceholder(element, slot) {
    element.textContent = COPY_PLACEHOLDER;
    element.dataset.sbCopyPlaceholder = 'true';
    element.dataset.sbCopySlot = slot;
    return element;
}

/**
 * Marks the subtitle of a row made by `createRow` as a copy placeholder.
 * @param {{ row: HTMLElement }} rowController
 * @param {string} slot
 */
export function markRowSubtitle(rowController, slot) {
    const subtitle = rowController.row.querySelector('.ds-row-subtitle');
    if (!(subtitle instanceof HTMLElement)) {
        throw new Error(`The row for slot ${slot} has no subtitle to mark.`);
    }
    markCopyPlaceholder(subtitle, slot);
}
