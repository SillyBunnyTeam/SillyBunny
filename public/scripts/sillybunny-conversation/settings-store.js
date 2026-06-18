import { characters, getThumbnailUrl } from '../../script.js';
import {
    AUTO_CHAT_LAST_SENT_MARKER,
    CHARACTER_CONVERSATION_SETTINGS_KEYS,
    DEFAULT_AUTO_CHAT_COOLDOWN,
    DEFAULT_BRANCH_ID,
    DEFAULT_SETTINGS,
} from './constants.js';
import {
    getActiveConversationBranch,
    getCharacterConversationStore,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationStore,
    getConversationThreadStore,
    getCurrentCharAvatar,
    getGroupConversationSettings,
    normalizeConversationBranch,
    parseConversationThreadKey,
    parsePositiveInt,
    persistConversationStore,
    pickConversationSettings,
    safeParseSettings,
} from './context.js';
import { getCharacterForAvatar } from './media.js';
import { renderConversationMemoryPanel } from './settings-panel.js';
import { getConversationMessagePreviewText } from './thread-store.js';

export function getSettings(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return { ...DEFAULT_SETTINGS };
    }

    const threadStore = getConversationThreadStore(avatar, { create: false, groupId });
    if (groupId) {
        const threadSettings = threadStore?.settings
            ? pickConversationSettings(threadStore.settings, CHARACTER_CONVERSATION_SETTINGS_KEYS)
            : {};
        return { ...DEFAULT_SETTINGS, ...getGroupConversationSettings(groupId), ...threadSettings };
    }

    const settings = threadStore?.settings || getCharacterConversationStore(avatar, { create: false })?.settings || {};
    return { ...DEFAULT_SETTINGS, ...settings };
}

export function isConversationModeEnabled(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const threadStore = getConversationThreadStore(avatar, { create: false, groupId });
    return Boolean(threadStore?.settings?.enabled);
}

export function getConversationWelcomeChats({ max = Infinity } = {}) {
    if (!Array.isArray(characters)) {
        return [];
    }

    const chats = [];
    const pushConversationChat = (character, threadStore, group = null) => {
        const avatar = character?.avatar;
        const settings = avatar ? getSettings(avatar, { groupId: group?.id || '' }) : { ...DEFAULT_SETTINGS };
        if (!avatar || !settings.enabled || !threadStore) {
            return;
        }

        const branchId = threadStore.activeBranchId || DEFAULT_BRANCH_ID;
        const branch = normalizeConversationBranch(threadStore.branches?.[branchId], branchId);
        const messages = Array.isArray(branch?.messages) ? branch.messages : [];
        if (group && !messages.length && !branch.unread && branch.preview === 'Conversation ready') {
            return;
        }

        const timestamp = parsePositiveInt(branch?.updatedAt || branch?.createdAt, Date.now(), 1);
        const date = new Date(timestamp);
        const branchName = branch?.name && branch.name !== 'Main' ? branch.name : 'Conversation Mode';
        const groupName = group?.name || '';
        chats.push({
            avatar,
            group: group?.id || '',
            char_name: groupName || character.name || 'Character',
            char_thumbnail: getThumbnailUrl('avatar', avatar),
            chat_name: groupName ? `${character.name || 'Character'} · ${branchName}` : branchName,
            file_name: groupName ? `${groupName} · ${character.name || 'Character'}` : branchName,
            mes: branch?.preview || getConversationMessagePreviewText(messages[messages.length - 1]) || 'Conversation ready',
            chat_items: messages.length,
            file_size: groupName ? 'Group DM' : 'DM',
            date_short: date.toLocaleDateString(),
            date_long: date.toLocaleString(),
            last_mes: timestamp,
            is_group: Boolean(group),
            is_agent: false,
            is_conversation: true,
            recent_chat_type: 'conversation',
            hidden: false,
            pinned: false,
        });
    };

    characters.forEach((character) => {
        const avatar = character?.avatar;
        if (!avatar) {
            return;
        }

        pushConversationChat(character, getConversationThreadStore(avatar, { create: false, groupId: '' }));
    });

    Object.entries(getConversationStore().characters || {}).forEach(([storeKey, threadStore]) => {
        const parsed = parseConversationThreadKey(storeKey);
        if (!parsed.groupId || !parsed.avatar) {
            return;
        }

        const character = getCharacterForAvatar(parsed.avatar);
        const group = getConversationGroupById(parsed.groupId);
        if (!character || !group) {
            return;
        }

        pushConversationChat(character, threadStore, group);
    });

    return chats
        .sort((first, second) => Number(second.last_mes || 0) - Number(first.last_mes || 0))
        .slice(0, Number.isFinite(max) ? max : undefined);
}

