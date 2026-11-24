import { playMessageSound } from '../power-user.js';
import { selectConversation } from './chrome.js';
import { CHROME_IDS, SAFE_TOAST_OPTIONS } from './constants.js';
import {
    clearLegacyConversationUnreadStorage,
    getActiveConversationChat,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationStore,
    getConversationRecord,
    getConversationKey,
    getCurrentCharAvatar,
    isConversationKeyForPersona,
    parseConversationKey,
    parsePositiveInt,
    persistConversationStore,
    shouldSurfaceConversationNotification,
} from './context.js';
import { getCharacterForAvatar } from './media.js';
import {
    clearConversationUnreadStore,
    getConversationUnreadCount,
    sanitizeConversationUnreadStore,
    setConversationUnreadCount,
} from './notification-utils.js';
import { getSettings, isConversationModeEnabled } from './settings-store.js';
import { conversationState } from './state.js';
import { stripPreviewText } from './typing.js';

export function getUnreadCount(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (chatId) {
        return parsePositiveInt(getActiveConversationChat(avatar, { chatId, create: false, groupId, personaId })?.unread, 0, 0);
    }

    return getConversationUnreadCount(getConversationRecord(avatar, { create: false, groupId, personaId }));
}

export function setUnreadCount(avatar, count, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const conversationRecord = getConversationRecord(avatar, { create: false, groupId, personaId });
    if (!conversationRecord) {
        return;
    }

    if (!setConversationUnreadCount(conversationRecord, count, { chatId })) {
        return;
    }
    persistConversationStore();
}

export function clearUnreadCount(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    setUnreadCount(avatar, 0, { chatId, groupId, personaId });
}

export function incrementUnreadCount(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    const currentUnread = parsePositiveInt(getActiveConversationChat(avatar, { chatId, create: false, groupId, personaId })?.unread, 0, 0);
    setUnreadCount(avatar, currentUnread + 1, { chatId, groupId, personaId });
}

function isUnreadConversationCountable(avatar, groupId) {
    if (!avatar || !getCharacterForAvatar(avatar)) {
        return false;
    }

    if (groupId) {
        const group = getConversationGroupById(groupId);
        if (!group?.members?.includes(avatar) || group.disabled_members?.includes(avatar)) {
            return false;
        }
    }

    return isConversationModeEnabled(avatar, { groupId });
}

function getUnreadConversationIdentity(conversationKey) {
    const parsed = parseConversationKey(conversationKey);
    return {
        avatar: parsed.avatar,
        groupId: parsed.groupId || '',
    };
}

export function sanitizeConversationUnreadCounts() {
    const result = sanitizeConversationUnreadStore(getConversationStore(), (conversationKey) => {
        if (!isConversationKeyForPersona(conversationKey)) {
            return true;
        }

        const { avatar, groupId } = getUnreadConversationIdentity(conversationKey);
        return isUnreadConversationCountable(avatar, groupId);
    });

    if (result.changed) {
        persistConversationStore();
    }
    return result;
}

export function clearAllConversationUnreadCounts() {
    const storeResult = clearConversationUnreadStore(getConversationStore(), conversationKey => isConversationKeyForPersona(conversationKey));
    const removedLegacy = clearLegacyConversationUnreadStorage();
    const changed = storeResult.changed || removedLegacy > 0;

    if (storeResult.changed) {
        persistConversationStore();
    }
    if (changed) {
        updateConversationNotificationIndicators();
    }

    return { ...storeResult, changed, removedLegacy };
}

export function getTotalUnreadCount() {
    return Object.entries(getConversationStore().characters || {}).reduce((sum, [conversationKey, conversationRecord]) => {
        if (!isConversationKeyForPersona(conversationKey)) {
            return sum;
        }

        const { avatar, groupId } = getUnreadConversationIdentity(conversationKey);
        if (!isUnreadConversationCountable(avatar, groupId)) {
            return sum;
        }

        return sum + getConversationUnreadCount(conversationRecord);
    }, 0);
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
    const conversationRecord = getConversationRecord(avatar, { create: false, groupId, personaId });
    return Boolean(
        conversationState.conversationWorkspaceOpen
        && avatar
        && personaId === currentPersonaId
        && getConversationKey(avatar, groupId || '', { personaId }) === getActiveConversationKey()
        && (!chatId || chatId === conversationRecord?.activeBranchId),
    );
}

export function isConversationActiveForAvatar(avatar) {
    return isConversationActive(avatar);
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
    const title = `New DM from ${message.name || character?.name || 'Character'}`;
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
