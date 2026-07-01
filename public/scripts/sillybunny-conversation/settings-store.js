import { characters, getThumbnailUrl } from '../../script.js';
import {
    AUTO_CHAT_LAST_SENT_MARKER,
    CHARACTER_CONVERSATION_SETTINGS_KEYS,
    DEFAULT_AUTO_CHAT_COOLDOWN,
    DEFAULT_BRANCH_ID,
    DEFAULT_SETTINGS,
    GLOBAL_CONVERSATION_SETTINGS_KEYS,
    THREAD_CONVERSATION_SETTINGS_KEYS,
} from './constants.js';
import {
    getActiveConversationBranch,
    getCharacterConversationStore,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationGroups,
    isConversationThreadKeyForPersona,
    getConversationStore,
    getConversationThreadKey,
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
import { collectGroupConversationMemorySummaries, collectSoloConversationMemorySummary } from './memory-utils.js';
import { renderConversationMemoryPanel } from './settings-panel.js';
import { getConversationMessagePreviewText } from './thread-store.js';

export { collectGroupConversationMemorySummaries, collectSoloConversationMemorySummary };

const GROUP_CONVERSATION_FORCED_SETTINGS = Object.freeze({
    multi_char: true,
    auto_character_chat: true,
});

let conversationUsageCache = null;

function threadStoreHasConversationUsage(storeKey, threadStore) {
    if (!threadStore || typeof threadStore !== 'object') {
        return false;
    }

    if (threadStore.settings?.enabled === true) {
        return true;
    }

    const parsed = parseConversationThreadKey(storeKey);
    return Boolean(parsed.groupId && parsed.avatar);
}

export function invalidateConversationUsageCache() {
    conversationUsageCache = null;
}

export function hasAnyConversationModeUsage() {
    const store = getConversationStore();
    const charactersStore = store.characters || {};
    const hasConversationGroups = getConversationGroups().length > 0;
    conversationUsageCache = hasConversationGroups || Object.entries(charactersStore)
        .some(([storeKey, threadStore]) => isConversationThreadKeyForPersona(storeKey) && threadStoreHasConversationUsage(storeKey, threadStore));
    return conversationUsageCache;
}

/**
 * Conversation settings are stored in separate persisted scopes. Keep this
 * precedence stable unless a migration updates existing saved data:
 * DEFAULT < group/thread scoped settings < global overrides.
 */
export function mergeConversationSettingsLayers(...layers) {
    return Object.assign({}, ...layers.filter(layer => layer && typeof layer === 'object'));
}

function getGroupThreadConversationSettings(threadStore) {
    return threadStore?.settings
        ? pickConversationSettings(threadStore.settings, CHARACTER_CONVERSATION_SETTINGS_KEYS)
        : {};
}

function getSoloThreadConversationSettings(avatar, threadStore) {
    return threadStore?.settings || getCharacterConversationStore(avatar, { create: false })?.settings || {};
}

function normalizeGlobalConversationSettings(settings = {}) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const normalized = safeParseSettings(source);
    return [...GLOBAL_CONVERSATION_SETTINGS_KEYS].reduce((picked, key) => {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            picked[key] = normalized[key];
        }
        return picked;
    }, {});
}

function getCurrentPersonaMemoryCharactersStore() {
    const store = getConversationStore();
    return Object.entries(store.characters || {}).reduce((result, [storeKey, threadStore]) => {
        if (!isConversationThreadKeyForPersona(storeKey)) {
            return result;
        }

        const parsed = parseConversationThreadKey(storeKey);
        if (!parsed.avatar) {
            return result;
        }

        const baseKey = parsed.groupId ? `group:${parsed.groupId}:${parsed.avatar}` : parsed.avatar;
        result[baseKey] = threadStore;
        return result;
    }, {});
}

export function getGlobalConversationSettings() {
    const store = getConversationStore();
    store.settings = normalizeGlobalConversationSettings(store.settings);
    return { ...store.settings };
}

export function saveGlobalConversationSettings(settings) {
    const store = getConversationStore();
    store.settings = normalizeGlobalConversationSettings(settings);
    invalidateConversationUsageCache();
    persistConversationStore();
}

export function getSettings(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const globalSettings = getGlobalConversationSettings();
    if (!avatar) {
        return mergeConversationSettingsLayers(DEFAULT_SETTINGS, globalSettings);
    }

    const threadStore = getConversationThreadStore(avatar, { create: false, groupId });
    if (groupId) {
        return mergeConversationSettingsLayers(
            DEFAULT_SETTINGS,
            globalSettings,
            GROUP_CONVERSATION_FORCED_SETTINGS,
            getGroupConversationSettings(groupId),
            getGroupThreadConversationSettings(threadStore),
        );
    }

    return mergeConversationSettingsLayers(
        DEFAULT_SETTINGS,
        getSoloThreadConversationSettings(avatar, threadStore),
        globalSettings,
    );
}

export function isConversationModeEnabled(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (groupId) {
        return true;
    }
    const threadStore = getConversationThreadStore(avatar, { create: false, groupId });
    return Boolean(threadStore?.settings?.enabled);
}

