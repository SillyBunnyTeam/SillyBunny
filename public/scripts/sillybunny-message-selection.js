/*
 * Roleplay's "Delete messages": the selection mode of the conversation timeline on the chat's message rows.
 * public/script.js calls openMessageSelection() from openMessageDelete(), which Options > Delete messages and /del reach.
 */

import { chat, deleteMessage, saveChatConditional, showSwipeButtons } from '../script.js';
import { loadStylesheetAsync } from './dynamic-styles.js';
import { createMessageSelection } from './sillybunny-editor/message-selection.js';

const EDITOR_SHELL_STYLESHEET = { href: 'css/sillybunny-editor-shell.css?v=20261125a', id: 'deferred-editor-shell-css' };
const HEADER_HOST_ID = 'sb_message_selection_header';
const MESSAGE_ROW = '#chat > .mes[mesid]';

let controller = null;
let deleteToolCalls = true;
let onModeEnd = () => {};

/** A tool call is its own message in the chat; it belongs to the assistant message that follows it. */
function isToolCallMessage(message) {
    return Boolean(message?.is_system) && Array.isArray(message.extra?.tool_invocations);
}

function isAssistantMessage(message) {
    return Boolean(message) && !message.is_user && !message.is_system;
}

/** The index of the message that a row is selected and deleted with: its assistant message when it is a tool call of one. */
function getOwnerIndex(index) {
    if (!deleteToolCalls || !isToolCallMessage(chat[index])) {
        return index;
    }
    let cursor = index;
    while (isToolCallMessage(chat[cursor]) && cursor < chat.length - 1) {
        cursor++;
    }
    return isAssistantMessage(chat[cursor]) ? cursor : index;
}

function getRowKey(row) {
    const index = Number(row.getAttribute('mesid'));
    return Number.isInteger(index) ? String(getOwnerIndex(index)) : null;
}

/** Every chat index that the keys stand for, highest first, so that deleting one never moves the next. */
function getMessageIndexes(keys) {
    const indexes = new Set();
    for (const key of keys) {
        const owner = Number(key);
        indexes.add(owner);
        if (deleteToolCalls && isAssistantMessage(chat[owner])) {
            for (let cursor = owner - 1; cursor >= 0 && isToolCallMessage(chat[cursor]); cursor--) {
                indexes.add(cursor);
            }
        }
    }
    return [...indexes].sort((left, right) => right - left);
}

function getRowLabel(row) {
    const name = row.getAttribute('ch_name') ?? '';
    const text = row.querySelector('.mes_text')?.textContent?.trim().slice(0, 40) ?? '';
    return [name, text].filter(Boolean).join(': ');
}

/**
 * Deletes one message at a time through deleteMessage(), as /cut does: each renumbers the rows, sends MESSAGE_DELETED
 * and keeps the item lists of the prompts in step. One save follows, with the user's own shrink allowed.
 */
async function deleteSelected(keys) {
    for (const index of getMessageIndexes(keys)) {
        await deleteMessage(index, undefined, false, false);
    }
    await saveChatConditional({ allowShrink: true });
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

    const headerHost = document.getElementById(HEADER_HOST_ID) ?? Object.assign(document.createElement('div'), { id: HEADER_HOST_ID });
    list.before(headerHost);

    const selection = createMessageSelection({
        root: sheld,
        list,
        rowSelector: MESSAGE_ROW,
        getKey: getRowKey,
        rowLabel: getRowLabel,
        countMessages: keys => getMessageIndexes(keys).length,
        header: headerHost,
        actionBar,
        // The entry is Options > Delete messages; a long press or a right-click on a message keeps its meaning outside the mode.
        longPressEnters: false,
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
 * @param {() => void} [options.onExit] Runs when the mode ends, however it ends.
 */
export async function openMessageSelection({ deleteToolCalls: withToolCalls = true, onExit = () => {} } = {}) {
    // The check, the header and the action bar live in a deferred sheet that the chat has not needed until now.
    await loadStylesheetAsync(EDITOR_SHELL_STYLESHEET.href, { id: EDITOR_SHELL_STYLESHEET.id }).catch(() => {});
    const selection = ensureController();
    if (!selection) {
        onExit();
        return;
    }
    deleteToolCalls = withToolCalls;
    onModeEnd = onExit;
    selection.enter();
}

export function isMessageSelectionActive() {
    return controller?.selection.isActive === true;
}

export function cancelMessageSelection() {
    controller?.selection.exit();
}
