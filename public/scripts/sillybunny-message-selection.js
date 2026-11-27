/* Roleplay's "Delete messages": the selection mode of the conversation timeline, on the chat's message rows. */

import { chat, chat_metadata, chatElement, deleteMessage, removeRenderedMessagesFrom, saveChatConditional, showSwipeButtons } from '../script.js';
import { loadStylesheetAsync } from './dynamic-styles.js';
import { eventSource, event_types } from './events.js';
import { deleteItemizedPromptForMessage } from './itemized-prompts.js';
import { createMessageSelection } from './sillybunny-editor/message-selection.js';
import { getMessageIndexes, getOwnerIndex, getTailStart } from './sillybunny-message-selection-utils.js';

const EDITOR_SHELL_STYLESHEET = { href: 'css/sillybunny-editor-shell.css?v=20261126b', id: 'deferred-editor-shell-css' };
const HEADER_HOST_ID = 'sb_message_selection_header';
const MESSAGE_ROW = '#chat > .mes[mesid]';

let controller = null;
let deleteToolCalls = true;
let onModeEnd = () => {};
let onSyncWindowControls = () => {};

function getRowKey(row) {
    const index = Number(row.getAttribute('mesid'));
    return Number.isInteger(index) ? String(getOwnerIndex(chat, index, deleteToolCalls)) : null;
}

function getRowLabel(row) {
    const name = row.getAttribute('ch_name') ?? '';
    const text = row.querySelector('.mes_text')?.textContent?.trim().slice(0, 40) ?? '';
    return [name, text].filter(Boolean).join(': ');
}

/**
 * Cuts the chat at a message, as the delete bar that this mode replaced did: the itemized prompts of the messages that go
 * are dropped, the rows go, the chat ends there, and the chat is saved before anything hears of it. The shrink is the
 * user's own, so the server's guard against an accidental empty save must let it through. The listeners of
 * MESSAGE_DELETED hear it once, with the length the chat has now.
 */
async function cutTail(start) {
    for (let index = chat.length - 1; index >= start; index--) {
        deleteItemizedPromptForMessage(index);
    }
    removeRenderedMessagesFrom(start);
    chat.length = start;
    chat_metadata.tainted = true;
    await saveChatConditional({ allowShrink: true });
    await onSyncWindowControls();
    chatElement.scrollTop(chatElement[0].scrollHeight);
    await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
    chatElement.find('.mes').removeClass('last_mes');
    chatElement.find('.mes').last().addClass('last_mes');
    showSwipeButtons();
}

/**
 * A run that ends at the last message is cut in one step. Anything else goes one message at a time through
 * deleteMessage(), because every message that stays behind the block has to move up: each call splices the chat array,
 * renumbers the rows (`mesid` and the shown number), moves the itemized prompts of the later messages down, and sends
 * MESSAGE_DELETED with the length that the chat has after it. One save follows.
 */
async function deleteSelected(keys) {
    const indexes = getMessageIndexes(chat, keys, deleteToolCalls);
    const tailStart = getTailStart(indexes, chat.length);
    if (tailStart >= 0) {
        await cutTail(tailStart);
        return;
    }
    for (const index of indexes) {
        await deleteMessage(index, undefined, false, false);
    }
    await saveChatConditional({ allowShrink: true });
    await onSyncWindowControls();
}

function ensureController() {
    const sheld = document.getElementById('sheld');
    const list = document.getElementById('chat');
    const formSheld = document.getElementById('form_sheld');
    const actionBar = document.getElementById('dialogue_del_mes');
    if (!(sheld && list && formSheld && actionBar)) {
        return null;
    }
    if (controller?.isAttached()) {
        return controller.selection;
    }
    controller?.selection.destroy();
    controller = null;

    const headerHost = document.getElementById(HEADER_HOST_ID) ?? Object.assign(document.createElement('div'), { id: HEADER_HOST_ID });
    list.before(headerHost);

    const selection = createMessageSelection({
        root: sheld,
        list,
        rowSelector: MESSAGE_ROW,
        getKey: getRowKey,
        rowLabel: getRowLabel,
        countMessages: keys => getMessageIndexes(chat, keys, deleteToolCalls).length,
        header: headerHost,
        actionBar,
        onEnter: () => {
            // The ids of the delete bar of the mode this one replaces, which other code and the surface audits address.
            const { cancelButton, selectionTitle } = selection.selection;
            if (cancelButton) cancelButton.id = 'dialogue_del_mes_cancel';
            if (selectionTitle) selectionTitle.id = 'dialogue_del_mes_count';
            const deleteButton = actionBar.querySelector('[data-action-id="delete"]');
            if (deleteButton) deleteButton.id = 'dialogue_del_mes_ok';
        },
        onDelete: deleteSelected,
        onExit: () => {
            showSwipeButtons();
            onModeEnd();
        },
    });
    controller = { selection, isAttached: () => list.isConnected && headerHost.isConnected && actionBar.isConnected };
    return selection;
}

/**
 * Starts the mode. The caller has already refused it while a reply is generating.
 * @param {object} [options]
 * @param {boolean} [options.deleteToolCalls=true] Whether a message is selected and deleted with its tool calls.
 * @param {() => boolean} [options.isStillWanted] Checked after async sheet load so a chat switch does not enter stale selection mode.
 * @param {() => void|Promise<void>} [options.syncWindowControls] Refreshes windowed chat history controls after messages are removed.
 * @param {() => void} [options.onExit] Runs when the mode ends, however it ends.
 */
export async function openMessageSelection({
    deleteToolCalls: withToolCalls = true,
    isStillWanted = () => true,
    syncWindowControls = () => {},
    onExit = () => {},
} = {}) {
    // The check, the header and the action bar live in a deferred sheet that the chat has not needed until now.
    await loadStylesheetAsync(EDITOR_SHELL_STYLESHEET.href, { id: EDITOR_SHELL_STYLESHEET.id }).catch(() => {});
    if (!isStillWanted()) {
        return;
    }
    const selection = ensureController();
    if (!selection) {
        onExit();
        return;
    }
    deleteToolCalls = withToolCalls;
    onModeEnd = onExit;
    onSyncWindowControls = syncWindowControls;
    selection.enter();
}

export function isMessageSelectionActive() {
    return controller?.selection.isActive === true;
}

export function cancelMessageSelection() {
    controller?.selection.exit();
}
