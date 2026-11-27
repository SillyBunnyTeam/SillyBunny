import { characters, saveSettingsDebounced, this_chid } from '../../script.js';
import { extension_settings } from '../extensions.js';
import { groups, selected_group } from '../group-chats.js';
import { user_avatar } from '../personas.js';
import {
    CONVERSATION_STORE_KEY,
    DEFAULT_CHAT_ID,
    DEFAULT_SETTINGS,
    NEW_CONVERSATION_SETTINGS,
    UNREAD_PREFIX,
} from './constants.js';
import { conversationData } from './conversation-data-browser.js';
import { conversationState } from './state.js';

const GROUP_FALLBACK_NAME = 'Conversation Group';
const EMPTY_MESSAGES = Object.freeze([]);
const LEGACY_STORE_PARTS = Object.freeze(['characters', 'groups', 'reminders', 'legacyThreadPersonaAssignments']);
// The version of the mode's object in settings.json once the server has moved the conversations out of it.
const MODE_OBJECT_VERSION = 2;

export function getRoleplayCurrentCharacter() {
    if (typeof this_chid === 'undefined' || !Array.isArray(characters)) {
        return null;
    }

    return characters[this_chid] ?? null;
}

export function getRoleplayAvatarForWelcome() {
    return conversationState.conversationSelectedAvatar || getRoleplayCurrentCharacter()?.avatar || null;
}

export function getRoleplayGroupById(groupId) {
    return Array.isArray(groups) ? groups.find(group => String(group?.id || '') === String(groupId || '')) || null : null;
}

export function getCharacterForAvatar(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return getCurrentCharacter();
    }

    return (Array.isArray(characters) ? characters : []).find(character => character?.avatar === avatar) || null;
}

export function getCurrentCharacter() {
    if (conversationState.conversationWorkspaceOpen && conversationState.conversationSelectedAvatar) {
        const selected = getCharacterForAvatar(conversationState.conversationSelectedAvatar);
        if (selected) {
            return selected;
        }
    }

    return getRoleplayCurrentCharacter();
}

export function getCurrentCharAvatar() {
    return getCurrentCharacter()?.avatar ?? null;
}

export function getCurrentCharName(fallback = 'Character') {
    return getCurrentCharacter()?.name || fallback;
}

export function getConversationPersonaId(personaId = user_avatar) {
    return String(personaId || '').trim();
}

export function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

// ---------------------------------------------------------------------------------------------------------------------
// The conversations: the module `conversation-data.js` holds them; these functions answer in the terms that the rest of
// the mode uses (an avatar, a group id, a persona), by asking it which conversation that is.

/**
 * @param {string} avatar
 * @param {{ groupId?: string|null, personaId?: string, chatId?: string }} [options]
 * @returns {{ conversationId: string, chatId: string }|null}
 */
export function getConversationAddress(avatar, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId(), chatId = '' } = {}) {
    const address = conversationData.resolve({ avatar, groupId: groupId || '', personaId, chatId });
    // The data module answers the active chat for a chat id that the conversation does not have. A reply that was
    // started for a chat that has been deleted since would land in that other chat, so a named chat has to exist.
    return chatId && address?.chatId !== chatId ? null : address;
}

/** A group in the shape that the rest of the mode reads: its members, and a name that is never empty. */
function toGroupRecord(view) {
    return {
        id: view.id,
        personaId: view.personaId,
        name: view.name || GROUP_FALLBACK_NAME,
        description: view.description ?? '',
        members: [...view.characters],
        disabled_members: [],
        is_conversation_group: true,
        avatar_url: view.avatar ? `/api/sillybunny-conversation/avatar?id=${encodeURIComponent(view.id)}` : '',
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
    };
}

export function getConversationGroupById(groupId, { personaId = getConversationPersonaId() } = {}) {
    const view = groupId ? conversationData.get(String(groupId)) : null;
    if (!view || view.kind !== 'group' || (personaId !== null && view.personaId !== getConversationPersonaId(personaId))) {
        return null;
    }
    return toGroupRecord(view);
}

