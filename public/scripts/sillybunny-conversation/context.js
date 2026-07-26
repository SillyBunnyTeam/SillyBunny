import { characters, saveSettingsDebounced, this_chid } from '../../script.js';
import { extension_settings } from '../extensions.js';
import { editGroup, groups, selected_group } from '../group-chats.js';
import { user_avatar } from '../personas.js';
import {
    CONVERSATION_NOTIFICATION_PRIORITIES,
    CHARACTER_CONVERSATION_SETTINGS_KEYS,
    CONVERSATION_STORE_KEY,
    DEFAULT_AUTO_CHAT_COOLDOWN,
    DEFAULT_BRANCH_ID,
    DEFAULT_CONVERSATION_REPLY_MAX_TOKENS,
    DEFAULT_SETTINGS,
    FOLLOWUP_COUNT_PREFIX,
    GROUP_CONVERSATION_SETTINGS_KEYS,
    GROUP_CONVERSATION_STORE_PREFIX,
    LAST_AUTO_MESSAGE_PREFIX,
    LAST_PREVIEW_PREFIX,
    LAST_SCHEDULE_TRIGGER_PREFIX,
    LAST_USER_ACTIVITY_PREFIX,
    MAX_THREAD_MESSAGES,
    SCHEDULE_PREFIX,
    SETTINGS_KEY_PREFIX,
    THREAD_CONVERSATION_SETTINGS_KEYS,
    THREAD_KEY_PREFIX,
    UNREAD_PREFIX,
} from './constants.js';
import { getCharacterForAvatar } from './media.js';
import { getConversationReplyMaxTokens, getScheduleStorageKey } from './schedule.js';
import { conversationState } from './state.js';
import { safeParseThread } from './thread-store.js';
import { stripPreviewText } from './typing.js';

export const PERSONA_CONVERSATION_STORE_PREFIX = 'persona:';

export function getRoleplayCurrentCharacter() {
    if (typeof this_chid === 'undefined' || !Array.isArray(characters)) {
        return null;
    }

    return characters[this_chid] ?? null;
}

