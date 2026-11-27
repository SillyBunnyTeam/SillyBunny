import { characters, getThumbnailUrl } from '../../script.js';
import {
    DEFAULT_SETTINGS,
    GLOBAL_CONVERSATION_SETTINGS_KEYS,
} from './constants.js';
import {
    getActiveConversationChat,
    getConversationAddress,
    getConversationGroupAnchor,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationRecord,
    getConversationStore,
    getCurrentCharAvatar,
    parsePositiveInt,
    safeParseSettings,
} from './context.js';
import { conversationData } from './conversation-data-browser.js';
import { collectGroupConversationMemorySummaries, collectSoloConversationMemorySummary } from './memory-utils.js';

export { collectGroupConversationMemorySummaries, collectSoloConversationMemorySummary };

const MAX_RELATED_MEMORY_CONVERSATIONS = 4;

/** Whether the current persona has any conversation, which decides whether the worker and the badges start. */
export function hasAnyConversationModeUsage() {
    return conversationData.list({ personaId: getConversationPersonaId() }).length > 0;
}

/**
 * Conversation settings are stored in separate persisted scopes. Keep this
 * precedence stable unless a migration updates existing saved data:
 * DEFAULT < the conversation's own settings < mode-wide settings < what is derived (status, extras).
 */
export function mergeConversationSettingsLayers(...layers) {
    return Object.assign({}, ...layers.filter(layer => layer && typeof layer === 'object'));
}

/** The mode-wide settings keep every key that the server wrote, also the ones that this version has no control for. */
function normalizeGlobalConversationSettings(settings = {}, existing = {}) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const normalized = safeParseSettings(source);
    return [...GLOBAL_CONVERSATION_SETTINGS_KEYS].reduce((picked, key) => {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            picked[key] = normalized[key];
        }
        return picked;
    }, { ...existing });
}

export function getGlobalConversationSettings() {
    const store = getConversationStore();
    store.settings = normalizeGlobalConversationSettings(store.settings, store.settings);
    return { ...store.settings };
}

/**
 * What the conversation of an avatar has that is not a setting of the conversation file: the status that the user set
 * for the character (`availability`, which is "online" until one is set, and which does not follow the routine, so the
 * auto-responder answers only for a status that the user chose), and the extras.
 */
function getDerivedSettings(avatar, view) {
    const derived = { availability: conversationData.characterState(avatar).statusOverride ?? 'online' };
    if (view?.extras?.length) {
        derived.multi_char_names = view.extras.join(',');
    }
    return derived;
}

export function getSettings(avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const globalSettings = getGlobalConversationSettings();
    if (!avatar) {
        return mergeConversationSettingsLayers(DEFAULT_SETTINGS, globalSettings);
    }

    const view = getConversationRecord(avatar, { groupId, personaId });
    if (!view) {
        return mergeConversationSettingsLayers(DEFAULT_SETTINGS, { availability: getDerivedSettings(avatar, null).availability }, globalSettings);
    }
    const settings = mergeConversationSettingsLayers(
        DEFAULT_SETTINGS,
        view.settings,
        globalSettings,
        getDerivedSettings(avatar, view),
    );
    // The prompt of the conversation is stored as `system_prompt`; the rest of the mode still reads the old key.
    if (typeof view.settings?.system_prompt === 'string') {
        settings.geechan_chatroom_prompt = view.settings.system_prompt;
    }
    return settings;
}

export function isConversationModeEnabled(avatar, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return Boolean(getConversationRecord(avatar, { groupId, personaId }));
}

function getCharacterOfView(view) {
    if (view.kind === 'group') {
        return getConversationGroupAnchor({ id: view.id, members: view.characters, disabled_members: [] })?.character ?? null;
    }
    return Array.isArray(characters) ? characters.find(character => character?.avatar === view.characters[0]) ?? null : null;
}

/** The recent chats of Home, after the list of conversations has arrived, or after three seconds without it. */
export async function loadConversationWelcomeChats(options) {
    await Promise.race([conversationData.whenReady(), new Promise(resolve => setTimeout(resolve, 3000))]);
    return getConversationWelcomeChats(options);
}

export function getConversationWelcomeChats({ max = Infinity } = {}) {
    if (!Array.isArray(characters)) {
        return [];
    }

    const chats = [];
    for (const view of conversationData.list({ personaId: getConversationPersonaId() })) {
        const character = getCharacterOfView(view);
        const entry = view.chats.find(item => item.id === view.activeChatId);
        if (!character?.avatar || !entry) {
            continue;
        }

        const isGroup = view.kind === 'group';
        const timestamp = parsePositiveInt(entry.lastMessageAt || entry.createdAt || view.updatedAt, Date.now(), 1);
        const date = new Date(timestamp);
        const chatName = entry.name && entry.name !== 'Main' ? entry.name : 'Conversation Mode';
        const groupName = isGroup ? (view.name || 'Conversation Group') : '';
        chats.push({
            avatar: character.avatar,
            group: isGroup ? view.id : '',
            char_name: groupName || character.name || 'Character',
            char_thumbnail: getThumbnailUrl('avatar', character.avatar),
            chat_name: groupName ? `${character.name || 'Character'} · ${chatName}` : chatName,
            file_name: groupName ? `${groupName} · ${character.name || 'Character'}` : chatName,
            mes: entry.preview || 'Conversation ready',
            chat_items: entry.messageCount ?? 0,
            file_size: isGroup ? 'Group' : 'Conversation',
            date_short: date.toLocaleDateString(),
            date_long: date.toLocaleString(),
            last_mes: timestamp,
            is_group: isGroup,
            is_agent: false,
            is_conversation: true,
            recent_chat_type: 'conversation',
            conversation_id: view.id,
            conversation_chat_id: entry.id,
            conversation_chat_name: chatName,
            hidden: false,
            pinned: false,
        });
    }

    return chats
        .sort((first, second) => Number(second.last_mes || 0) - Number(first.last_mes || 0))
        .slice(0, Number.isFinite(max) ? max : undefined);
}

