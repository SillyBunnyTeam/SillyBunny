import { playMessageSound } from '../power-user.js';
import { CHROME_IDS, CONVERSATION_UNREAD_CHANGED_EVENT, CONVERSATION_UNREAD_DATASET, SAFE_TOAST_OPTIONS } from './constants.js';
import {
    clearLegacyConversationUnreadStorage,
    getCharacterForAvatar,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationRecord,
    getConversationKey,
    getCurrentCharAvatar,
    shouldSurfaceConversationNotification,
} from './context.js';
import { conversationData } from './conversation-data-browser.js';
import { selectConversation } from './lazy-parts.js';
import { stripPreviewText } from './preview-utils.js';
import { getSettings } from './settings-store.js';
import { conversationState } from './state.js';

/** The messages after the read marker that the user has not seen, in one chat or in the whole conversation. */
export function getUnreadCount(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const view = getConversationRecord(avatar, { groupId, personaId });
    if (!view) {
        return 0;
    }
    return chatId ? view.chats.find(chat => chat.id === chatId)?.unread ?? 0 : view.unread ?? 0;
}

/**
 * Sets the read marker of a chat, or of every chat of the conversation, to its last message. A chat that is not loaded
 * is loaded first, because its last message is not in the list.
 * @returns {Promise<void>}
 */
export async function markConversationRead(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const view = getConversationRecord(avatar, { groupId, personaId });
    if (!view) {
        return;
    }
    const chats = chatId ? view.chats.filter(chat => chat.id === chatId) : view.chats;
    await Promise.all(chats.filter(chat => chat.unread > 0).map(chat => conversationData.markRead({ conversationId: view.id, chatId: chat.id })));
}

export function clearUnreadCount(avatar, options = {}) {
    return markConversationRead(avatar, options);
}

/** A conversation counts toward the badges when its character is in the library (a group: when one of its members is). */
function isUnreadConversationCountable(view) {
    return view.characters.some(avatar => getCharacterForAvatar(avatar));
}

/**
 * Marks every conversation of the current persona as read.
 * @returns {Promise<{ changed: boolean, cleared: number, removedLegacy: number }>} `cleared` is the number of messages that were unread.
 */
export async function clearAllConversationUnreadCounts() {
    const personaId = getConversationPersonaId();
    const views = conversationData.list({ personaId }).filter(view => view.unread > 0 && isUnreadConversationCountable(view));
    const cleared = views.reduce((sum, view) => sum + view.unread, 0);
    await Promise.all(views.map(view => Promise.all(view.chats.filter(chat => chat.unread > 0).map(chat => conversationData.markRead({ conversationId: view.id, chatId: chat.id })))));
    const removedLegacy = clearLegacyConversationUnreadStorage();
    const changed = cleared > 0 || removedLegacy > 0;
    if (changed) {
        updateConversationNotificationIndicators();
    }

    return { changed, cleared, removedLegacy };
}

export function getTotalUnreadCount() {
    return conversationData.totalUnread(getConversationPersonaId(), isUnreadConversationCountable);
}

export function getBadgeLabel(count) {
    return count > 99 ? '99+' : String(count || '');
}

export function getDocumentTitleBase() {
    const currentTitle = String(document.title || '').replace(/^\(\d+\+?\)\s+/, '').trim();
    if (!conversationState.originalDocumentTitle || /^\(\d+\+?\)\s+/.test(conversationState.originalDocumentTitle)) {
        conversationState.originalDocumentTitle = currentTitle || 'SillyBunny';
    }
    return conversationState.originalDocumentTitle;
}

// The badge canvas is 32 px, so it starts from the 32 px logo and draws it 1:1, with no scaling.
const BADGE_FAVICON_SELECTOR = 'link[rel~="icon"][sizes="32x32"]';

export function getFaviconLink() {
    let link = document.querySelector(BADGE_FAVICON_SELECTOR) ?? document.querySelector('link[rel~="icon"]');
    if (!(link instanceof HTMLLinkElement)) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }

    if (!conversationState.originalFaviconHref && link.href) {
        conversationState.originalFaviconHref = link.href;
    }
    return link;
}

export function updateConversationTitleBadge(totalUnread = getTotalUnreadCount()) {
    const baseTitle = getDocumentTitleBase();
    document.title = totalUnread > 0 ? `(${getBadgeLabel(totalUnread)}) ${baseTitle}` : baseTitle;
}

export function updateConversationFaviconBadge(totalUnread = getTotalUnreadCount()) {
    const link = getFaviconLink();
    const sourceHref = conversationState.originalFaviconHref || link.href;
    if (!sourceHref) {
        return;
    }

    const token = ++conversationState.faviconUpdateToken;
    if (totalUnread <= 0) {
        link.href = sourceHref;
        return;
    }

    const image = new Image();
    image.onload = () => {
        if (token !== conversationState.faviconUpdateToken) {
            return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }

        // The 32 px logo is drawn by hand, so a smoothed copy would blur its pixels.
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image, 0, 0, 32, 32);
        ctx.fillStyle = '#fb7185';
        ctx.beginPath();
        ctx.arc(23, 9, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1b1f26';
        ctx.font = '700 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(totalUnread > 9 ? '9+' : String(totalUnread), 23, 9);
        try {
            link.href = canvas.toDataURL('image/png');
        } catch (error) {
            console.warn('Conversation Mode: favicon badge failed', error);
        }
    };
    image.onerror = () => {
        if (token === conversationState.faviconUpdateToken) {
            link.href = sourceHref;
        }
    };
    image.src = sourceHref;
}