export function getRoleplayGroupById(groupId) {
    return Array.isArray(groups) ? groups.find(group => String(group?.id || '') === String(groupId || '')) || null : null;
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

function getExplicitConversationPersonaId(personaId) {
    return String(personaId || '').trim();
}

function encodeConversationStoragePart(value) {
    return encodeURIComponent(String(value || '').trim());
}

function decodeConversationStoragePart(value) {
    try {
        return decodeURIComponent(String(value || ''));
    } catch {
        return String(value || '');
    }
}

function scopeConversationStorageKey(storageKey, personaId = getConversationPersonaId()) {
    const key = String(storageKey || '').trim();
    const persona = getConversationPersonaId(personaId);
    if (!key || !persona || key.startsWith(PERSONA_CONVERSATION_STORE_PREFIX)) {
        return key;
    }

    return `${PERSONA_CONVERSATION_STORE_PREFIX}${encodeConversationStoragePart(persona)}:${key}`;
}

export function getRawConversationThreadKey(avatar, groupId = '', personaId = getConversationPersonaId()) {
    const safeAvatar = String(avatar || '').trim();
    const safeGroupId = String(groupId || '').trim();
    if (!safeAvatar) {
        return '';
    }

    const threadKey = safeGroupId ? `${GROUP_CONVERSATION_STORE_PREFIX}${safeGroupId}:${safeAvatar}` : safeAvatar;
    return scopeConversationStorageKey(threadKey, personaId);
}

export function isConversationThreadKeyForPersona(key, personaId = getConversationPersonaId()) {
    const parsed = parseConversationThreadKey(key);
    return getConversationPersonaId(parsed.personaId) === getConversationPersonaId(personaId);
}

export function normalizeConversationGroupRecord(group) {
    const source = group && typeof group === 'object' ? group : {};
    const id = String(source.id || '').trim();
    const personaId = getExplicitConversationPersonaId(source.personaId || source.persona || source.personaAvatar || source.userAvatar);
    const members = Array.isArray(source.members)
        ? Array.from(new Set(source.members.map(avatar => String(avatar || '').trim()).filter(Boolean)))
        : [];
    if (!id || members.length < 2) {
        return null;
    }

    const disabledMembers = Array.isArray(source.disabled_members)
        ? source.disabled_members.map(avatar => String(avatar || '').trim()).filter(avatar => avatar && members.includes(avatar))
        : [];
    const now = Date.now();
    return {
        ...source,
        id,
        personaId,
        name: String(source.name || 'Conversation Group'),
        members,
        disabled_members: disabledMembers,
        conversation_settings: normalizeGroupConversationSettings(source.conversation_settings),
        is_conversation_group: true,
        createdAt: parsePositiveInt(source.createdAt, now, 0),
        updatedAt: parsePositiveInt(source.updatedAt, source.createdAt || now, 0),
    };
}

export function getConversationGroups({ personaId = getConversationPersonaId() } = {}) {
    const store = getConversationStore();
    const persona = getConversationPersonaId(personaId);
    store.groups = Array.isArray(store.groups)
        ? store.groups.map(normalizeConversationGroupRecord).filter(Boolean)
        : [];
    return store.groups.filter(group => getConversationPersonaId(group.personaId) === persona);
}

export function getConversationGroupById(groupId, { personaId = getConversationPersonaId() } = {}) {
    if (!groupId) {
        return null;
    }

    const conversationGroup = getConversationGroups({ personaId }).find(group => String(group?.id) === String(groupId));
    if (conversationGroup) {
        return conversationGroup;
    }

    if (!Array.isArray(groups)) {
        return null;
    }

    return groups.find(group => String(group?.id) === String(groupId)) || null;
}

function getConversationThreadAnchorRank(threadStore) {
    const branches = threadStore?.branches && typeof threadStore.branches === 'object' ? Object.values(threadStore.branches) : [];
    const messageCount = branches.reduce((total, branch) => total + (Array.isArray(branch?.messages) ? branch.messages.length : 0), 0);
    const unread = branches.reduce((total, branch) => total + parsePositiveInt(branch?.unread, 0, 0), 0);
    const hasHistory = messageCount > 0 || unread > 0 || branches.some(branch => branch?.preview && branch.preview !== 'Conversation ready');
    const updatedAt = branches.reduce((latest, branch) => Math.max(latest, Number(branch?.updatedAt || branch?.createdAt || 0)), 0);
    return { hasHistory, messageCount, unread, updatedAt };
}

function compareConversationThreadAnchors(left, right) {
    return Number(right.rank.hasHistory) - Number(left.rank.hasHistory)
        || right.rank.messageCount - left.rank.messageCount
        || right.rank.unread - left.rank.unread
        || right.rank.updatedAt - left.rank.updatedAt
        || left.memberIndex - right.memberIndex
        || left.storeKey.localeCompare(right.storeKey);
}

function mergeConversationThreadAliasStore(target, source) {
    const targetBranches = target?.branches && typeof target.branches === 'object' ? target.branches : {};
    const sourceBranches = source?.branches && typeof source.branches === 'object' ? source.branches : {};
    const targetState = new Map(Object.entries(targetBranches).map(([branchId, branch]) => [branchId, {
        memoryUpdatedAt: Number(branch?.memoryUpdatedAt || branch?.updatedAt || 0),
        unread: parsePositiveInt(branch?.unread, 0, 0),
        updatedAt: Number(branch?.updatedAt || 0),
    }]));
    const sourceState = new Map(Object.entries(sourceBranches).map(([branchId, branch]) => [branchId, {
        memoryUpdatedAt: Number(branch?.memoryUpdatedAt || branch?.updatedAt || 0),
        unread: parsePositiveInt(branch?.unread, 0, 0),
        updatedAt: Number(branch?.updatedAt || 0),
    }]));
    const targetMemoryUpdatedAt = Number(target?.memoryUpdatedAt || 0);
    const sourceMemoryUpdatedAt = Number(source?.memoryUpdatedAt || 0);

    mergeLegacyConversationThreadStore(target, source);
    target.branches = target.branches && typeof target.branches === 'object' ? target.branches : {};
    for (const [branchId, sourceBranch] of Object.entries(sourceBranches)) {
        const targetBranch = target.branches[branchId];
        if (!targetBranch) {
            continue;
        }

        const previous = targetState.get(branchId);
        const incoming = sourceState.get(branchId);
        targetBranch.unread = (previous?.unread || 0) + (incoming?.unread || 0);
        targetBranch.lastActivity = Math.max(Number(targetBranch.lastActivity || 0), Number(sourceBranch?.lastActivity || 0));
        targetBranch.lastAutoMessageAt = Math.max(Number(targetBranch.lastAutoMessageAt || 0), Number(sourceBranch?.lastAutoMessageAt || 0));
        targetBranch.scheduleTriggers = { ...(sourceBranch?.scheduleTriggers || {}), ...(targetBranch.scheduleTriggers || {}) };
        targetBranch.sessionMarkers = { ...(sourceBranch?.sessionMarkers || {}), ...(targetBranch.sessionMarkers || {}) };
        if (incoming?.updatedAt > (previous?.updatedAt || 0)) {
            targetBranch.preview = sourceBranch.preview || targetBranch.preview;
            targetBranch.updatedAt = sourceBranch.updatedAt;
        }
        if (sourceBranch?.memorySummary && incoming?.memoryUpdatedAt > (previous?.memoryUpdatedAt || 0)) {
            targetBranch.memorySummary = sourceBranch.memorySummary;
            targetBranch.memoryMessageCount = sourceBranch.memoryMessageCount;
            targetBranch.memoryUpdatedAt = sourceBranch.memoryUpdatedAt;
        }
    }

    if (source?.memorySummary && sourceMemoryUpdatedAt > targetMemoryUpdatedAt) {
        target.memorySummary = source.memorySummary;
        target.memoryMessageCount = source.memoryMessageCount;
        target.memoryUpdatedAt = source.memoryUpdatedAt;
    }
    if (!target.branches[target.activeBranchId]) {
        target.activeBranchId = source?.activeBranchId && target.branches[source.activeBranchId]
            ? source.activeBranchId
            : Object.keys(target.branches)[0] || DEFAULT_BRANCH_ID;
    }
}

export function getConversationGroupThreadAnchor(group, { personaId = getConversationPersonaId() } = {}) {
    const groupId = String(group?.id || '').trim();
    const eligibleAvatars = (Array.isArray(group?.members) ? group.members : [])
        .filter(avatar => avatar && !group.disabled_members?.includes(avatar) && getCharacterForAvatar(avatar));
    if (!groupId || !eligibleAvatars.length) {
        return null;
    }

    const eligibleSet = new Set(eligibleAvatars);
    const memberIndexes = new Map(eligibleAvatars.map((avatar, index) => [avatar, index]));
    const store = getConversationStore();
    const aliases = Object.entries(store.characters || {})
        .filter(([storeKey]) => isConversationThreadKeyForPersona(storeKey, personaId))
        .map(([storeKey, threadStore]) => ({ storeKey, threadStore, parsed: parseConversationThreadKey(storeKey) }))
        .filter(item => item.parsed.groupId === groupId)
        .map(item => ({
            ...item,
            memberIndex: memberIndexes.get(item.parsed.avatar) ?? Number.MAX_SAFE_INTEGER,
            rank: getConversationThreadAnchorRank(item.threadStore),
        }))
        .sort(compareConversationThreadAnchors);
    const persisted = aliases.filter(item => eligibleSet.has(item.parsed.avatar))[0];
    const avatar = persisted?.parsed.avatar || eligibleAvatars[0];
    const character = getCharacterForAvatar(avatar);
    if (!character) {
        return null;
    }

    if (!aliases.length) {
        return {
            avatar,
            character,
            key: getConversationThreadKey(avatar, groupId, { personaId }),
            threadStore: null,
        };
    }

    const targetKey = getConversationThreadKey(avatar, groupId, { personaId });
    const seed = persisted || aliases[0];
    const targetStore = seed.threadStore;
    let changed = false;
    if (seed.storeKey !== targetKey) {
        store.characters[targetKey] = targetStore;
        delete store.characters[seed.storeKey];
        changed = true;
    }
    for (const alias of aliases) {
        if (alias.threadStore === targetStore) {
            continue;
        }
        mergeConversationThreadAliasStore(targetStore, alias.threadStore);
        delete store.characters[alias.storeKey];
        changed = true;
    }
    targetStore.threadAvatar = avatar;
    targetStore.groupId = groupId;
    if (changed) {
        persistConversationStore();
    }

    return {
        avatar,
        character,
        key: targetKey,
        threadStore: targetStore,
    };
}

export function isConversationOwnedGroup(groupId, { personaId = getConversationPersonaId() } = {}) {
    return Boolean(groupId && getConversationGroups({ personaId }).some(group => String(group?.id) === String(groupId)));
}

export function createConversationGroupRecord(memberAvatars, { name = '', avatarUrl = '', settings = null, personaId = getConversationPersonaId() } = {}) {
    const members = Array.from(new Set(
        (Array.isArray(memberAvatars) ? memberAvatars : [])
            .map(avatar => String(avatar || '').trim())
            .filter(Boolean),
    ));
    if (members.length < 2) {
        return null;
    }

    const now = Date.now();
    const group = normalizeConversationGroupRecord({
        id: `conversation_${now}_${Math.random().toString(36).slice(2)}`,
        personaId: getConversationPersonaId(personaId),
        name: name || 'Conversation Group',
        members,
        avatar_url: avatarUrl || '',
        disabled_members: [],
        conversation_settings: settings || getDefaultGroupConversationSettings(),
        createdAt: now,
        updatedAt: now,
    });
    if (!group) {
        return null;
    }

    const store = getConversationStore();
    store.groups = Array.isArray(store.groups) ? store.groups : [];
    store.groups.push(group);
    persistConversationStore();
    return group;
}

export function isAvatarInConversationGroup(avatar, groupId, { personaId = getConversationPersonaId() } = {}) {
    const group = getConversationGroupById(groupId, { personaId });
    return Boolean(avatar && group?.members?.includes(avatar) && !group.disabled_members?.includes(avatar));
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

export function getConversationThreadKey(avatar, groupId = getConversationGroupIdForAvatar(avatar), { personaId = getConversationPersonaId() } = {}) {
    if (!avatar) {
        return '';
    }

    const safeGroupId = groupId && isAvatarInConversationGroup(avatar, groupId, { personaId }) ? String(groupId) : '';
    return getRawConversationThreadKey(avatar, safeGroupId, personaId);
}

export function parseConversationThreadKey(key) {
    let value = String(key || '');
    let personaId = '';
    if (value.startsWith(PERSONA_CONVERSATION_STORE_PREFIX)) {
        const withoutPrefix = value.slice(PERSONA_CONVERSATION_STORE_PREFIX.length);
        const separatorIndex = withoutPrefix.indexOf(':');
        if (separatorIndex < 0) {
            return { avatar: '', groupId: '', personaId: '' };
        }

        personaId = decodeConversationStoragePart(withoutPrefix.slice(0, separatorIndex));
        value = withoutPrefix.slice(separatorIndex + 1);
    }

    if (!value.startsWith(GROUP_CONVERSATION_STORE_PREFIX)) {
        return { avatar: value, groupId: '', personaId };
    }

    const withoutPrefix = value.slice(GROUP_CONVERSATION_STORE_PREFIX.length);
    const separatorIndex = withoutPrefix.indexOf(':');
    if (separatorIndex < 0) {
        return { avatar: '', groupId: '', personaId };
    }

    return {
        groupId: withoutPrefix.slice(0, separatorIndex),
        avatar: withoutPrefix.slice(separatorIndex + 1),
        personaId,
    };
}

export function getCharacterStorageKey(prefix, avatar) {
    return `${prefix}${avatar}`;
}

export function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function getIdleActionFromSettings(settings) {
    const hasFollowup = Boolean(settings?.idle_followup);
    const hasSpontaneous = Boolean(settings?.idle_spontaneous);
    if (hasFollowup && hasSpontaneous) {
        return 'both';
    }
    if (hasFollowup) {
        return 'followup';
    }
    if (hasSpontaneous) {
        return 'spontaneous';
    }
    return 'disabled';
}

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

export function shouldSurfaceConversationNotification(settings) {
    if (settings?.notifications_muted || settings?.notification_priority === 'silent') {
        return false;
    }

    if (settings?.notification_priority === 'priority') {
        return true;
    }

    return !isConversationQuietHoursActive(settings);
}

export function safeParseSettings(stored) {
    if (!stored) {
        return { ...DEFAULT_SETTINGS };
    }

    try {
        const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
        const parsedSettings = parsed && typeof parsed === 'object' ? parsed : {};
        const settings = { ...DEFAULT_SETTINGS, ...parsedSettings };
        const hasIdleFollowup = Object.prototype.hasOwnProperty.call(parsedSettings, 'idle_followup');
        const hasIdleSpontaneous = Object.prototype.hasOwnProperty.call(parsedSettings, 'idle_spontaneous');
        if (!hasIdleFollowup && !hasIdleSpontaneous) {
            settings.idle_followup = settings.idle_action === 'followup' || settings.idle_action === 'both';
            settings.idle_spontaneous = settings.idle_action === 'spontaneous' || settings.idle_action === 'both';
        }
        settings.idle_action = getIdleActionFromSettings(settings);
        if (!settings.multi_char_names && settings.auto_chat_names) {
            settings.multi_char_names = settings.auto_chat_names;
        }
        settings.auto_chat_names = settings.multi_char_names;
        settings.auto_chat_cooldown = parsePositiveInt(settings.auto_chat_cooldown, DEFAULT_AUTO_CHAT_COOLDOWN, 1);
        settings.reply_max_tokens = getConversationReplyMaxTokens(settings);
        settings.grounded_dialogue_rules_enabled = Boolean(settings.grounded_dialogue_rules_enabled);
        settings.grounded_dialogue_rules = typeof settings.grounded_dialogue_rules === 'string'
            ? settings.grounded_dialogue_rules
            : DEFAULT_SETTINGS.grounded_dialogue_rules;
        settings.notification_priority = CONVERSATION_NOTIFICATION_PRIORITIES.includes(settings.notification_priority)
            ? settings.notification_priority
            : DEFAULT_SETTINGS.notification_priority;
        settings.quiet_hours_start = normalizeConversationQuietHour(settings.quiet_hours_start);
        settings.quiet_hours_end = normalizeConversationQuietHour(settings.quiet_hours_end);
        if (settings.reply_max_tokens === 1024) {
            settings.reply_max_tokens = DEFAULT_CONVERSATION_REPLY_MAX_TOKENS;
        }
        return settings;
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function pickConversationSettings(settings, keys) {
    const source = settings && typeof settings === 'object' ? settings : {};
    return [...keys].reduce((picked, key) => {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            picked[key] = source[key];
        }
        return picked;
    }, {});
}

export function normalizeGroupConversationSettings(settings = {}) {
    let parsedSource = {};
    try {
        const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
        parsedSource = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        parsedSource = {};
    }
    const normalized = safeParseSettings(settings);
    if (!Object.prototype.hasOwnProperty.call(parsedSource, 'multi_char')) {
        normalized.multi_char = true;
    }
    if (!Object.prototype.hasOwnProperty.call(parsedSource, 'auto_character_chat')) {
        normalized.auto_character_chat = true;
    }
    return pickConversationSettings(normalized, GROUP_CONVERSATION_SETTINGS_KEYS);
}

export function getDefaultGroupConversationSettings() {
    return normalizeGroupConversationSettings({
        ...DEFAULT_SETTINGS,
        multi_char: true,
        auto_character_chat: true,
    });
}

export function getGroupConversationSettings(groupId, { personaId = getConversationPersonaId() } = {}) {
    const group = getConversationGroupById(groupId, { personaId });
    return normalizeGroupConversationSettings(group?.conversation_settings);
}

export function saveGroupConversationSettings(groupId, settings, { personaId = getConversationPersonaId() } = {}) {
    const group = getConversationGroupById(groupId, { personaId });
    if (!group) {
        return;
    }

    group.conversation_settings = normalizeGroupConversationSettings(settings);
    group.updatedAt = Date.now();
    if (isConversationOwnedGroup(groupId, { personaId })) {
        persistConversationStore();
        return;
    }

    void editGroup(String(group.id), false, false);
}

function getLegacyConversationMessageFingerprint(message) {
    const normalizeValue = (value) => {
        if (Array.isArray(value)) {
            return value.map(normalizeValue);
        }
        if (value && typeof value === 'object') {
            return Object.keys(value).sort().reduce((result, key) => {
                result[key] = normalizeValue(value[key]);
                return result;
            }, {});
        }
        return value;
    };
    return JSON.stringify(normalizeValue(message));
}

function mergeLegacyConversationMessages(destinationMessages, sourceMessages) {
    const destination = Array.isArray(destinationMessages) ? destinationMessages : [];
    const source = Array.isArray(sourceMessages) ? sourceMessages : [];
    const byId = new Map(destination.map(message => [String(message?.id || ''), message]));
    const fingerprintCounts = destination.reduce((counts, message) => {
        if (!message?.id) {
            const fingerprint = getLegacyConversationMessageFingerprint(message);
            counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
        }
        return counts;
    }, new Map());
    const sourceFingerprintCounts = new Map();
    let complete = true;
    let changed = false;

    for (const message of source) {
        const messageId = String(message?.id || '');
        if (!messageId) {
            const fingerprint = getLegacyConversationMessageFingerprint(message);
            const occurrence = (sourceFingerprintCounts.get(fingerprint) || 0) + 1;
            sourceFingerprintCounts.set(fingerprint, occurrence);
            if ((fingerprintCounts.get(fingerprint) || 0) >= occurrence) {
                continue;
            }

            destination.push(message);
            fingerprintCounts.set(fingerprint, occurrence);
            changed = true;
            continue;
        }

        const existing = messageId ? byId.get(messageId) : null;
        if (!existing) {
            destination.push(message);
            if (messageId) {
                byId.set(messageId, message);
            }
            changed = true;
            continue;
        }

        if (JSON.stringify(existing) !== JSON.stringify(message)) {
            complete = false;
        }
    }

    destination.sort((left, right) => Number(left?.created_at || 0) - Number(right?.created_at || 0));
    return { messages: destination, complete, changed };
}

function mergeLegacyConversationThreadStore(destination, source) {
    if (!destination || typeof destination !== 'object' || !source || typeof source !== 'object') {
        return { complete: false, changed: false };
    }

    let changed = false;
    let complete = true;
    for (const [key, value] of Object.entries(source)) {
        if (key === 'branches' || key === 'settings') {
            continue;
        }
        if (typeof destination[key] === 'undefined' || destination[key] === null || destination[key] === '') {
            destination[key] = value;
            changed = true;
        } else if (JSON.stringify(destination[key]) !== JSON.stringify(value)) {
            complete = false;
        }
    }

    const sourceSettings = source.settings && typeof source.settings === 'object' ? source.settings : {};
    const destinationSettings = destination.settings && typeof destination.settings === 'object' ? destination.settings : {};
    const mergedSettings = { ...sourceSettings, ...destinationSettings };
    for (const [key, value] of Object.entries(sourceSettings)) {
        if (Object.prototype.hasOwnProperty.call(destinationSettings, key) && JSON.stringify(destinationSettings[key]) !== JSON.stringify(value)) {
            complete = false;
        }
    }
    if (JSON.stringify(mergedSettings) !== JSON.stringify(destinationSettings)) {
        destination.settings = mergedSettings;
        changed = true;
    }

    const sourceBranches = source.branches && typeof source.branches === 'object' ? source.branches : {};
    destination.branches = destination.branches && typeof destination.branches === 'object' ? destination.branches : {};
    for (const [branchId, sourceBranch] of Object.entries(sourceBranches)) {
        const destinationBranch = destination.branches[branchId];
        if (!destinationBranch) {
            destination.branches[branchId] = sourceBranch;
            changed = true;
            continue;
        }

        for (const [key, value] of Object.entries(sourceBranch || {})) {
            if (key !== 'messages' && (typeof destinationBranch[key] === 'undefined' || destinationBranch[key] === null || destinationBranch[key] === '')) {
                destinationBranch[key] = value;
                changed = true;
            } else if (key !== 'messages' && JSON.stringify(destinationBranch[key]) !== JSON.stringify(value)) {
                complete = false;
            }
        }
        const mergedMessages = mergeLegacyConversationMessages(destinationBranch.messages, sourceBranch?.messages);
        destinationBranch.messages = mergedMessages.messages;
        complete = complete && mergedMessages.complete;
        changed = changed || mergedMessages.changed;
    }

    return { complete, changed };
}

export function migrateLegacyConversationStoreToPersona(store, personaId = getConversationPersonaId()) {
    const persona = getConversationPersonaId(personaId);
    if (!persona || !store || typeof store !== 'object') {
        return false;
    }

    let changed = false;
    const charactersStore = store.characters && typeof store.characters === 'object' ? store.characters : {};
    const legacyAssignments = store.legacyThreadPersonaAssignments && typeof store.legacyThreadPersonaAssignments === 'object'
        ? store.legacyThreadPersonaAssignments
        : {};
    store.legacyThreadPersonaAssignments = legacyAssignments;
    for (const [storeKey, threadStore] of Object.entries(charactersStore)) {
        const parsed = parseConversationThreadKey(storeKey);
        if (parsed.personaId || !parsed.avatar || (legacyAssignments[storeKey] && legacyAssignments[storeKey] !== persona)) {
            continue;
        }

        const scopedKey = scopeConversationStorageKey(storeKey, persona);
        if (!charactersStore[scopedKey]) {
            charactersStore[scopedKey] = threadStore;
            delete charactersStore[storeKey];
            delete legacyAssignments[storeKey];
            changed = true;
            continue;
        }

        const merged = mergeLegacyConversationThreadStore(charactersStore[scopedKey], threadStore);
        changed = changed || merged.changed;
        if (merged.complete) {
            delete charactersStore[storeKey];
            delete legacyAssignments[storeKey];
            changed = true;
        } else if (legacyAssignments[storeKey] !== persona) {
            legacyAssignments[storeKey] = persona;
            changed = true;
        }
    }

    store.groups = Array.isArray(store.groups) ? store.groups.map(normalizeConversationGroupRecord).filter(Boolean) : [];
    for (const group of store.groups) {
        if (!getExplicitConversationPersonaId(group.personaId)) {
            group.personaId = persona;
            group.updatedAt = Date.now();
            changed = true;
        }
    }

    store.reminders = Array.isArray(store.reminders) ? store.reminders : [];
    for (const reminder of store.reminders) {
        if (reminder && typeof reminder === 'object' && !getExplicitConversationPersonaId(reminder.personaId)) {
            reminder.personaId = persona;
            changed = true;
        }
    }

    return changed;
}

export function getConversationStore() {
    const store = extension_settings[CONVERSATION_STORE_KEY];
    if (!store || typeof store !== 'object') {
        extension_settings[CONVERSATION_STORE_KEY] = {
            version: 1,
            localStorageMigrated: false,
            settings: {},
            characters: {},
            groups: [],
            legacyThreadPersonaAssignments: {},
            reminders: [],
        };
    }

    const current = extension_settings[CONVERSATION_STORE_KEY];
    current.version = current.version || 1;
    current.settings = current.settings && typeof current.settings === 'object' ? current.settings : {};
    current.characters = current.characters && typeof current.characters === 'object' ? current.characters : {};
    current.groups = Array.isArray(current.groups) ? current.groups.map(normalizeConversationGroupRecord).filter(Boolean) : [];
    current.legacyThreadPersonaAssignments = current.legacyThreadPersonaAssignments && typeof current.legacyThreadPersonaAssignments === 'object'
        ? current.legacyThreadPersonaAssignments
        : {};
    current.reminders = Array.isArray(current.reminders) ? current.reminders : [];
    if (migrateLegacyConversationStoreToPersona(current)) {
        persistConversationStore();
    }
    return current;
}

export function persistConversationStore() {
    saveSettingsDebounced();
}

export function createConversationBranch(name = 'Main', id = `br_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
    return {
        id,
        name,
        messages: [],
        preview: 'Conversation ready',
        unread: 0,
        lastActivity: Date.now(),
        followupCount: 0,
        lastAutoMessageAt: 0,
        scheduleTriggers: {},
        sessionMarkers: {},
        memorySummary: '',
        memoryMessageCount: 0,
        memoryUpdatedAt: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

export function normalizeConversationBranch(branch, id = DEFAULT_BRANCH_ID) {
    const target = branch && typeof branch === 'object'
        ? branch
        : createConversationBranch(id === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation', id);
    const now = Date.now();

    target.id = target.id || id;
    target.name = target.name || (id === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation');
    target.messages = Array.isArray(target.messages) ? target.messages : [];
    target.preview = typeof target.preview === 'string' ? target.preview : 'Conversation ready';
    target.unread = parsePositiveInt(target.unread, 0, 0);
    target.lastActivity = parsePositiveInt(target.lastActivity, now, 0);
    target.followupCount = parsePositiveInt(target.followupCount, 0, 0);
    target.lastAutoMessageAt = parsePositiveInt(target.lastAutoMessageAt, 0, 0);
    target.scheduleTriggers = target.scheduleTriggers && typeof target.scheduleTriggers === 'object' ? target.scheduleTriggers : {};
    target.sessionMarkers = target.sessionMarkers && typeof target.sessionMarkers === 'object' ? target.sessionMarkers : {};
    target.memorySummary = typeof target.memorySummary === 'string' ? target.memorySummary : '';
    target.memoryMessageCount = parsePositiveInt(target.memoryMessageCount, 0, 0);
    target.memoryUpdatedAt = parsePositiveInt(target.memoryUpdatedAt, 0, 0);
    target.createdAt = parsePositiveInt(target.createdAt, now, 0);
    target.updatedAt = parsePositiveInt(target.updatedAt, target.createdAt, 0);
    return target;
}

function migrateGlobalIdleActionSettings(store, settings) {
    const globalSettings = store.settings && typeof store.settings === 'object' ? store.settings : {};
    const alreadyGlobal = Object.prototype.hasOwnProperty.call(globalSettings, 'idle_followup')
        || Object.prototype.hasOwnProperty.call(globalSettings, 'idle_spontaneous')
        || Object.prototype.hasOwnProperty.call(globalSettings, 'idle_action');
    if (alreadyGlobal || (!settings.idle_followup && !settings.idle_spontaneous && settings.idle_action === DEFAULT_SETTINGS.idle_action)) {
        return false;
    }

    store.settings = globalSettings;
    store.settings.idle_followup = Boolean(settings.idle_followup);
    store.settings.idle_spontaneous = Boolean(settings.idle_spontaneous);
    store.settings.idle_action = getIdleActionFromSettings(settings);
    return true;
}

export function getCharacterConversationStore(avatar, { create = true, personaId = getConversationPersonaId() } = {}) {
    const storeKey = scopeConversationStorageKey(avatar, personaId);
    if (!storeKey) {
        return null;
    }

    const store = getConversationStore();
    if (!store.characters[storeKey] && !create) {
        return null;
    }
    if (!store.characters[storeKey]) {
        store.characters[storeKey] = {
            settings: { ...DEFAULT_SETTINGS },
            schedule: null,
            activeBranchId: DEFAULT_BRANCH_ID,
            branches: {
                [DEFAULT_BRANCH_ID]: createConversationBranch('Main', DEFAULT_BRANCH_ID),
            },
        };
    }

    const characterStore = store.characters[storeKey];
    const normalizedSettings = safeParseSettings(characterStore.settings);
    const migratedGlobalIdle = migrateGlobalIdleActionSettings(store, normalizedSettings);
    characterStore.settings = pickConversationSettings(
        normalizedSettings,
        parseConversationThreadKey(storeKey).groupId ? CHARACTER_CONVERSATION_SETTINGS_KEYS : THREAD_CONVERSATION_SETTINGS_KEYS,
    );
    characterStore.branches = characterStore.branches && typeof characterStore.branches === 'object' ? characterStore.branches : {};
    characterStore.activeBranchId = characterStore.activeBranchId || DEFAULT_BRANCH_ID;
    if (!characterStore.branches[characterStore.activeBranchId]) {
        characterStore.branches[characterStore.activeBranchId] = createConversationBranch('Main', characterStore.activeBranchId);
    }
    characterStore.branches[characterStore.activeBranchId] = normalizeConversationBranch(characterStore.branches[characterStore.activeBranchId], characterStore.activeBranchId);
    const activeBranch = characterStore.branches[characterStore.activeBranchId];
    characterStore.memorySummary = typeof characterStore.memorySummary === 'string' ? characterStore.memorySummary : '';
    if (!characterStore.memorySummary && activeBranch.memorySummary) {
        characterStore.memorySummary = activeBranch.memorySummary;
        characterStore.memoryMessageCount = activeBranch.memoryMessageCount;
        characterStore.memoryUpdatedAt = activeBranch.memoryUpdatedAt || activeBranch.updatedAt || Date.now();
    }
    characterStore.memoryMessageCount = parsePositiveInt(characterStore.memoryMessageCount, 0, 0);
    characterStore.memoryUpdatedAt = parsePositiveInt(characterStore.memoryUpdatedAt, 0, 0);
    if (migratedGlobalIdle) {
        persistConversationStore();
    }
    return characterStore;
}

export function getConversationThreadStore(avatar, { create = true, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const threadKey = getConversationThreadKey(avatar, groupId, { personaId });
    if (!threadKey) {
        return null;
    }

    const threadStore = getCharacterConversationStore(threadKey, { create, personaId });
    if (!threadStore) {
        return null;
    }

    threadStore.threadAvatar = avatar;
    threadStore.groupId = groupId || '';
    return threadStore;
}

export function getActiveConversationBranch(avatar, { branchId = '', create = true, groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const characterStore = getConversationThreadStore(avatar, { create, groupId, personaId });
    if (!characterStore) {
        return null;
    }

    const id = branchId || characterStore.activeBranchId || DEFAULT_BRANCH_ID;
    if (!characterStore.branches[id] && !create) {
        return null;
    }
    characterStore.branches[id] = normalizeConversationBranch(characterStore.branches[id], id);
    return characterStore.branches[id];
}

export function getConversationBranches(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { create: false, groupId });
    if (!characterStore) {
        return [];
    }

    return Object.entries(characterStore.branches).map(([id, branch]) => {
        const normalized = normalizeConversationBranch(branch, branch?.id || id);
        characterStore.branches[id] = normalized;
        return normalized;
    });
}

export function setActiveConversationBranch(avatar, branchId, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { groupId });
    if (!characterStore?.branches?.[branchId]) {
        return;
    }

    characterStore.activeBranchId = branchId;
    persistConversationStore();
}

export function createConversationBranchForAvatar(avatar, name = 'New chat', { groupId = getConversationGroupIdForAvatar(avatar), copyMemory = null } = {}) {
    const characterStore = getConversationThreadStore(avatar, { groupId });
    if (!characterStore) {
        return null;
    }

    const sourceBranch = normalizeConversationBranch(
        characterStore.branches?.[characterStore.activeBranchId || DEFAULT_BRANCH_ID],
        characterStore.activeBranchId || DEFAULT_BRANCH_ID,
    );
    const branch = createConversationBranch(name || 'New chat');
    const memorySummary = String(characterStore.memorySummary || sourceBranch.memorySummary || '').trim();
    const shouldCopyMemory = copyMemory ?? true;
    if (shouldCopyMemory && memorySummary) {
        branch.memorySummary = memorySummary;
        branch.memoryMessageCount = 0;
        branch.sessionMarkers.memory_copied_from = sourceBranch.id;
    }
    characterStore.branches[branch.id] = branch;
    characterStore.activeBranchId = branch.id;
    const group = groupId ? getConversationGroupById(groupId) : null;
    if (group?.is_conversation_group) {
        group.updatedAt = Date.now();
    }
    persistConversationStore();
    return branch;
}

export function renameConversationBranch(avatar, branchId, name, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { create: false, groupId });
    const branch = characterStore?.branches?.[branchId];
    if (!branch || !String(name || '').trim()) {
        return;
    }

    branch.name = String(name).trim();
    branch.updatedAt = Date.now();
    persistConversationStore();
}

function createConversationResetBranch(characterStore, name, branchId) {
    const branch = createConversationBranch(name, branchId);
    const memorySummary = String(characterStore?.memorySummary || '').trim();
    if (memorySummary) {
        branch.memorySummary = memorySummary;
        branch.memoryMessageCount = 0;
        branch.memoryUpdatedAt = parsePositiveInt(characterStore?.memoryUpdatedAt, Date.now(), 0);
    }
    return branch;
}

export function deleteConversationBranch(avatar, branchId, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const characterStore = getConversationThreadStore(avatar, { create: false, groupId, personaId });
    if (!characterStore?.branches?.[branchId]) {
        return false;
    }

    const branchIds = Object.keys(characterStore.branches);
    if (branchIds.length <= 1) {
        characterStore.branches[branchId] = createConversationResetBranch(characterStore, 'Main', branchId);
        characterStore.activeBranchId = branchId;
    } else {
        delete characterStore.branches[branchId];
        if (characterStore.activeBranchId === branchId) {
            characterStore.activeBranchId = Object.keys(characterStore.branches)[0] || DEFAULT_BRANCH_ID;
        }
    }
    persistConversationStore();
    return true;
}

export function resetCharacterConversationBranches(avatar, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const characterStore = getConversationThreadStore(avatar, { groupId, personaId });
    if (!characterStore) {
        return;
    }

    characterStore.activeBranchId = DEFAULT_BRANCH_ID;
    characterStore.branches = {
        [DEFAULT_BRANCH_ID]: createConversationResetBranch(characterStore, 'Main', DEFAULT_BRANCH_ID),
    };
    persistConversationStore();
}

export function clearLegacyConversationUnreadStorage() {
    if (typeof localStorage === 'undefined') {
        return 0;
    }

    const unreadKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        if (key.startsWith(UNREAD_PREFIX)) {
            unreadKeys.push(key);
        }
    }
    unreadKeys.forEach(key => localStorage.removeItem(key));
    return unreadKeys.length;
}

export function migrateConversationLocalStorage() {
    const store = getConversationStore();
    if (typeof localStorage === 'undefined') {
        return;
    }
    if (store.localStorageMigrated) {
        clearLegacyConversationUnreadStorage();
        return;
    }

    const prefixes = [
        SETTINGS_KEY_PREFIX,
        THREAD_KEY_PREFIX,
        SCHEDULE_PREFIX,
        LAST_USER_ACTIVITY_PREFIX,
        FOLLOWUP_COUNT_PREFIX,
        UNREAD_PREFIX,
        LAST_PREVIEW_PREFIX,
        LAST_AUTO_MESSAGE_PREFIX,
        LAST_SCHEDULE_TRIGGER_PREFIX,
    ];
    const avatars = new Set();
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        const prefix = prefixes.find(value => key.startsWith(value));
        if (prefix) {
            avatars.add(key.slice(prefix.length));
        }
    }

    for (const avatar of avatars) {
        const characterStore = getCharacterConversationStore(avatar);
        const settingsRaw = localStorage.getItem(getCharacterStorageKey(SETTINGS_KEY_PREFIX, avatar));
        if (settingsRaw) {
            characterStore.settings = safeParseSettings(settingsRaw);
        }

        const branch = getActiveConversationBranch(avatar);
        const threadRaw = localStorage.getItem(getCharacterStorageKey(THREAD_KEY_PREFIX, avatar));
        if (threadRaw) {
            branch.messages = safeParseThread(threadRaw).slice(-MAX_THREAD_MESSAGES);
        }
        const preview = localStorage.getItem(getCharacterStorageKey(LAST_PREVIEW_PREFIX, avatar));
        if (preview) {
            branch.preview = preview;
        } else if (branch.messages.length) {
            branch.preview = stripPreviewText(branch.messages[branch.messages.length - 1].mes) || 'Conversation ready';
        }
        branch.unread = parsePositiveInt(localStorage.getItem(getCharacterStorageKey(UNREAD_PREFIX, avatar)), 0, 0);
        branch.lastActivity = parsePositiveInt(localStorage.getItem(getCharacterStorageKey(LAST_USER_ACTIVITY_PREFIX, avatar)), branch.lastActivity, 1);
        branch.followupCount = parsePositiveInt(localStorage.getItem(getCharacterStorageKey(FOLLOWUP_COUNT_PREFIX, avatar)), 0, 0);
        branch.lastAutoMessageAt = parsePositiveInt(localStorage.getItem(getCharacterStorageKey(LAST_AUTO_MESSAGE_PREFIX, avatar)), 0, 0);
        try {
            branch.scheduleTriggers = JSON.parse(localStorage.getItem(getCharacterStorageKey(LAST_SCHEDULE_TRIGGER_PREFIX, avatar))) || {};
        } catch {
            branch.scheduleTriggers = {};
        }

        const scheduleRaw = localStorage.getItem(getScheduleStorageKey(avatar));
        if (scheduleRaw) {
            try {
                const schedule = JSON.parse(scheduleRaw);
                characterStore.schedule = schedule && typeof schedule === 'object' ? schedule : null;
            } catch {
                characterStore.schedule = null;
            }
        }
    }

    store.localStorageMigrated = true;
    clearLegacyConversationUnreadStorage();
    persistConversationStore();
}