function chatPatch(avatar, { chatId = '', groupId, personaId }, state) {
    const address = getConversationAddress(avatar, { chatId, groupId, personaId });
    if (!address) {
        return false;
    }
    conversationData.patchConversation(address.conversationId, { chats: { [address.chatId]: state } });
    return true;
}

export function getLastUserActivity(avatar, fallback = Date.now(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return parsePositiveInt(getActiveConversationChat(avatar, { chatId, groupId, personaId })?.lastActivity, fallback, 1);
}

export function setLastUserActivity(avatar, timestamp = Date.now(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    chatPatch(avatar, { chatId, groupId, personaId }, { lastActivity: timestamp });
}

export function getFollowupCount(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return parsePositiveInt(getActiveConversationChat(avatar, { chatId, groupId, personaId })?.followupCount, 0, 0);
}

export function setFollowupCount(avatar, count, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    chatPatch(avatar, { chatId, groupId, personaId }, { followupCount: Math.max(0, count) });
}

export function resetFollowupCount(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return;
    }

    setFollowupCount(avatar, 0, { chatId, groupId, personaId });
}

export function getConversationSessionMarker(avatar, markerKey, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return String(getActiveConversationChat(avatar, { chatId, groupId, personaId })?.sessionMarkers?.[markerKey] ?? '');
}

export function setConversationSessionMarker(avatar, markerKey, value, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const chat = getActiveConversationChat(avatar, { chatId, groupId, personaId });
    if (!chat) {
        return;
    }
    chatPatch(avatar, { chatId, groupId, personaId }, { sessionMarkers: { ...chat.sessionMarkers, [markerKey]: String(value) } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Memory summaries: one per chat, in the header of the chat file.

export function getConversationMemorySummary(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    return String(getActiveConversationChat(avatar, { chatId, groupId, personaId })?.memorySummary ?? '').trim();
}

/** Each conversation of the persona with the memory summary of its active chat, when that chat is loaded. */
function getMemorySources(personaId) {
    return conversationData.list({ personaId }).map((view) => {
        const loaded = conversationData.chat({ conversationId: view.id, chatId: view.activeChatId });
        const memory = loaded?.header?.chat_metadata?.sb_conversation ?? {};
        return {
            groupId: view.kind === 'group' ? view.id : '',
            avatar: view.characters[0],
            members: view.characters,
            summary: String(memory.memory_summary ?? ''),
            updatedAt: Number(memory.memory_updated_at) || 0,
        };
    });
}

/**
 * Loads the active chat of each conversation that a related memory of this one can come from, so that the summaries
 * are there when the prompt is built. At most four chats are read.
 */
export async function loadRelatedMemoryChats(avatar, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const targets = conversationData.list({ personaId })
        .filter(view => (groupId ? view.kind === 'direct' && view.characters[0] === avatar : view.kind === 'group' && view.characters.includes(avatar) && view.id !== groupId))
        .slice(0, MAX_RELATED_MEMORY_CONVERSATIONS);
    await Promise.all(targets.map(view => conversationData.loadChat({ conversationId: view.id, chatId: view.activeChatId }).catch(() => null)));
}

export function getConversationGroupMemorySummaries(avatar = getCurrentCharAvatar(), { excludeGroupId = '', max = MAX_RELATED_MEMORY_CONVERSATIONS, personaId = getConversationPersonaId() } = {}) {
    return collectGroupConversationMemorySummaries(getMemorySources(personaId), avatar, {
        excludeGroupId,
        max,
        getGroupName: groupId => conversationData.get(groupId)?.name || '',
    });
}

export function getConversationSoloMemorySummary(avatar = getCurrentCharAvatar(), { personaId = getConversationPersonaId() } = {}) {
    return collectSoloConversationMemorySummary(getMemorySources(personaId), avatar);
}

export function saveConversationMemorySummary(avatar, summary, messageCount, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const address = getConversationAddress(avatar, { chatId, groupId, personaId });
    if (!address || !conversationData.chat(address)) {
        return;
    }

    conversationData.commitChat(address, (draft) => {
        draft.header.chat_metadata ??= {};
        draft.header.chat_metadata.sb_conversation = {
            ...draft.header.chat_metadata.sb_conversation,
            memory_summary: String(summary || '').trim(),
            memory_message_count: Math.max(0, messageCount || 0),
            memory_updated_at: Date.now(),
        };
    });
}

export function clearConversationMemorySummary(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const address = getConversationAddress(avatar, { chatId, groupId, personaId });
    if (!address || !conversationData.chat(address)) {
        return false;
    }

    const cleared = Date.now();
    conversationData.commitChat(address, (draft) => {
        draft.header.chat_metadata ??= {};
        draft.header.chat_metadata.sb_conversation = {
            ...draft.header.chat_metadata.sb_conversation,
            memory_summary: '',
            memory_message_count: 0,
            memory_updated_at: cleared,
        };
    });
    return true;
}

