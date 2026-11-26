/**
 * What the timeline draws for a pin: the Pinned mark under a bubble, and the line between the messages that says a message
 * was pinned. Both are drawn from the message, so nothing here writes to a chat. The page that holds the timeline imports
 * this file for the pieces and `pin-model.js` decides where the lines fall.
 */

export const PIN_EVENT_ACTIONS = Object.freeze({
    show: 'show-pinned-message',
    openPinned: 'open-pinned-messages',
});

const EVENT_CLASS = 'sb-conversation-event';
const MESSAGE_SELECTOR = '.sb-conversation-message[data-message-id]';

/**
 * A status chip (DESIGN.md Chips): the state in words. It sits under the bubble, outside the name row, so a message
 * whose header is hidden because it continues a group still shows it.
 */
export function createPinnedMark() {
    const mark = document.createElement('span');
    mark.className = 'sb-conversation-message-pinned';
    mark.textContent = 'Pinned';
    return mark;
}

function createEventButton(label, action, messageId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sb-conversation-event-action';
    button.dataset.sbConversationAction = action;
    button.dataset.messageId = messageId;
    button.textContent = label;
    return button;
}

/**
 * @param {{ messageId: string }} event An event of `getPinEvents()` in `pin-model.js`.
 */
export function createPinEventRow({ messageId }) {
    const row = document.createElement('div');
    row.className = EVENT_CLASS;
    row.dataset.sbConversationEvent = 'pin';
    row.dataset.messageId = messageId;

    const glyph = document.createElement('i');
    glyph.className = 'fa-solid fa-thumbtack';
    glyph.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'sb-conversation-event-text';
    text.append(glyph, 'You pinned a message.');

    row.append(
        text,
        createEventButton('Show Message', PIN_EVENT_ACTIONS.show, messageId),
        createEventButton('See All Pinned', PIN_EVENT_ACTIONS.openPinned, messageId),
    );
    return row;
}

/**
 * @typedef {object} DetachedPinEventRows
 * @property {Map<string, HTMLElement>} rows The lines that were drawn, by the message that each is about.
 * @property {HTMLElement|null} focused The element of a line that had the focus.
 */

/**
 * Takes the lines out of the timeline before its messages are put in order, which counts on the timeline having no
 * other child than a message or a day divider. The elements are kept, so that `placePinEventRows` can put the same ones
 * back.
 * @param {HTMLElement} timeline
 * @returns {DetachedPinEventRows}
 */
export function detachPinEventRows(timeline) {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && active.closest(`.${EVENT_CLASS}`) ? active : null;
    const rows = new Map();
    for (const row of timeline.querySelectorAll(`.${EVENT_CLASS}`)) {
        rows.set(row.dataset.messageId ?? '', row);
        row.remove();
    }
    return { rows, focused };
}

/**
 * Draws the lines after the messages that the events name. A line that was drawn for the same message is the element
 * that is put back, so a button that has the focus keeps it, and the window that a button opened can still return the focus
 * to it. A line whose message is not in the timeline is left out; a line whose event is gone stays out.
 * @param {HTMLElement} timeline
 * @param {{ messageId: string, afterMessageId: string }[]} events
 * @param {DetachedPinEventRows} detached
 */
export function placePinEventRows(timeline, events, { rows, focused }) {
    const messages = new Map();
    for (const node of timeline.querySelectorAll(MESSAGE_SELECTOR)) {
        messages.set(node.dataset.messageId, node);
    }

    const lastOfPlace = new Map();
    let refocus = null;
    for (const event of events) {
        const anchor = lastOfPlace.get(event.afterMessageId) ?? messages.get(event.afterMessageId);
        if (!anchor) {
            continue;
        }
        const row = rows.get(event.messageId) ?? createPinEventRow(event);
        anchor.after(row);
        lastOfPlace.set(event.afterMessageId, row);
        if (focused && row.contains(focused)) {
            refocus = focused;
        }
    }
    refocus?.focus({ preventScroll: true });
}

/** @returns {HTMLElement|null} The node of a message in the timeline. */
export function findMessageNode(timeline, messageId) {
    for (const node of timeline.querySelectorAll(MESSAGE_SELECTOR)) {
        if (node.dataset.messageId === messageId) {
            return node;
        }
    }
    return null;
}
