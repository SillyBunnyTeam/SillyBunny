import { eventSource, event_types } from './events.js';
import { HOME_STATE_CHANGED_EVENT, isHomeActive } from './sillybunny-home-state.js';
import { accountStorage } from './util/AccountStorage.js';

export const CHAT_MODE_CHANGED_EVENT = 'sb:chat-mode-changed';

const STORAGE_KEY = 'WelcomePage_LastMode';
const CONVERSATION_STATE_EVENT = 'sb:conversation-workspace-state-changed';

/** @typedef {'roleplay' | 'conversation'} ChatMode */

/**
 * Holds a mode recorded before the account storage has loaded, because loading merges the saved
 * settings over anything written earlier. Cleared once the storage is settled.
 * @type {ChatMode | null}
 */
let recordedMode = null;
let storageSettled = false;
let conversationOpen = false;
let bound = false;

/**
 * @param {unknown} value
 * @returns {ChatMode}
 */
function parseChatMode(value) {
    return value === 'conversation' ? 'conversation' : 'roleplay';
}

function announceChatMode() {
    document.dispatchEvent(new CustomEvent(CHAT_MODE_CHANGED_EVENT, { detail: { mode: getLastChatMode() } }));
}

/**
 * The mode that chats open in: the last one the user was in.
 * @returns {ChatMode}
 */
export function getLastChatMode() {
    return parseChatMode(recordedMode ?? accountStorage.getItem(STORAGE_KEY));
}

/**
 * Stores the mode the user is now in and announces `sb:chat-mode-changed` when it differs from the
 * mode read before.
 * @param {ChatMode} mode
 */
export function recordChatMode(mode) {
    if (mode !== 'roleplay' && mode !== 'conversation') {
        throw new TypeError(`Unknown chat mode: ${String(mode)}`);
    }

    const previousMode = getLastChatMode();
    recordedMode = storageSettled ? null : mode;
    accountStorage.setItem(STORAGE_KEY, mode);

    if (previousMode !== mode) {
        announceChatMode();
    }
}

function handleConversationWorkspaceState(event) {
    conversationOpen = event.detail?.open === true;
    if (conversationOpen) {
        recordChatMode('conversation');
    }
}

function handleHomeStateChanged(event) {
    if (event.detail?.active !== false) {
        return;
    }

    // Home turns off and on again within one task while the welcome panel re-renders, so the
    // leave is judged after that task.
    setTimeout(() => {
        if (!isHomeActive() && !conversationOpen) {
            recordChatMode('roleplay');
        }
    }, 0);
}

function handleChatChanged(chatId) {
    if (chatId && !conversationOpen) {
        recordChatMode('roleplay');
    }
}

function settleStorage() {
    if (recordedMode) {
        accountStorage.setItem(STORAGE_KEY, recordedMode);
    }
    recordedMode = null;
    storageSettled = true;
}

function handleSettingsLoaded() {
    settleStorage();
    announceChatMode();
}

// Covers a module that starts after the settings loaded: `APP_READY` replays to late listeners.
function handleAppReady() {
    if (!storageSettled) {
        handleSettingsLoaded();
    }
}

/**
 * Starts recording the mode from app activity. Calling it again does nothing.
 * - The Conversation workspace opens: Conversation.
 * - Home turns off while the workspace is closed, or a chat opens while it is closed: Roleplay.
 */
export function initChatModeMemory() {
    if (bound) {
        return;
    }

    bound = true;
    window.addEventListener(CONVERSATION_STATE_EVENT, handleConversationWorkspaceState);
    document.addEventListener(HOME_STATE_CHANGED_EVENT, handleHomeStateChanged);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on(event_types.SETTINGS_LOADED, handleSettingsLoaded);
    eventSource.on(event_types.APP_READY, handleAppReady);
}
