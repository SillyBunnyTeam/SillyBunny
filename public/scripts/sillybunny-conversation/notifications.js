import { playMessageSound } from '../power-user.js';
import { openConversationWorkspaceForAvatar } from './chrome.js';
import { CHROME_IDS, DEFAULT_BRANCH_ID, SAFE_TOAST_OPTIONS } from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupIdForAvatar,
    getConversationStore,
    getConversationThreadKey,
    getCurrentCharAvatar,
    parseConversationThreadKey,
    parsePositiveInt,
    persistConversationStore,
    shouldSurfaceConversationNotification,
} from './context.js';
import { getCharacterForAvatar } from './media.js';
import { getSettings, isConversationModeEnabled } from './settings-store.js';
import { conversationState } from './state.js';
import { stripPreviewText } from './typing.js';

export function getUnreadCount(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getActiveConversationBranch(avatar, { create: false, groupId })?.unread, 0, 0);
}

export function setUnreadCount(avatar, count, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (branch) {
        branch.unread = Math.max(0, count);
        persistConversationStore();
    }
}

export function clearUnreadCount(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    setUnreadCount(avatar, 0, { groupId });
}

export function incrementUnreadCount(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    setUnreadCount(avatar, getUnreadCount(avatar, { groupId }) + 1, { groupId });
}

export function getTotalUnreadCount() {
    return Object.entries(getConversationStore().characters || {}).reduce((sum, [threadKey, threadStore]) => {
        const parsed = parseConversationThreadKey(threadKey);
        const avatar = parsed.groupId ? parsed.avatar : threadKey;
        if (!avatar || !getCharacterForAvatar(avatar)) {
            return sum;
        }

        const groupId = parsed.groupId || '';
        if (!isConversationModeEnabled(avatar, { groupId })) {
            return sum;
        }

        const branchId = threadStore?.activeBranchId || DEFAULT_BRANCH_ID;
        const unread = parsePositiveInt(threadStore?.branches?.[branchId]?.unread, 0, 0);
        return sum + unread;
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
    const tabButton = document.getElementById('sb_character_tab_conversation');
    if (!tabButton) {
        return;
    }
    let badge = tabButton.querySelector('.sb-tab-notification-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'sb-tab-notification-badge';
        tabButton.appendChild(badge);
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
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'sb-drawer-notification-badge';
            drawerButton.appendChild(badge);
        }
        badge.style.display = totalUnread > 0 ? 'block' : 'none';
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

export function isConversationActiveThread(avatar, groupId = getConversationGroupIdForAvatar(avatar)) {
    return Boolean(
        conversationState.conversationWorkspaceOpen
        && avatar
        && getConversationThreadKey(avatar, groupId || '') === getActiveConversationThreadKey(),
    );
}

export function isConversationActiveForAvatar(avatar) {
    return isConversationActiveThread(avatar);
}

export function openConversationFromNotification(avatar, { groupId = null } = {}) {
    if (!openConversationWorkspaceForAvatar(avatar, { groupId, showToast: false })) {
        return;
    }
}

export function showConversationToast(avatar, message, { groupId = null } = {}) {
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
        onclick: () => openConversationFromNotification(avatar, { groupId }),
    });
}

export function notifyNewConversationMessage(avatar, message, shouldNotify, { groupId = null } = {}) {
    updateConversationNotificationIndicators();
    if (!shouldNotify || !message || message.role === 'user' || message.role === 'system') {
        return;
    }

    const settings = getSettings(avatar, { groupId });
    if (!shouldSurfaceConversationNotification(settings)) {
        return;
    }

    try {
        playMessageSound({ force: true });
    } catch (error) {
        console.warn('Conversation Mode: notification sound failed', error);
    }

    showConversationToast(avatar, message, { groupId });
}
