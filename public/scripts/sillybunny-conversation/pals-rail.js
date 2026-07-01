import {
    characters,
    chat,
    default_user_avatar,
    getThumbnailUrl,
    name1,
} from '../../script.js';
import { selected_group } from '../group-chats.js';
import { user_avatar } from '../personas.js';
import { DEFAULT_BRANCH_ID, DEFAULT_SETTINGS, GROUP_ASIDE_CONTEXT_LIMIT } from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationGroups,
    getConversationStore,
    getConversationThreadKey,
    getCurrentCharAvatar,
    isConversationThreadKeyForPersona,
    normalizeConversationBranch,
    parseConversationThreadKey,
    parsePositiveInt,
} from './context.js';
import { getCharacterForAvatar, getCharacterIndexForAvatar, getConversationParticipants } from './media.js';
import { getActiveConversationThreadKey } from './notifications.js';
import { formatPromptText } from './prompt.js';
import { getSettings } from './settings-store.js';
import { conversationState } from './state.js';
import { getConversationSeenAt, getConversationThread } from './thread-store.js';
import { stripPreviewText } from './typing.js';

export function getConversationSettingsForCharacter(character, { groupId = getConversationGroupIdForAvatar(character?.avatar) } = {}) {
    return character?.avatar ? getSettings(character.avatar, { groupId }) : { ...DEFAULT_SETTINGS };
}

export function getConversationPals() {
    if (!Array.isArray(characters)) {
        return [];
    }

    return characters
        .map((character, index) => ({ character, index, settings: getConversationSettingsForCharacter(character, { groupId: '' }) }))
        .filter(item => item.character?.avatar && item.settings.enabled);
}

export function getConversationRailItems() {
    const items = [];
    const seen = new Set();
    const seenGroupIds = new Set();
    const activeKey = getActiveConversationThreadKey();
    const getGroupDisplayCharacter = group => (group?.members || [])
        .map(avatar => getCharacterForAvatar(avatar))
        .find(character => character?.avatar) || null;
    const addItem = ({ character, index, settings, groupId = '', group = null, threadStore = null }) => {
        const avatar = character?.avatar;
        if (!avatar || (!groupId && !settings?.enabled)) {
            return;
        }

        const key = getConversationThreadKey(avatar, groupId || '');
        if (!key || seen.has(key) || (groupId && seenGroupIds.has(String(groupId)))) {
            return;
        }

        if (groupId) {
            const branchId = threadStore?.activeBranchId || DEFAULT_BRANCH_ID;
            const branch = normalizeConversationBranch(threadStore?.branches?.[branchId], branchId);
            const isEmptyThread = !branch.messages.length && !branch.unread && branch.preview === 'Conversation ready';
            if (isEmptyThread && !group?.is_conversation_group) {
                return;
            }
        }

        seen.add(key);
        if (groupId) {
            seenGroupIds.add(String(groupId));
        }
        items.push({ character, index, settings, groupId: groupId || '', group, key });
    };

    getConversationPals().forEach(pal => addItem({ ...pal, groupId: '' }));

    getConversationGroups().forEach((group) => {
        const character = getGroupDisplayCharacter(group);
        if (!character?.avatar) {
            return;
        }

        const groupId = String(group.id || '');
        const settings = getConversationSettingsForCharacter(character, { groupId });
        addItem({
            character,
            index: getCharacterIndexForAvatar(character.avatar),
            settings,
            groupId,
            group,
            threadStore: getConversationStore().characters?.[getConversationThreadKey(character.avatar, groupId)] || null,
        });
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

        const settings = getConversationSettingsForCharacter(character, { groupId: parsed.groupId });

        addItem({
            character,
            index: getCharacterIndexForAvatar(parsed.avatar),
            settings,
            groupId: parsed.groupId,
            group,
            threadStore,
        });
    });

    return items.sort((first, second) => {
        if (first.key === activeKey) return -1;
        if (second.key === activeKey) return 1;
        const firstBranch = getActiveConversationBranch(first.character.avatar, { create: false, groupId: first.groupId });
        const secondBranch = getActiveConversationBranch(second.character.avatar, { create: false, groupId: second.groupId });
        return Number(secondBranch?.updatedAt || 0) - Number(firstBranch?.updatedAt || 0);
    });
}

export function getSelectedConversationGroup() {
    return getConversationGroupById(conversationState.conversationWorkspaceOpen ? conversationState.conversationSelectedGroupId : selected_group);
}

