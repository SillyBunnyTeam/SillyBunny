import { characters, saveSettingsDebounced, this_chid } from '../../script.js';
import { extension_settings } from '../extensions.js';
import { editGroup, groups, selected_group } from '../group-chats.js';
import {
    CONVERSATION_NOTIFICATION_PRIORITIES,
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
    THREAD_KEY_PREFIX,
    UNREAD_PREFIX,
} from './constants.js';
import { getCharacterForAvatar } from './media.js';
import { getConversationReplyMaxTokens, getScheduleStorageKey } from './schedule.js';
import { getSettings } from './settings-store.js';
import { conversationState } from './state.js';
import { safeParseThread } from './thread-store.js';
import { stripPreviewText } from './typing.js';

export function getRoleplayCurrentCharacter() {
    if (typeof this_chid === 'undefined' || !Array.isArray(characters)) {
        return null;
    }

    return characters[this_chid] ?? null;
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

export function getConversationGroupById(groupId) {
    if (!groupId || !Array.isArray(groups)) {
        return null;
    }

    return groups.find(group => String(group?.id) === String(groupId)) || null;
}

export function isAvatarInConversationGroup(avatar, groupId) {
    const group = getConversationGroupById(groupId);
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

export function getConversationThreadKey(avatar, groupId = getConversationGroupIdForAvatar(avatar)) {
    if (!avatar) {
        return '';
    }

    const safeGroupId = groupId && isAvatarInConversationGroup(avatar, groupId) ? String(groupId) : '';
    return safeGroupId ? `${GROUP_CONVERSATION_STORE_PREFIX}${safeGroupId}:${avatar}` : avatar;
}

export function parseConversationThreadKey(key) {
    const value = String(key || '');
    if (!value.startsWith(GROUP_CONVERSATION_STORE_PREFIX)) {
        return { avatar: value, groupId: '' };
    }

    const withoutPrefix = value.slice(GROUP_CONVERSATION_STORE_PREFIX.length);
    const separatorIndex = withoutPrefix.indexOf(':');
    if (separatorIndex < 0) {
        return { avatar: '', groupId: '' };
    }

    return {
        groupId: withoutPrefix.slice(0, separatorIndex),
        avatar: withoutPrefix.slice(separatorIndex + 1),
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
    return pickConversationSettings(safeParseSettings(settings), GROUP_CONVERSATION_SETTINGS_KEYS);
}

export function getDefaultGroupConversationSettings() {
    return normalizeGroupConversationSettings(DEFAULT_SETTINGS);
}

export function getGroupConversationSettings(groupId) {
    const group = getConversationGroupById(groupId);
    return normalizeGroupConversationSettings(group?.conversation_settings);
}

export function saveGroupConversationSettings(groupId, settings) {
    const group = getConversationGroupById(groupId);
    if (!group) {
        return;
    }

    group.conversation_settings = normalizeGroupConversationSettings(settings);
    void editGroup(String(group.id), false, false);
}

export function getConversationStore() {
    const store = extension_settings[CONVERSATION_STORE_KEY];
    if (!store || typeof store !== 'object') {
        extension_settings[CONVERSATION_STORE_KEY] = {
            version: 1,
            localStorageMigrated: false,
            characters: {},
            reminders: [],
        };
    }

    const current = extension_settings[CONVERSATION_STORE_KEY];
    current.version = current.version || 1;
    current.characters = current.characters && typeof current.characters === 'object' ? current.characters : {};
    current.reminders = Array.isArray(current.reminders) ? current.reminders : [];
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
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

export function normalizeConversationBranch(branch, id = DEFAULT_BRANCH_ID) {
    const normalized = branch && typeof branch === 'object' ? branch : {};
    return {
        ...createConversationBranch(id === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation', id),
        ...normalized,
        id: normalized.id || id,
        name: normalized.name || (id === DEFAULT_BRANCH_ID ? 'Main' : 'Conversation'),
        messages: Array.isArray(normalized.messages) ? normalized.messages : [],
        scheduleTriggers: normalized.scheduleTriggers && typeof normalized.scheduleTriggers === 'object' ? normalized.scheduleTriggers : {},
        sessionMarkers: normalized.sessionMarkers && typeof normalized.sessionMarkers === 'object' ? normalized.sessionMarkers : {},
        memorySummary: typeof normalized.memorySummary === 'string' ? normalized.memorySummary : '',
        memoryMessageCount: parsePositiveInt(normalized.memoryMessageCount, 0, 0),
    };
}

export function getCharacterConversationStore(avatar, { create = true } = {}) {
    if (!avatar) {
        return null;
    }

    const store = getConversationStore();
    if (!store.characters[avatar] && !create) {
        return null;
    }
    if (!store.characters[avatar]) {
        store.characters[avatar] = {
            settings: { ...DEFAULT_SETTINGS },
            schedule: null,
            activeBranchId: DEFAULT_BRANCH_ID,
            branches: {
                [DEFAULT_BRANCH_ID]: createConversationBranch('Main', DEFAULT_BRANCH_ID),
            },
        };
    }

    const characterStore = store.characters[avatar];
    characterStore.settings = safeParseSettings(characterStore.settings);
    characterStore.branches = characterStore.branches && typeof characterStore.branches === 'object' ? characterStore.branches : {};
    characterStore.activeBranchId = characterStore.activeBranchId || DEFAULT_BRANCH_ID;
    if (!characterStore.branches[characterStore.activeBranchId]) {
        characterStore.branches[characterStore.activeBranchId] = createConversationBranch('Main', characterStore.activeBranchId);
    }
    characterStore.branches[characterStore.activeBranchId] = normalizeConversationBranch(characterStore.branches[characterStore.activeBranchId], characterStore.activeBranchId);
    return characterStore;
}

export function getConversationThreadStore(avatar, { create = true, groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const threadKey = getConversationThreadKey(avatar, groupId);
    if (!threadKey) {
        return null;
    }

    const threadStore = getCharacterConversationStore(threadKey, { create });
    if (!threadStore) {
        return null;
    }

    threadStore.threadAvatar = avatar;
    threadStore.groupId = groupId || '';
    return threadStore;
}

export function getActiveConversationBranch(avatar, { create = true, groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { create, groupId });
    if (!characterStore) {
        return null;
    }

    const id = characterStore.activeBranchId || DEFAULT_BRANCH_ID;
    characterStore.branches[id] = normalizeConversationBranch(characterStore.branches[id], id);
    return characterStore.branches[id];
}

export function getConversationBranches(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { create: false, groupId });
    if (!characterStore) {
        return [];
    }

    return Object.values(characterStore.branches).map((branch) => normalizeConversationBranch(branch, branch.id));
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
    const shouldCopyMemory = copyMemory ?? Boolean(getSettings(avatar, { groupId }).copy_memory_to_new_branch);
    if (shouldCopyMemory && sourceBranch.memorySummary) {
        branch.memorySummary = sourceBranch.memorySummary;
        branch.memoryMessageCount = 0;
        branch.sessionMarkers.memory_copied_from = sourceBranch.id;
    }
    characterStore.branches[branch.id] = branch;
    characterStore.activeBranchId = branch.id;
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

export function deleteConversationBranch(avatar, branchId, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { create: false, groupId });
    if (!characterStore?.branches?.[branchId]) {
        return false;
    }

    const branchIds = Object.keys(characterStore.branches);
    if (branchIds.length <= 1) {
        characterStore.branches[branchId] = createConversationBranch('Main', branchId);
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

export function resetCharacterConversationBranches(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const characterStore = getConversationThreadStore(avatar, { groupId });
    if (!characterStore) {
        return;
    }

    characterStore.activeBranchId = DEFAULT_BRANCH_ID;
    characterStore.branches = {
        [DEFAULT_BRANCH_ID]: createConversationBranch('Main', DEFAULT_BRANCH_ID),
    };
    persistConversationStore();
}

export function migrateConversationLocalStorage() {
    const store = getConversationStore();
    if (store.localStorageMigrated || typeof localStorage === 'undefined') {
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
    persistConversationStore();
}