export function updateListToggleBadge(totalUnread = getTotalUnreadCount()) {
    const badge = document.querySelector(`#${CHROME_IDS.listToggle} .sb-conversation-list-toggle-badge`);
    if (!(badge instanceof HTMLElement)) {
        return;
    }

    badge.textContent = getBadgeLabel(totalUnread);
    badge.hidden = totalUnread <= 0;
}

/**
 * The unread badge of the control for the chat mode: the count and its accessible name, or null when none shows. A user in
 * Conversation Mode does not need it, because the list there holds the counts.
 * @param {number} totalUnread
 * @param {boolean} workspaceOpen
 * @returns {{ text: string, name: string }|null}
 */
export function describeModeToggleUnread(totalUnread, workspaceOpen) {
    if (workspaceOpen || !(totalUnread > 0)) {
        return null;
    }

    const text = getBadgeLabel(totalUnread);
    return { text, name: `${text} Unread` };
}

/** Publishes the badge of `describeModeToggleUnread()` for the top bar, and sends the event when it changes. */
export function updateModeToggleUnread(totalUnread = getTotalUnreadCount()) {
    const badge = describeModeToggleUnread(totalUnread, Boolean(conversationState.conversationWorkspaceOpen));
    const text = badge?.text ?? '';
    const name = badge?.name ?? '';
    const { dataset } = document.documentElement;
    if ((dataset[CONVERSATION_UNREAD_DATASET.text] ?? '') === text && (dataset[CONVERSATION_UNREAD_DATASET.name] ?? '') === name) {
        return;
    }

    if (badge) {
        dataset[CONVERSATION_UNREAD_DATASET.text] = text;
        dataset[CONVERSATION_UNREAD_DATASET.name] = name;
    } else {
        delete dataset[CONVERSATION_UNREAD_DATASET.text];
        delete dataset[CONVERSATION_UNREAD_DATASET.name];
    }
    window.dispatchEvent(new CustomEvent(CONVERSATION_UNREAD_CHANGED_EVENT, { detail: { text, name } }));
}

export function updateConversationNotificationIndicators() {
    const totalUnread = getTotalUnreadCount();
    updateListToggleBadge(totalUnread);
    updateConversationTitleBadge(totalUnread);
    updateConversationFaviconBadge(totalUnread);
    updateModeToggleUnread(totalUnread);
}

export function getActiveConversationKey() {
    if (!conversationState.conversationWorkspaceOpen) {
        return '';
    }

    return getConversationKey(getCurrentCharAvatar(), conversationState.conversationSelectedGroupId || '');
}

export function isConversationActive(avatar, groupId = getConversationGroupIdForAvatar(avatar), { chatId = '', personaId = getConversationPersonaId() } = {}) {
    const currentPersonaId = getConversationPersonaId();
    const conversationRecord = getConversationRecord(avatar, { groupId, personaId });
    return Boolean(
        conversationState.conversationWorkspaceOpen
        && avatar
        && personaId === currentPersonaId
        && getConversationKey(avatar, groupId || '', { personaId }) === getActiveConversationKey()
        && (!chatId || chatId === conversationRecord?.activeChatId),
    );
}

export async function openConversationFromNotification(avatar, { chatId = '', groupId = null, personaId = getConversationPersonaId() } = {}) {
    return selectConversation(avatar, { chatId, groupId, personaId, showToast: false });
}

export function showConversationToast(avatar, message, { chatId = '', groupId = null, personaId = getConversationPersonaId() } = {}) {
    const toastr = globalThis.toastr;
    if (!toastr?.info) {
        return;
    }

    const character = getCharacterForAvatar(avatar);
    const title = `New message from ${message.name || character?.name || 'Character'}`;
    const preview = stripPreviewText(message.mes) || 'New Conversation message';
    toastr.info(preview, title, {
        ...SAFE_TOAST_OPTIONS,
        timeOut: 6000,
        onclick: () => void openConversationFromNotification(avatar, { chatId, groupId, personaId }),
    });
}

export function notifyNewConversationMessage(avatar, message, shouldNotify, { chatId = '', groupId = null, personaId = getConversationPersonaId() } = {}) {
    updateConversationNotificationIndicators();
    if (!shouldNotify || !message || message.role === 'user' || message.role === 'system') {
        return;
    }

    const settings = getSettings(avatar, { groupId, personaId });
    if (!shouldSurfaceConversationNotification(settings)) {
        return;
    }

    try {
        playMessageSound({ force: true });
    } catch (error) {
        console.warn('Conversation Mode: notification sound failed', error);
    }

    showConversationToast(avatar, message, { chatId, groupId, personaId });
}
