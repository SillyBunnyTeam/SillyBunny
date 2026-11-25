/**
 * The event stream of the mode on this page (`reply-events.js`): the data module, the finalizer, the send queue and the
 * notices. The stream is one connection per visible page for every conversation of the user.
 */

import { getActiveGenerationIds, onActiveGenerationsChange, pageId } from '../resumable-generation.js';
import { queueForcedConversationReply } from './attachments.js';
import { SAFE_TOAST_OPTIONS } from './constants.js';
import { conversationData } from './conversation-data-browser.js';
import { getCharacterForAvatar } from './media.js';
import { acknowledgeGenerations, finalizePendingReplies, wasReplyLanded } from './reply-finalizer-browser.js';
import { createReplyEvents } from './reply-events.js';
import { hasAnyConversationModeUsage } from './settings-store.js';

/**
 * Queues the forced reply that a lost reply is asked for again with.
 * @param {{ conversationId: string, chatId: string }} address
 * @param {{ remaining: string[], started: number }|null} round For a group, the lost member and the members that were to follow it.
 */
export function regenerateLostReply(address, round) {
    const view = conversationData.get(address.conversationId);
    if (!view) {
        return;
    }
    const anchor = view.characters.find(avatar => getCharacterForAvatar(avatar)) ?? view.characters[0] ?? '';
    queueForcedConversationReply(anchor, { chatId: address.chatId, groupId: view.kind === 'group' ? view.id : '', personaId: view.personaId, round });
}

/**
 * @param {{ item: Record<string, any>, regenerate: (() => void)|null }} notice
 */
export function showLostReplyNotice({ regenerate }) {
    const content = document.createElement('div');
    const text = document.createElement('div');
    // TODO(copy): the body of this notice is a placeholder.
    text.textContent = 'TODO(copy)';
    text.dataset.sbCopyPlaceholder = 'true';
    content.append(text);
    /** @type {any} */
    let toast = null;
    if (regenerate) {
        const link = document.createElement('a');
        link.setAttribute('href', 'javascript:void(0)');
        link.textContent = 'Regenerate';
        link.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            if (toast) {
                globalThis.toastr.clear(toast);
            }
            regenerate();
        });
        content.append(link);
    }
    toast = globalThis.toastr?.warning?.(content, 'Reply lost', { escapeHtml: false, timeOut: 0, extendedTimeOut: 0, closeButton: true, tapToDismiss: !regenerate });
}

export function showFailedReplyNotice() {
    // TODO(copy): the body of this alert is a placeholder.
    globalThis.toastr?.error?.('TODO(copy)', 'Reply failed', { ...SAFE_TOAST_OPTIONS });
}

const events = createReplyEvents({
    data: conversationData,
    pageId,
    getActiveGenerationIds,
    isVisible: () => document.visibilityState !== 'hidden',
    hasUsage: hasAnyConversationModeUsage,
    page: {
        async reloadChat(address) {
            await conversationData.reloadChat(address);
            await finalizePendingReplies(address);
        },
        wasLanded: wasReplyLanded,
        acknowledge: acknowledgeGenerations,
        showLost: showLostReplyNotice,
        showFailed: showFailedReplyNotice,
        regenerate: regenerateLostReply,
    },
});

let installed = false;

/** Follows the replies of the conversations over the event stream, for as long as the page is visible or reads a reply. Runs once. */
export function installReplyEvents() {
    if (installed) {
        return;
    }
    installed = true;
    document.addEventListener('visibilitychange', events.sync);
    onActiveGenerationsChange(events.sync);
    conversationData.subscribe((event) => {
        if (event.type === 'list' || event.type === 'status') {
            events.sync();
        }
    });
    events.sync();
}
