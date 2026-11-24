import { event_types, eventSource } from './events.js';
import { extension_settings } from './extensions.js';
import { CONVERSATION_STORE_KEY } from './sillybunny-conversation/constants.js';
import { conversationState } from './sillybunny-conversation/state.js';

const LEGACY_CONVERSATION_STORAGE_PREFIX = 'sb_conv_';

/** @type {Promise<typeof import('./sillybunny-conversation.js')> | null} */
let conversationModulePromise = null;

function threadHasStoredUsage(storeKey, threadStore) {
    if (!threadStore || typeof threadStore !== 'object') {
        return false;
    }

    if (threadStore.settings?.enabled === true || String(storeKey || '').includes('group:')) {
        return true;
    }

    const branches = threadStore.branches && typeof threadStore.branches === 'object'
        ? Object.values(threadStore.branches)
        : [];
    return branches.some(branch => (Array.isArray(branch?.messages) && branch.messages.length > 0) || Number(branch?.unread) > 0);
}

/**
 * Checks whether Conversation Mode has active UI state or persisted user data
 * without importing the 44-module Conversation runtime graph on cold boot.
 * @param {object} [options]
 * @param {object} [options.extensionSettings]
 * @param {Storage|null} [options.storage]
 * @param {Document|null} [options.documentRef]
 * @returns {boolean}
 */
export function hasStoredConversationBootUsage({
    extensionSettings = extension_settings,
    storage = globalThis.localStorage ?? null,
    documentRef = globalThis.document ?? null,
} = {}) {
    if (conversationState.conversationWorkspaceOpen) {
        return true;
    }

    if (documentRef?.getElementById?.('sheld')?.getAttribute?.('data-sb-conversation-mode') === 'on') {
        return true;
    }

    const store = extensionSettings?.[CONVERSATION_STORE_KEY];
    if (store && typeof store === 'object') {
        if ((Array.isArray(store.groups) && store.groups.length > 0)
            || (Array.isArray(store.reminders) && store.reminders.length > 0)) {
            return true;
        }

        const charactersStore = store.characters;
        if (charactersStore && typeof charactersStore === 'object') {
            for (const [storeKey, threadStore] of Object.entries(charactersStore)) {
                if (threadHasStoredUsage(storeKey, threadStore)) {
                    return true;
                }
            }
        }
    }

    if (!store || store.localStorageMigrated !== true) {
        try {
            const length = Number(storage?.length ?? 0);
            for (let index = 0; index < length; index++) {
                if (String(storage.key(index) || '').startsWith(LEGACY_CONVERSATION_STORAGE_PREFIX)) {
                    return true;
                }
            }
        } catch {
            // Ignore blocked storage access on restricted contexts.
        }
    }

    return false;
}

/**
 * Dynamically loads and initializes the Conversation Mode module graph once.
 * @returns {Promise<typeof import('./sillybunny-conversation.js')>}
 */
export function ensureConversationModuleLoaded() {
    conversationModulePromise ??= import('./sillybunny-conversation.js').then(async (mod) => {
        if (!conversationState.initialized) {
            const { init } = await import('./sillybunny-conversation/init.js');
            init();
        }
        return mod;
    });
    return conversationModulePromise;
}

function forwardLazyConversationWindowEvent(eventName, event) {
    if (conversationState.initialized) {
        return;
    }

    const detail = typeof CustomEvent === 'function' && event instanceof CustomEvent ? event.detail : event?.detail ?? null;
    void ensureConversationModuleLoaded().then(() => {
        window.dispatchEvent(new CustomEvent(eventName, { detail }));
    });
}

function checkConversationBootActivation() {
    if (!conversationState.initialized && hasStoredConversationBootUsage()) {
        void ensureConversationModuleLoaded();
    }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('sb:open-conversation-workspace', event => forwardLazyConversationWindowEvent('sb:open-conversation-workspace', event));
    window.addEventListener('sb:conversation-runtime-needed', event => forwardLazyConversationWindowEvent('sb:conversation-runtime-needed', event));
}

eventSource.on(event_types.APP_READY, checkConversationBootActivation);
eventSource.on(event_types.PERSONA_CHANGED, checkConversationBootActivation);
