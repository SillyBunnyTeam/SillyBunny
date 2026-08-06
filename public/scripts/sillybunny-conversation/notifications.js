import { playMessageSound } from '../power-user.js';
import { selectConversationThread } from './chrome.js';
import { CHROME_IDS, SAFE_TOAST_OPTIONS } from './constants.js';
import {
    clearLegacyConversationUnreadStorage,
    getActiveConversationBranch,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationStore,
    getConversationThreadStore,
    getConversationThreadKey,
    getCurrentCharAvatar,
    isConversationThreadKeyForPersona,
    parseConversationThreadKey,
    parsePositiveInt,
    persistConversationStore,
    shouldSurfaceConversationNotification,
} from './context.js';
import { getCharacterForAvatar } from './media.js';
import {
    clearConversationUnreadStore,
    getConversationThreadUnreadCount,
    sanitizeConversationUnreadStore,
    setConversationThreadUnreadCount,
} from './notification-utils.js';
import { getSettings, isConversationModeEnabled } from './settings-store.js';
import { conversationState } from './state.js';
import { stripPreviewText } from './typing.js';

export function getUnreadCount(avatar, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (branchId) {
        return parsePositiveInt(getActiveConversationBranch(avatar, { branchId, create: false, groupId, personaId })?.unread, 0, 0);
    }

    return getConversationThreadUnreadCount(getConversationThreadStore(avatar, { create: false, groupId, personaId }));
}

export function setUnreadCount(avatar, count, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const threadStore = getConversationThreadStore(avatar, { create: false, groupId, personaId });
    if (!threadStore) {
        return;
    }

    if (!setConversationThreadUnreadCount(threadStore, count, { branchId })) {
        return;
    }
    persistConversationStore();
}

export function clearUnreadCount(avatar, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    setUnreadCount(avatar, 0, { branchId, groupId, personaId });
}

export function incrementUnreadCount(avatar, { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    const currentUnread = parsePositiveInt(getActiveConversationBranch(avatar, { branchId, create: false, groupId, personaId })?.unread, 0, 0);
    setUnreadCount(avatar, currentUnread + 1, { branchId, groupId, personaId });
}

function isUnreadThreadCountable(avatar, groupId) {
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

function getUnreadThreadIdentity(threadKey) {
    const parsed = parseConversationThreadKey(threadKey);
    return {
        avatar: parsed.avatar,
        groupId: parsed.groupId || '',
    };
}

export function sanitizeConversationUnreadCounts() {
    const result = sanitizeConversationUnreadStore(getConversationStore(), (threadKey) => {
        if (!isConversationThreadKeyForPersona(threadKey)) {
            return true;
        }

        const { avatar, groupId } = getUnreadThreadIdentity(threadKey);
        return isUnreadThreadCountable(avatar, groupId);
    });

    if (result.changed) {
        persistConversationStore();
    }
    return result;
}

export function clearAllConversationUnreadCounts() {
    const storeResult = clearConversationUnreadStore(getConversationStore(), threadKey => isConversationThreadKeyForPersona(threadKey));
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
    return Object.entries(getConversationStore().characters || {}).reduce((sum, [threadKey, threadStore]) => {
        if (!isConversationThreadKeyForPersona(threadKey)) {
            return sum;
        }

        const { avatar, groupId } = getUnreadThreadIdentity(threadKey);
        if (!isUnreadThreadCountable(avatar, groupId)) {
            return sum;
        }

        return sum + getConversationThreadUnreadCount(threadStore);
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

export function getFaviconLink() {
    let link = document.querySelector('link[rel~="icon"]');
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

export function updatePalsToggleBadge(totalUnread = getTotalUnreadCount()) {
    const badge = document.querySelector(`#${CHROME_IDS.palsToggle} .sb-conversation-pals-toggle-badge`);
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
    updatePalsToggleBadge(totalUnread);
    updateConversationTitleBadge(totalUnread);
    updateConversationFaviconBadge(totalUnread);
    updateConversationTabBadge(totalUnread);
    updateCharactersDrawerBadge(totalUnread);
}

export function getActiveConversationThreadKey() {
    if (!conversationState.conversationWorkspaceOpen) {
        return '';
    }

    return getConversationThreadKey(getCurrentCharAvatar(), conversationState.conversationSelectedGroupId || '');
}

export function isConversationActiveThread(avatar, groupId = getConversationGroupIdForAvatar(avatar), { branchId = '', personaId = getConversationPersonaId() } = {}) {
    const currentPersonaId = getConversationPersonaId();
    const threadStore = getConversationThreadStore(avatar, { create: false, groupId, personaId });
    return Boolean(
        conversationState.conversationWorkspaceOpen
        && avatar
        && personaId === currentPersonaId
        && getConversationThreadKey(avatar, groupId || '', { personaId }) === getActiveConversationThreadKey()
        && (!branchId || branchId === threadStore?.activeBranchId),
    );
}

export function isConversationActiveForAvatar(avatar) {
    return isConversationActiveThread(avatar);
}

export async function openConversationFromNotification(avatar, { branchId = '', groupId = null, personaId = getConversationPersonaId() } = {}) {
    return selectConversationThread(avatar, { branchId, groupId, personaId, showToast: false });
}

export function showConversationToast(avatar, message, { branchId = '', groupId = null, personaId = getConversationPersonaId() } = {}) {
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
        onclick: () => void openConversationFromNotification(avatar, { branchId, groupId, personaId }),
    });
}

export function notifyNewConversationMessage(avatar, message, shouldNotify, { branchId = '', groupId = null, personaId = getConversationPersonaId() } = {}) {
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

    showConversationToast(avatar, message, { branchId, groupId, personaId });
}