export function getConversationWelcomeChats({ max = Infinity } = {}) {
    if (!Array.isArray(characters)) {
        return [];
    }

    const chats = [];
    const pushedKeys = new Set();
    const pushedGroupIds = new Set();
    const getGroupDisplayCharacter = group => (group?.members || [])
        .map(avatar => getCharacterForAvatar(avatar))
        .find(character => character?.avatar) || null;
    const pushConversationChat = (character, threadStore, group = null) => {
        const avatar = character?.avatar;
        const groupId = group?.id ? String(group.id) : '';
        const settings = avatar ? getSettings(avatar, { groupId: group?.id || '' }) : { ...DEFAULT_SETTINGS };
        if (!avatar || (!group && !settings.enabled) || (!threadStore && !group)) {
            return;
        }

        const key = getConversationThreadKey(avatar, groupId);
        if (!key || pushedKeys.has(key) || (groupId && pushedGroupIds.has(groupId))) {
            return;
        }

        const branchId = threadStore?.activeBranchId || DEFAULT_BRANCH_ID;
        const branch = normalizeConversationBranch(threadStore?.branches?.[branchId], branchId);
        if (!threadStore && group) {
            const groupTimestamp = parsePositiveInt(group.updatedAt || group.createdAt, Date.now(), 0);
            branch.createdAt = groupTimestamp;
            branch.updatedAt = groupTimestamp;
        }
        const messages = Array.isArray(branch?.messages) ? branch.messages : [];
        if (group && !group.is_conversation_group && !messages.length && !branch.unread && branch.preview === 'Conversation ready') {
            return;
        }

        const timestamp = parsePositiveInt(branch?.updatedAt || branch?.createdAt, Date.now(), 1);
        const date = new Date(timestamp);
        const branchName = branch?.name && branch.name !== 'Main' ? branch.name : 'Conversation Mode';
        const groupName = group?.name || '';
        pushedKeys.add(key);
        if (groupId) {
            pushedGroupIds.add(groupId);
        }
        chats.push({
            avatar,
            group: groupId,
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

    getConversationGroups().forEach((group) => {
        const character = getGroupDisplayCharacter(group);
        if (!character?.avatar) {
            return;
        }

        pushConversationChat(character, getConversationThreadStore(character.avatar, { create: false, groupId: String(group.id || '') }), group);
    });

    Object.entries(getConversationStore().characters || {}).forEach(([storeKey, threadStore]) => {
        if (!isConversationThreadKeyForPersona(storeKey)) {
            return;
        }

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
    const normalizedSettings = safeParseSettings(settings);
    getConversationStore().settings = normalizeGlobalConversationSettings(normalizedSettings);
    if (threadStore) {
        threadStore.settings = groupId
            ? pickConversationSettings(normalizedSettings, CHARACTER_CONVERSATION_SETTINGS_KEYS)
            : pickConversationSettings(normalizedSettings, THREAD_CONVERSATION_SETTINGS_KEYS);
    }
    invalidateConversationUsageCache();
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
    const threadStore = getConversationThreadStore(avatar, { create: false, groupId });
    return String(threadStore?.memorySummary || getActiveConversationBranch(avatar, { create: false, groupId })?.memorySummary || '').trim();
}

export function getConversationGroupMemorySummaries(avatar = getCurrentCharAvatar(), { excludeGroupId = '', max = 4 } = {}) {
    return collectGroupConversationMemorySummaries(getCurrentPersonaMemoryCharactersStore(), avatar, {
        excludeGroupId,
        max,
        getGroupName: groupId => getConversationGroupById(groupId)?.name || '',
    });
}

export function getConversationSoloMemorySummary(avatar = getCurrentCharAvatar()) {
    return collectSoloConversationMemorySummary(getCurrentPersonaMemoryCharactersStore(), avatar);
}

export function saveConversationMemorySummary(avatar, summary, messageCount, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const threadStore = getConversationThreadStore(avatar, { groupId });
    const branch = getActiveConversationBranch(avatar, { groupId });
    if (!threadStore || !branch) {
        return;
    }

    const memorySummary = String(summary || '').trim();
    const memoryMessageCount = Math.max(0, messageCount || 0);
    threadStore.memorySummary = memorySummary;
    threadStore.memoryMessageCount = memoryMessageCount;
    threadStore.memoryUpdatedAt = Date.now();
    branch.memorySummary = memorySummary;
    branch.memoryMessageCount = memoryMessageCount;
    branch.memoryUpdatedAt = threadStore.memoryUpdatedAt;
    persistConversationStore();
    renderConversationMemoryPanel();
}

export function clearConversationMemorySummary(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const threadStore = getConversationThreadStore(avatar, { create: false, groupId });
    const branch = getActiveConversationBranch(avatar, { create: false, groupId });
    if (!threadStore || !branch) {
        return false;
    }

    threadStore.memorySummary = '';
    threadStore.memoryMessageCount = 0;
    threadStore.memoryUpdatedAt = Date.now();
    Object.values(threadStore.branches || {}).forEach((item) => {
        if (item && typeof item === 'object') {
            item.memorySummary = '';
            item.memoryMessageCount = 0;
            item.memoryUpdatedAt = threadStore.memoryUpdatedAt;
        }
    });
    persistConversationStore();
    renderConversationMemoryPanel();
    return true;
}
