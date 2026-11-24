import { characters, getThumbnailUrl } from '../../script.js';
import {
    AUTO_CHAT_LAST_SENT_MARKER,
    CHARACTER_CONVERSATION_SETTINGS_KEYS,
    DEFAULT_AUTO_CHAT_COOLDOWN,
    DEFAULT_CHAT_ID,
    DEFAULT_SETTINGS,
    GLOBAL_CONVERSATION_SETTINGS_KEYS,
    CONVERSATION_SETTINGS_KEYS,
} from './constants.js';
import {
    getActiveConversationChat,
    getCharacterConversationStore,
    getConversationGroupById,
    getConversationGroupAnchor,
    getConversationGroupIdForAvatar,
    getConversationGroups,
    getConversationPersonaId,
    isConversationKeyForPersona,
    getConversationStore,
    getConversationKey,
    getConversationRecord,
    getCurrentCharAvatar,
    getGroupConversationSettings,
    normalizeConversationChat,
    parseConversationKey,
    parsePositiveInt,
    persistConversationStore,
    pickConversationSettings,
    safeParseSettings,
} from './context.js';
import { collectGroupConversationMemorySummaries, collectSoloConversationMemorySummary } from './memory-utils.js';
import { renderConversationMemoryPanel } from './settings-panel.js';
import { getConversationMessagePreviewText } from './conversation-store.js';

export { collectGroupConversationMemorySummaries, collectSoloConversationMemorySummary };

const GROUP_CONVERSATION_FORCED_SETTINGS = Object.freeze({
    multi_char: true,
    auto_character_chat: true,
});

let conversationUsageCache = null;

