import { createMessageSelection } from '../sillybunny-editor/message-selection.js';
import { CHROME_IDS } from './constants.js';
import { conversationState } from './state.js';
import { deleteConversationMessages } from './timeline-render.js';

const MESSAGE_ROW = '.sb-conversation-message[data-message-id]';
const HEADER_HOST_ID = 'sb_conversation_selection_header';
const ACTION_BAR_ID = 'sb_conversation_selection_actions';

let controller = null;
let startedOnKey = '';

function ensureHost(id, create) {
    let node = document.getElementById(id);
    if (!(node instanceof HTMLElement)) {
        node = create();
        node.id = id;
    }
    return node;
}

function getRowLabel(row) {
    const name = row.querySelector('.sb-conversation-message-name')?.textContent?.trim() || '';
    const text = row.querySelector('.sb-conversation-message-text')?.textContent?.trim().slice(0, 40) ?? '';
    return [name, text].filter(Boolean).join(': ');
}

function ensureController() {
    if (controller?.isAttached()) {
        return controller.selection;
    }
    // The chrome was built again, so the old mode is bound to rows that are gone.
    controller?.selection.destroy();
    controller = null;
    const sheld = document.getElementById('sheld');
    const timeline = document.getElementById(CHROME_IDS.timeline);
    const stage = document.getElementById(CHROME_IDS.stage);
    const header = document.getElementById(CHROME_IDS.header);
    if (!(sheld && timeline && stage && header)) {
        return null;
    }

    const headerHost = ensureHost(HEADER_HOST_ID, () => {
        const host = document.createElement('div');
        header.after(host);
        return host;
    });
    const actionBar = ensureHost(ACTION_BAR_ID, () => {
        const bar = document.createElement('div');
        stage.append(bar);
        return bar;
    });

    const selection = createMessageSelection({
        root: sheld,
        list: timeline,
        rowSelector: MESSAGE_ROW,
        getKey: row => row.dataset.messageId ?? null,
        rowLabel: getRowLabel,
        header: headerHost,
        actionBar,
        onEnter: () => {
            startedOnKey = conversationState.lastRenderedConversationKey;
        },
        isStale: () => conversationState.lastRenderedConversationKey !== startedOnKey,
        onDelete: keys => {
            deleteConversationMessages(keys);
        },
    });
    controller = { selection, isAttached: () => timeline.isConnected && headerHost.isConnected && actionBar.isConnected };
    return selection;
}

/**
 * Starts selection mode on the open conversation.
 * @param {string|null} [messageId] The message that is selected at the start.
 * @param {HTMLElement|null} [trigger] Where focus goes back to when the mode ends.
 */
export function enterConversationSelection(messageId = null, trigger = null) {
    ensureController()?.enter(messageId, trigger);
}

export function isConversationSelectionActive() {
    return controller?.selection.isActive === true;
}

export function exitConversationSelection() {
    controller?.selection.exit();
}