export function saveSettings(avatar, settings, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    const threadStore = getConversationThreadStore(avatar, { create: true, groupId });
    if (threadStore) {
        const normalizedSettings = safeParseSettings(settings);
        threadStore.settings = groupId
            ? pickConversationSettings(normalizedSettings, CHARACTER_CONVERSATION_SETTINGS_KEYS)
            : normalizedSettings;
    }
    persistConversationStore();
}

export function getLastUserActivity(avatar, fallback = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getActiveConversationBranch(avatar, { create: false, groupId })?.lastActivity, fallback, 1);
}

export function setLastUserActivity(avatar, timestamp = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (branch) {
        branch.lastActivity = timestamp;
        branch.updatedAt = Date.now();
        persistConversationStore();
    }
}

export function getFollowupCount(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getActiveConversationBranch(avatar, { create: false, groupId })?.followupCount, 0, 0);
}

export function setFollowupCount(avatar, count, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (branch) {
        branch.followupCount = Math.max(0, count);
        persistConversationStore();
    }
}

export function resetFollowupCount(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!avatar) {
        return;
    }

    setFollowupCount(avatar, 0, { groupId });
}

export function getConversationSessionMarker(avatar, markerKey, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return String(getActiveConversationBranch(avatar, { create: false, groupId })?.sessionMarkers?.[markerKey] ?? '');
}

export function setConversationSessionMarker(avatar, markerKey, value, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (!branch) {
        return;
    }

    branch.sessionMarkers = branch.sessionMarkers && typeof branch.sessionMarkers === 'object' ? branch.sessionMarkers : {};
    branch.sessionMarkers[markerKey] = String(value);
    persistConversationStore();
}

export function getConversationBranchActivityTime(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { create: false, groupId });
    return parsePositiveInt(branch?.updatedAt || branch?.createdAt, Date.now(), 1);
}

export function getLastAutoCharacterChatTime(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return parsePositiveInt(getConversationSessionMarker(avatar, AUTO_CHAT_LAST_SENT_MARKER, { groupId }), 0, 0);
}

export function setLastAutoCharacterChatTime(avatar, timestamp = Date.now(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    setConversationSessionMarker(avatar, AUTO_CHAT_LAST_SENT_MARKER, timestamp, { groupId });
}

export function getAutoCharacterChatCooldownMs(settings) {
    return parsePositiveInt(settings?.auto_chat_cooldown, DEFAULT_AUTO_CHAT_COOLDOWN, 1) * 60 * 1000;
}

export function getConversationMemorySummary(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    return String(getActiveConversationBranch(avatar, { create: false, groupId })?.memorySummary || '').trim();
}

export function saveConversationMemorySummary(avatar, summary, messageCount, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (!branch) {
        return;
    }

    branch.memorySummary = String(summary || '').trim();
    branch.memoryMessageCount = Math.max(0, messageCount || 0);
    persistConversationStore();
    renderConversationMemoryPanel();
}

export function clearConversationMemorySummary(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { create: false, groupId });
    if (!branch) {
        return false;
    }

    branch.memorySummary = '';
    branch.memoryMessageCount = 0;
    persistConversationStore();
    renderConversationMemoryPanel();
    return true;
}