export function isAvatarInConversationGroup(avatar, groupId, { personaId = getConversationPersonaId() } = {}) {
    const group = getConversationGroupById(groupId, { personaId });
    return Boolean(avatar && group?.members.includes(avatar));
}

export function getConversationGroupIdForAvatar(avatar) {
    if (!avatar) {
        return null;
    }

    if (conversationState.conversationWorkspaceOpen) {
        return conversationState.conversationSelectedGroupId && isAvatarInConversationGroup(avatar, conversationState.conversationSelectedGroupId)
            ? conversationState.conversationSelectedGroupId
            : null;
    }

    return selected_group && isAvatarInConversationGroup(avatar, selected_group) ? String(selected_group) : null;
}

/**
 * The first member of a group that has a character card, which the rest of the mode uses as the group's own character.
 * @returns {{ avatar: string, character: object, key: string, conversationRecord: object|null }|null}
 */
export function getConversationGroupAnchor(group, { personaId = getConversationPersonaId() } = {}) {
    const groupId = String(group?.id || '').trim();
    const avatar = (Array.isArray(group?.members) ? group.members : []).find(item => item && !group.disabled_members?.includes(item) && getCharacterForAvatar(item));
    const character = avatar ? getCharacterForAvatar(avatar) : null;
    if (!groupId || !character) {
        return null;
    }
    return {
        avatar,
        character,
        key: getConversationKey(avatar, groupId, { personaId }),
        conversationRecord: conversationData.get(groupId),
    };
}

/**
 * A string that is equal for the same conversation and for no other, for comparisons and for keys of maps. It is the
 * id of the conversation; a conversation that is not there yet gets a key from the names that will make it.
 */
export function getConversationKey(avatar, groupId = getConversationGroupIdForAvatar(avatar), { personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return '';
    }
    const address = getConversationAddress(avatar, { groupId, personaId });
    return address?.conversationId ?? `pending:${personaId}:${groupId || ''}:${avatar}`;
}

/** The conversation as the cache holds it, or null. It is never created here; see `ensureDirectConversation`. */
export function getConversationRecord(avatar, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return null;
    }
    const address = getConversationAddress(avatar, { groupId, personaId });
    return address ? conversationData.get(address.conversationId) : null;
}

/**
 * The direct conversation of the persona with a character, made now when there is none.
 * @returns {Promise<object>} The conversation.
 */
export async function ensureDirectConversation(avatar, { personaId = getConversationPersonaId() } = {}) {
    const existing = conversationData.findDirect(personaId, avatar);
    if (existing) {
        return existing;
    }
    const { conversation } = await conversationData.createConversation({ kind: 'direct', personaId, characters: [avatar], settings: NEW_CONVERSATION_SETTINGS });
    return conversation;
}

/**
 * @param {string[]} memberAvatars At least two characters.
 * @returns {Promise<object>} The group conversation, in the shape of `getConversationGroupById`.
 */
