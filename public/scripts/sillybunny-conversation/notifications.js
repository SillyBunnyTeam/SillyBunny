import { playMessageSound } from '../power-user.js';
import { selectConversation } from './chrome.js';
import { CHROME_IDS, SAFE_TOAST_OPTIONS } from './constants.js';
import {
    clearLegacyConversationUnreadStorage,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationRecord,
    getConversationKey,
    getCurrentCharAvatar,
    shouldSurfaceConversationNotification,
} from './context.js';
import { conversationData } from './conversation-data-browser.js';
import { getCharacterForAvatar } from './media.js';
import { getSettings } from './settings-store.js';
import { conversationState } from './state.js';
import { stripPreviewText } from './typing.js';

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

export function updateConversationTabBadge(totalUnread = getTotalUnreadCount()) {
    const modeButton = document.querySelector('#sb_character_mode_toggle [data-sb-character-mode="conversation"]');
    if (!(modeButton instanceof HTMLElement)) {
        return;
    }
    let badge = modeButton.querySelector('.sb-tab-notification-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'sb-tab-notification-badge';
        modeButton.appendChild(badge);
    }
    badge.textContent = getBadgeLabel(totalUnread);
    badge.style.display = totalUnread > 0 ? 'inline-flex' : 'none';
}

export function updateCharactersDrawerBadge(totalUnread = getTotalUnreadCount()) {
    const ids = ['rm_button_characters', 'rightNavDrawerIcon'];
    for (const id of ids) {
        const drawerButton = document.getElementById(id);
        if (!drawerButton) {
            continue;
        }
        let badge = drawerButton.querySelector('.sb-drawer-notification-badge');
        if (totalUnread <= 0) {
            badge?.remove();
            continue;
        }

        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'sb-drawer-notification-badge';
            drawerButton.appendChild(badge);
        }
        badge.style.display = 'block';
        badge.textContent = '';
    }
}

export function updateConversationNotificationIndicators() {
    const totalUnread = getTotalUnreadCount();
    updateListToggleBadge(totalUnread);
    updateConversationTitleBadge(totalUnread);
    updateConversationFaviconBadge(totalUnread);
    updateConversationTabBadge(totalUnread);
    updateCharactersDrawerBadge(totalUnread);
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
