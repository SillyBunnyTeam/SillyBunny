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
    getConversationGroupThreadAnchor,
    getConversationGroupIdForAvatar,
    getConversationGroups,
    getConversationPersonaId,
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
import { formatPromptText } from './shared-helpers.js';
import { getSettings } from './settings-store.js';
import { conversationState } from './state.js';
import { getConversationSeenAt, getConversationThread } from './thread-store.js';
import { stripPreviewText } from './typing.js';

export function getConversationSettingsForCharacter(character, { groupId = getConversationGroupIdForAvatar(character?.avatar), personaId = getConversationPersonaId() } = {}) {
    return character?.avatar ? getSettings(character.avatar, { groupId, personaId }) : { ...DEFAULT_SETTINGS };
}

export function getConversationPals({ personaId = getConversationPersonaId() } = {}) {
    if (!Array.isArray(characters)) {
        return [];
    }

    return characters
        .map((character, index) => ({ character, index, settings: getConversationSettingsForCharacter(character, { groupId: '', personaId }) }))
        .filter(item => item.character?.avatar && item.settings.enabled);
}

export function getConversationRailItems({ personaId = getConversationPersonaId() } = {}) {
    const items = [];
    const seen = new Set();
    const seenGroupIds = new Set();
    const activeKey = personaId === getConversationPersonaId() ? getActiveConversationThreadKey() : '';
    const addItem = ({ character, index, settings, groupId = '', group = null, threadStore = null }) => {
        const avatar = character?.avatar;
        if (!avatar || (!groupId && !settings?.enabled)) {
            return;
        }

        const key = getConversationThreadKey(avatar, groupId || '', { personaId });
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

    getConversationPals({ personaId }).forEach(pal => addItem({ ...pal, groupId: '' }));

    getConversationGroups({ personaId }).forEach((group) => {
        const anchor = getConversationGroupThreadAnchor(group, { personaId });
        const character = anchor?.character;
        if (!character?.avatar) {
            return;
        }

        const groupId = String(group.id || '');
        const settings = getConversationSettingsForCharacter(character, { groupId, personaId });
        addItem({
            character,
            index: getCharacterIndexForAvatar(character.avatar),
            settings,
            groupId,
            group,
            threadStore: anchor.threadStore,
        });
    });

    Object.entries(getConversationStore().characters || {}).forEach(([storeKey]) => {
        if (!isConversationThreadKeyForPersona(storeKey, personaId)) {
            return;
        }

        const parsed = parseConversationThreadKey(storeKey);
        if (!parsed.groupId || !parsed.avatar) {
            return;
        }

        const group = getConversationGroupById(parsed.groupId, { personaId });
        const anchor = getConversationGroupThreadAnchor(group, { personaId });
        const character = anchor?.character;
        if (!character || !group) {
            return;
        }

        const settings = getConversationSettingsForCharacter(character, { groupId: parsed.groupId, personaId });

        addItem({
            character,
            index: getCharacterIndexForAvatar(parsed.avatar),
            settings,
            groupId: parsed.groupId,
            group,
            threadStore: anchor.threadStore,
        });
    });

    return items.sort((first, second) => {
        if (first.key === activeKey) return -1;
        if (second.key === activeKey) return 1;
        const firstBranch = getActiveConversationBranch(first.character.avatar, { create: false, groupId: first.groupId, personaId });
        const secondBranch = getActiveConversationBranch(second.character.avatar, { create: false, groupId: second.groupId, personaId });
        return Number(secondBranch?.updatedAt || 0) - Number(firstBranch?.updatedAt || 0);
    });
}

export function getSelectedConversationGroup() {
    return getConversationGroupById(conversationState.conversationWorkspaceOpen ? conversationState.conversationSelectedGroupId : selected_group);
}

export function getCurrentGroupConversationMembers({ requireRoleplayReactions = false, groupId = null, group = null, requireEnabled = true } = {}) {
    const resolvedGroup = group || (groupId ? getConversationGroupById(groupId) : getSelectedConversationGroup());
    if (!resolvedGroup || !Array.isArray(resolvedGroup.members)) {
        return [];
    }

    return resolvedGroup.members
        .filter(avatar => avatar && !resolvedGroup.disabled_members?.includes(avatar))
        .map((avatar) => {
            const character = getCharacterForAvatar(avatar);
            const index = getCharacterIndexForAvatar(avatar);
            const settings = getConversationSettingsForCharacter(character, { groupId: String(resolvedGroup.id || '') });
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

export function getGroupAsideKey(avatar, groupId = selected_group, personaId = getConversationPersonaId()) {
    return `${personaId || 'persona'}:${groupId || 'group'}:${avatar || 'unknown'}`;
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

export function getConversationMessageReceipt(message, avatar = getCurrentCharAvatar(), { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!message || message.role !== 'user') {
        return '';
    }

    const thread = getConversationThread(avatar, { groupId, personaId });
    const messageIndex = thread.findIndex(item => item.id === message.id);
    if (messageIndex >= 0 && thread.slice(messageIndex + 1).some(item => !['user', 'system'].includes(item.role))) {
        return 'Seen';
    }

    const seenAt = getConversationSeenAt(avatar, { groupId, personaId });
    const createdAt = parsePositiveInt(message.created_at, 0, 0);
    return seenAt > 0 && createdAt > 0 && seenAt >= createdAt ? 'Seen' : 'Delivered';
}