function conversationRecordHasUsage(storeKey, conversationRecord) {
    if (!conversationRecord || typeof conversationRecord !== 'object') {
        return false;
    }

    if (conversationRecord.settings?.enabled === true) {
        return true;
    }

    const parsed = parseConversationKey(storeKey);
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
        .some(([storeKey, conversationRecord]) => isConversationKeyForPersona(storeKey) && conversationRecordHasUsage(storeKey, conversationRecord));
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

function getGroupRecordConversationSettings(conversationRecord) {
    return conversationRecord?.settings
        ? pickConversationSettings(conversationRecord.settings, CHARACTER_CONVERSATION_SETTINGS_KEYS)
        : {};
}

function getSoloRecordConversationSettings(avatar, conversationRecord, personaId) {
    return conversationRecord?.settings || getCharacterConversationStore(avatar, { create: false, personaId })?.settings || {};
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

function getCurrentPersonaMemoryCharactersStore(personaId = getConversationPersonaId()) {
    const store = getConversationStore();
    return Object.entries(store.characters || {}).reduce((result, [storeKey, conversationRecord]) => {
        if (!isConversationKeyForPersona(storeKey, personaId)) {
            return result;
        }

        const parsed = parseConversationKey(storeKey);
        if (!parsed.avatar) {
            return result;
        }

        const baseKey = parsed.groupId ? `group:${parsed.groupId}:${parsed.avatar}` : parsed.avatar;
        result[baseKey] = conversationRecord;
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

export function getSettings(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const globalSettings = getGlobalConversationSettings();
    if (!avatar) {
        return mergeConversationSettingsLayers(DEFAULT_SETTINGS, globalSettings);
    }

    const conversationRecord = getConversationRecord(avatar, { create: false, groupId, personaId });
    if (groupId) {
        return mergeConversationSettingsLayers(
            DEFAULT_SETTINGS,
            globalSettings,
            GROUP_CONVERSATION_FORCED_SETTINGS,
            personaId === getConversationPersonaId()
                ? getGroupConversationSettings(groupId)
                : getGroupConversationSettings(groupId, { personaId }),
            getGroupRecordConversationSettings(conversationRecord),
        );
    }

    return mergeConversationSettingsLayers(
        DEFAULT_SETTINGS,
        getSoloRecordConversationSettings(avatar, conversationRecord, personaId),
        globalSettings,
    );
}

export function isConversationModeEnabled(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (groupId) {
        return true;
    }
    const conversationRecord = getConversationRecord(avatar, { create: false, groupId });
    return Boolean(conversationRecord?.settings?.enabled);
}

export function getConversationWelcomeChats({ max = Infinity } = {}) {
    if (!Array.isArray(characters)) {
        return [];
    }

    const chats = [];
    const pushedKeys = new Set();
    const pushedGroupIds = new Set();
    const pushConversationChat = (character, conversationRecord, group = null) => {
        const avatar = character?.avatar;
        const groupId = group?.id ? String(group.id) : '';
        const settings = avatar ? getSettings(avatar, { groupId: group?.id || '' }) : { ...DEFAULT_SETTINGS };
        if (!avatar || (!group && !settings.enabled) || (!conversationRecord && !group)) {
            return;
        }

        const key = getConversationKey(avatar, groupId);
        if (!key || pushedKeys.has(key) || (groupId && pushedGroupIds.has(groupId))) {
            return;
        }

        const chatId = conversationRecord?.activeBranchId || DEFAULT_CHAT_ID;
        const chat = normalizeConversationChat(conversationRecord?.branches?.[chatId], chatId);
        if (!conversationRecord && group) {
            const groupTimestamp = parsePositiveInt(group.updatedAt || group.createdAt, Date.now(), 0);
            chat.createdAt = groupTimestamp;
            chat.updatedAt = groupTimestamp;
        }
        const messages = Array.isArray(chat?.messages) ? chat.messages : [];
        if (group && !group.is_conversation_group && !messages.length && !chat.unread && chat.preview === 'Conversation ready') {
            return;
        }

        const timestamp = parsePositiveInt(chat?.updatedAt || chat?.createdAt, Date.now(), 1);
        const date = new Date(timestamp);
        const chatName = chat?.name && chat.name !== 'Main' ? chat.name : 'Conversation Mode';
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
            chat_name: groupName ? `${character.name || 'Character'} · ${chatName}` : chatName,
            file_name: groupName ? `${groupName} · ${character.name || 'Character'}` : chatName,
            mes: chat?.preview || getConversationMessagePreviewText(messages[messages.length - 1]) || 'Conversation ready',
            chat_items: messages.length,
            file_size: groupName ? 'Group DM' : 'DM',
            date_short: date.toLocaleDateString(),
            date_long: date.toLocaleString(),
            last_mes: timestamp,
            is_group: Boolean(group),
            is_agent: false,
            is_conversation: true,
            recent_chat_type: 'conversation',
            conversation_branch_id: chatId,
            conversation_branch_name: chatName,
            hidden: false,
            pinned: false,
        });
    };

    characters.forEach((character) => {
        const avatar = character?.avatar;
        if (!avatar) {
            return;
        }

        pushConversationChat(character, getConversationRecord(avatar, { create: false, groupId: '' }));
    });

    getConversationGroups().forEach((group) => {
        const anchor = getConversationGroupAnchor(group);
        if (!anchor?.character?.avatar) {
            return;
        }

        pushConversationChat(anchor.character, anchor.conversationRecord, group);
    });

    Object.entries(getConversationStore().characters || {}).forEach(([storeKey]) => {
        if (!isConversationKeyForPersona(storeKey)) {
            return;
        }

        const parsed = parseConversationKey(storeKey);
        if (!parsed.groupId || !parsed.avatar) {
            return;
        }

        const group = getConversationGroupById(parsed.groupId);
        const anchor = getConversationGroupAnchor(group);
        if (!anchor?.character || !group) {
            return;
        }

        pushConversationChat(anchor.character, anchor.conversationRecord, group);
    });

    return chats
        .sort((first, second) => Number(second.last_mes || 0) - Number(first.last_mes || 0))
        .slice(0, Number.isFinite(max) ? max : undefined);
}

export function saveSettings(avatar, settings, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    const conversationRecord = getConversationRecord(avatar, { create: true, groupId, personaId });
    const normalizedSettings = safeParseSettings(settings);
    getConversationStore().settings = normalizeGlobalConversationSettings(normalizedSettings);
    if (conversationRecord) {
        conversationRecord.settings = groupId
            ? pickConversationSettings(normalizedSettings, CHARACTER_CONVERSATION_SETTINGS_KEYS)
            : pickConversationSettings(normalizedSettings, CONVERSATION_SETTINGS_KEYS);
    }
    invalidateConversationUsageCache();
    persistConversationStore();
}

export function getLastUserActivity(avatar, fallback = Date.now(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return parsePositiveInt(getActiveConversationChat(avatar, { chatId, create: false, groupId, personaId })?.lastActivity, fallback, 1);
}

export function setLastUserActivity(avatar, timestamp = Date.now(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const chat = getActiveConversationChat(avatar, { chatId, create: !chatId, groupId, personaId });
    if (chat) {
        chat.lastActivity = timestamp;
        chat.updatedAt = Date.now();
        persistConversationStore();
    }
}

export function getFollowupCount(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return parsePositiveInt(getActiveConversationChat(avatar, { chatId, create: false, groupId, personaId })?.followupCount, 0, 0);
}

export function setFollowupCount(avatar, count, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const chat = getActiveConversationChat(avatar, { chatId, create: !chatId, groupId, personaId });
    if (chat) {
        chat.followupCount = Math.max(0, count);
        persistConversationStore();
    }
}

export function resetFollowupCount(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    setFollowupCount(avatar, 0, { chatId, groupId, personaId });
}

export function getConversationSessionMarker(avatar, markerKey, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return String(getActiveConversationChat(avatar, { chatId, create: false, groupId, personaId })?.sessionMarkers?.[markerKey] ?? '');
}

export function setConversationSessionMarker(avatar, markerKey, value, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const chat = getActiveConversationChat(avatar, { chatId, create: !chatId, groupId, personaId });
    if (!chat) {
        return;
    }

    chat.sessionMarkers = chat.sessionMarkers && typeof chat.sessionMarkers === 'object' ? chat.sessionMarkers : {};
    chat.sessionMarkers[markerKey] = String(value);
    persistConversationStore();
}

export function getConversationChatActivityTime(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const chat = getActiveConversationChat(avatar, { chatId, create: false, groupId, personaId });
    return parsePositiveInt(chat?.updatedAt || chat?.createdAt, Date.now(), 1);
}

export function getLastAutoCharacterChatTime(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return parsePositiveInt(getConversationSessionMarker(avatar, AUTO_CHAT_LAST_SENT_MARKER, { chatId, groupId, personaId }), 0, 0);
}

export function setLastAutoCharacterChatTime(avatar, timestamp = Date.now(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    setConversationSessionMarker(avatar, AUTO_CHAT_LAST_SENT_MARKER, timestamp, { chatId, groupId, personaId });
}

export function getAutoCharacterChatCooldownMs(settings) {
    return parsePositiveInt(settings?.auto_chat_cooldown, DEFAULT_AUTO_CHAT_COOLDOWN, 1) * 60 * 1000;
}

export function getConversationMemorySummary(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const conversationRecord = getConversationRecord(avatar, { create: false, groupId, personaId });
    const chat = getActiveConversationChat(avatar, { chatId, create: false, groupId, personaId });
    return String((chatId ? chat?.memorySummary : conversationRecord?.memorySummary) || chat?.memorySummary || conversationRecord?.memorySummary || '').trim();
}

export function getConversationGroupMemorySummaries(avatar = getCurrentCharAvatar(), { excludeGroupId = '', max = 4, personaId = getConversationPersonaId() } = {}) {
    return collectGroupConversationMemorySummaries(getCurrentPersonaMemoryCharactersStore(personaId), avatar, {
        excludeGroupId,
        max,
        getGroupName: groupId => getConversationGroupById(groupId, { personaId })?.name || '',
    });
}

export function getConversationSoloMemorySummary(avatar = getCurrentCharAvatar(), { personaId = getConversationPersonaId() } = {}) {
    return collectSoloConversationMemorySummary(getCurrentPersonaMemoryCharactersStore(personaId), avatar);
}

export function saveConversationMemorySummary(avatar, summary, messageCount, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const conversationRecord = getConversationRecord(avatar, { create: false, groupId, personaId });
    const chat = getActiveConversationChat(avatar, { chatId, create: false, groupId, personaId });
    if (!conversationRecord || !chat) {
        return;
    }

    const memorySummary = String(summary || '').trim();
    const memoryMessageCount = Math.max(0, messageCount || 0);
    chat.memorySummary = memorySummary;
    chat.memoryMessageCount = memoryMessageCount;
    chat.memoryUpdatedAt = Date.now();
    if (!chatId || conversationRecord.activeBranchId === chat.id) {
        conversationRecord.memorySummary = memorySummary;
        conversationRecord.memoryMessageCount = memoryMessageCount;
        conversationRecord.memoryUpdatedAt = chat.memoryUpdatedAt;
    }
    persistConversationStore();
    renderConversationMemoryPanel();
}

export function clearConversationMemorySummary(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const conversationRecord = getConversationRecord(avatar, { create: false, groupId });
    const chat = getActiveConversationChat(avatar, { create: false, groupId });
    if (!conversationRecord || !chat) {
        return false;
    }

    conversationRecord.memorySummary = '';
    conversationRecord.memoryMessageCount = 0;
    conversationRecord.memoryUpdatedAt = Date.now();
    Object.values(conversationRecord.branches || {}).forEach((item) => {
        if (item && typeof item === 'object') {
            item.memorySummary = '';
            item.memoryMessageCount = 0;
            item.memoryUpdatedAt = conversationRecord.memoryUpdatedAt;
        }
    });
    persistConversationStore();
    renderConversationMemoryPanel();
    return true;
}