export async function makeConversationGroup(memberAvatars, { name = '', personaId = getConversationPersonaId() } = {}) {
    const members = [...new Set((Array.isArray(memberAvatars) ? memberAvatars : []).map(avatar => String(avatar || '').trim()).filter(Boolean))];
    if (members.length < 2) {
        return null;
    }
    const { conversation } = await conversationData.createConversation({ kind: 'group', personaId, characters: members, settings: NEW_CONVERSATION_SETTINGS, ...(name ? { name } : {}) });
    return toGroupRecord(conversation);
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings values

export function normalizeConversationQuietHour(value) {
    const text = String(value || '').trim();
    const match = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (!match) {
        return '';
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        return '';
    }

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function getConversationMinuteOfDay(value) {
    const normalized = normalizeConversationQuietHour(value);
    if (!normalized) {
        return null;
    }

    const [hours, minutes] = normalized.split(':').map(Number);
    return hours * 60 + minutes;
}

export function isConversationQuietHoursActive(settings, date = new Date()) {
    const start = getConversationMinuteOfDay(settings?.quiet_hours_start);
    const end = getConversationMinuteOfDay(settings?.quiet_hours_end);
    if (start === null || end === null || start === end) {
        return false;
    }

    const now = date.getHours() * 60 + date.getMinutes();
    if (start < end) {
        return now >= start && now < end;
    }

    return now >= start || now < end;
}

/** A conversation that is muted, or a time inside the quiet hours of the mode, shows no sound and no popup; the unread badges stay. */
export function shouldSurfaceConversationNotification(settings, date = new Date()) {
    return !settings?.notifications_muted && !isConversationQuietHoursActive(settings, date);
}

export function safeParseSettings(stored) {
    if (!stored) {
        return { ...DEFAULT_SETTINGS };
    }

    try {
        const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
        const settings = { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
        settings.grounded_dialogue_rules_enabled = Boolean(settings.grounded_dialogue_rules_enabled);
        settings.grounded_dialogue_rules = typeof settings.grounded_dialogue_rules === 'string'
            ? settings.grounded_dialogue_rules
            : DEFAULT_SETTINGS.grounded_dialogue_rules;
        settings.quiet_hours_start = normalizeConversationQuietHour(settings.quiet_hours_start);
        settings.quiet_hours_end = normalizeConversationQuietHour(settings.quiet_hours_end);
        settings.simulate_reply_delay = settings.simulate_reply_delay !== false;
        return settings;
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The mode's own settings in settings.json: the mode-wide settings and the status of the user. Conversations are not here.

function hasLegacyStoreContent(store) {
    return LEGACY_STORE_PARTS.some((part) => {
        const value = store[part];
        return Array.isArray(value) ? value.length > 0 : Boolean(value) && typeof value === 'object' && Object.keys(value).length > 0;
    });
}

/**
 * The mode's object in `settings.json`. It holds `settings` (mode-wide), `userStatus`, `userPersonaStatus`,
 * `localStorageMigrated` and `version`. Old parts of it (`characters`, `groups`, `reminders`,
 * `legacyThreadPersonaAssignments`) are left as they were found and never written: while they have content the server
 * has not moved them yet, and the object keeps its version so that the server still sees it as old.
 */
export function getConversationStore() {
    let store = extension_settings[CONVERSATION_STORE_KEY];
    if (!store || typeof store !== 'object') {
        store = { version: MODE_OBJECT_VERSION, localStorageMigrated: false, settings: {} };
        extension_settings[CONVERSATION_STORE_KEY] = store;
    }
    if (!hasLegacyStoreContent(store) && !(Number(store.version) >= MODE_OBJECT_VERSION)) {
        store.version = MODE_OBJECT_VERSION;
    }
    store.settings = store.settings && typeof store.settings === 'object' ? store.settings : {};
    return store;
}

export function persistConversationStore() {
    saveSettingsDebounced();
}

const UNREAD_STORAGE_CLEANED_KEY = 'sillybunny_conv_unread_cleaned_v1';

/** Removes the unread counts that the first versions kept in `localStorage`. They are worked out from the chats now. */
export function clearLegacyConversationUnreadStorage() {
    if (typeof localStorage === 'undefined') {
        return 0;
    }

    try {
        if (typeof localStorage.getItem === 'function' && localStorage.getItem(UNREAD_STORAGE_CLEANED_KEY) === '1') {
            return 0;
        }
    } catch {
        // Ignore storage read failures in private/restricted contexts.
    }

    const unreadKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        if (key.startsWith(UNREAD_PREFIX)) {
            unreadKeys.push(key);
        }
    }
    unreadKeys.forEach(key => localStorage.removeItem(key));

    try {
        if (typeof localStorage.setItem === 'function') {
            localStorage.setItem(UNREAD_STORAGE_CLEANED_KEY, '1');
        }
    } catch {
        // Ignore storage write failures in private/quota-limited contexts.
    }

    return unreadKeys.length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Chats of a conversation

function toChatHandle(view, entry) {
    const loaded = conversationData.chat({ conversationId: view.id, chatId: entry.id });
    const memory = loaded?.header?.chat_metadata?.sb_conversation ?? {};
    return {
        id: entry.id,
        name: entry.name || (entry.id === DEFAULT_CHAT_ID ? 'Main' : 'Conversation'),
        messages: loaded?.messages ?? EMPTY_MESSAGES,
        loaded: Boolean(loaded),
        preview: entry.preview || 'Conversation ready',
        unread: entry.unread ?? 0,
        messageCount: entry.messageCount ?? 0,
        lastMessageRole: entry.lastMessageRole ?? '',
        hasUserMessage: entry.hasUserMessage === true,
        readThrough: entry.readThrough ?? '',
        lastActivity: entry.lastActivity ?? 0,
        followupCount: entry.followupCount ?? 0,
        lastAutoMessageAt: entry.lastAutoMessageAt ?? 0,
        sessionMarkers: entry.sessionMarkers ?? {},
        memorySummary: String(memory.memory_summary ?? ''),
        memoryMessageCount: Number(memory.memory_message_count) || 0,
        memoryUpdatedAt: Number(memory.memory_updated_at) || 0,
        createdAt: entry.createdAt ?? 0,
        updatedAt: entry.lastMessageAt || entry.createdAt || 0,
    };
}

/**
 * The chat of a conversation as one object to read: the list's summary of it, its state, and its messages when it is
 * loaded. It is made on each call, so changing it changes nothing; the setters of the mode write.
 * @returns {object|null}
 */
export function getActiveConversationChat(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const view = getConversationRecord(avatar, { groupId, personaId });
    if (!view) {
        return null;
    }
    const entry = view.chats.find(item => item.id === (chatId || view.activeChatId));
    return entry ? toChatHandle(view, entry) : null;
}

export function getConversationChats(avatar, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const view = getConversationRecord(avatar, { groupId, personaId });
    return view ? view.chats.map(entry => toChatHandle(view, entry)) : [];
}

export function setActiveConversationChat(avatar, chatId, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const view = getConversationRecord(avatar, { groupId, personaId });
    if (!view?.chats.some(entry => entry.id === chatId)) {
        return;
    }
    conversationData.patchConversation(view.id, { activeChatId: chatId });
}

/**
 * New Chat: adds an empty chat to the conversation, with no memory summary, and makes it the active one. The chat
 * exists in the cache at once and the server makes it before it takes the first save.
 * @returns {object|null} The new chat, or null when the conversation does not exist.
 */
export function createConversationChat(avatar, name = 'New chat', { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const view = getConversationRecord(avatar, { groupId, personaId });
    const created = view ? conversationData.createChat(view.id, { name: name || 'New chat', activate: true }) : null;
    return created ? getActiveConversationChat(avatar, { chatId: created.address.chatId, groupId, personaId }) : null;
}

export function renameConversationChat(avatar, chatId, name, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const view = getConversationRecord(avatar, { groupId, personaId });
    const trimmed = String(name || '').trim();
    if (!view?.chats.some(entry => entry.id === chatId) || !trimmed) {
        return false;
    }
    conversationData.patchConversation(view.id, { chats: { [chatId]: { name: trimmed } } });
    return true;
}

/**
 * @returns {Promise<boolean>} Whether the chat was removed. The last chat is replaced by an empty one.
 */
export async function deleteConversationChat(avatar, chatId, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const view = getConversationRecord(avatar, { groupId, personaId });
    if (!view?.chats.some(entry => entry.id === chatId)) {
        return false;
    }
    await conversationData.deleteChat({ conversationId: view.id, chatId });
    return true;
}

/** Home deletes a chat of a conversation: `reset` says that it was the only chat, which is replaced by an empty one. */
export async function deleteConversationWelcomeChat(avatar, chatId, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const view = getConversationRecord(avatar, { groupId, personaId });
    const reset = Boolean(view?.chats.some(entry => entry.id === chatId)) && view.chats.length <= 1;
    return { deleted: await deleteConversationChat(avatar, chatId, { groupId, personaId }), reset };
}

/**
 * Delete Conversation: removes the conversation with all its chats and reminders. The characters are untouched.
 * @returns {Promise<boolean>} False when there was no such conversation.
 */
export async function deleteConversationByAvatar(avatar, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const view = getConversationRecord(avatar, { groupId, personaId });
    if (!view) {
        return false;
    }
    await conversationData.deleteConversation(view.id);
    return true;
}