export function getCurrentGroupConversationMembers({ requireRoleplayReactions = false, groupId = null, requireEnabled = true } = {}) {
    const group = groupId ? getConversationGroupById(groupId) : getSelectedConversationGroup();
    if (!group || !Array.isArray(group.members)) {
        return [];
    }

    return group.members
        .filter(avatar => avatar && !group.disabled_members?.includes(avatar))
        .map((avatar) => {
            const character = getCharacterForAvatar(avatar);
            const index = getCharacterIndexForAvatar(avatar);
            const settings = getConversationSettingsForCharacter(character, { groupId: String(group.id || '') });
            return { character, index, settings };
        })
        .filter(item => item.character?.avatar && (!requireEnabled || item.settings.enabled))
        .filter(item => !requireRoleplayReactions || item.settings.roleplay_reactions);
}

export function getScheduleEditorTargets(baseAvatar = getCurrentCharAvatar()) {
    const targets = [];
    const addTarget = (character, sourceLabel = '', groupId = '') => {
        if (!character?.avatar || targets.some(target => target.avatar === character.avatar)) {
            return;
        }

        targets.push({
            avatar: character.avatar,
            name: character.name || 'Character',
            sourceLabel,
            groupId,
        });
    };

    const baseGroupId = getConversationGroupIdForAvatar(baseAvatar);
    const baseSettings = baseAvatar ? getSettings(baseAvatar, { groupId: baseGroupId }) : null;
    if (baseAvatar) {
        getConversationParticipants(baseAvatar, baseSettings || getSettings(baseAvatar, { groupId: baseGroupId }), { groupId: baseGroupId })
            .forEach(character => addTarget(character, 'Conversation', baseGroupId));
    }

    getCurrentGroupConversationMembers({ requireEnabled: false }).forEach(({ character }) => addTarget(character, 'Group chat', getConversationGroupIdForAvatar(character?.avatar)));

    if (!targets.length && baseAvatar) {
        addTarget(getCharacterForAvatar(baseAvatar), 'Conversation', baseGroupId);
    }

    return targets;
}

export function getCharacterForGroupChatMessage(message) {
    const avatar = String(message?.original_avatar || message?.extra?.original_avatar || message?.extra?.avatar || '').trim();
    return avatar ? getCharacterForAvatar(avatar) : null;
}

export function buildGroupChatContext(limit = GROUP_ASIDE_CONTEXT_LIMIT) {
    const startIndex = Math.max(0, chat.length - limit);
    const lines = [];
    for (let index = startIndex; index < chat.length; index++) {
        const message = chat[index];
        const text = stripPreviewText(message?.mes || '');
        if (!text) {
            continue;
        }

        const speaker = message?.name || (message?.is_user || message?.role === 'user' ? name1 || 'User' : 'Character');
        lines.push(`${speaker}: ${formatPromptText(text, 600)}`);
    }

    return lines.join('\n');
}

export function getGroupAsideKey(avatar, groupId = selected_group) {
    return `${groupId || 'group'}:${avatar || 'unknown'}`;
}

export function getConversationMessageAvatar(message, avatar = getCurrentCharAvatar()) {
    if (message.role === 'user') {
        return (typeof user_avatar === 'string' && user_avatar)
            ? getThumbnailUrl('persona', user_avatar) || default_user_avatar
            : default_user_avatar;
    }

    if (message.role === 'partner' || message.role === 'system') {
        const partnerAvatar = message.extra?.partner_avatar;
        if (partnerAvatar) {
            return getThumbnailUrl('avatar', partnerAvatar);
        }
    }

    if (avatar) {
        return getThumbnailUrl('avatar', avatar);
    }

    return default_user_avatar;
}

export function getConversationMessageReceipt(message, avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    if (!message || message.role !== 'user') {
        return '';
    }

    const thread = getConversationThread(avatar, { groupId });
    const messageIndex = thread.findIndex(item => item.id === message.id);
    if (messageIndex >= 0 && thread.slice(messageIndex + 1).some(item => !['user', 'system'].includes(item.role))) {
        return 'Seen';
    }

    const seenAt = getConversationSeenAt(avatar, { groupId });
    const createdAt = parsePositiveInt(message.created_at, 0, 0);
    return seenAt > 0 && createdAt > 0 && seenAt >= createdAt ? 'Seen' : 'Delivered';
}
