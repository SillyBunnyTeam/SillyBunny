import {
    characters,
    chat,
    default_user_avatar,
    getThumbnailUrl,
    name1,
} from '../../script.js';
import { selected_group } from '../group-chats.js';
import { user_avatar } from '../personas.js';
import { DEFAULT_SETTINGS, GROUP_ASIDE_CONTEXT_LIMIT } from './constants.js';
import {
    getConversationGroupById,
    getConversationGroupAnchor,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationKey,
    getCurrentCharAvatar,
    parsePositiveInt,
} from './context.js';
import { conversationData } from './conversation-data-browser.js';
import { getCharacterForAvatar, getCharacterIndexForAvatar, getConversationParticipants } from './media.js';
import { formatPromptText } from './shared-helpers.js';
import { getSettings } from './settings-store.js';
import { conversationState } from './state.js';
import { getConversationSeenAt, getConversationMessages } from './conversation-store.js';
import { stripPreviewText } from './typing.js';

export function getConversationSettingsForCharacter(character, { groupId = getConversationGroupIdForAvatar(character?.avatar), personaId = getConversationPersonaId() } = {}) {
    return character?.avatar ? getSettings(character.avatar, { groupId, personaId }) : { ...DEFAULT_SETTINGS };
}

/** The characters that have a direct conversation with the persona. */
export function getDirectConversations({ personaId = getConversationPersonaId() } = {}) {
    if (!Array.isArray(characters)) {
        return [];
    }

    return conversationData.list({ personaId })
        .filter(view => view.kind === 'direct')
        .map((view) => {
            const character = getCharacterForAvatar(view.characters[0]);
            return { character, index: getCharacterIndexForAvatar(view.characters[0]), settings: getConversationSettingsForCharacter(character, { groupId: '', personaId }) };
        })
        .filter(item => item.character?.avatar);
}

/**
 * The rows of the list, newest message first (the cache keeps that order). A conversation whose characters are all
 * gone from the library is left out; its files stay.
 */
export function getConversationRailItems({ personaId = getConversationPersonaId() } = {}) {
    const items = [];
    for (const view of conversationData.list({ personaId })) {
        const group = view.kind === 'group' ? getConversationGroupById(view.id) : null;
        const anchor = group ? getConversationGroupAnchor(group, { personaId }) : null;
        const character = group ? anchor?.character : getCharacterForAvatar(view.characters[0]);
        if (!character?.avatar) {
            continue;
        }

        const groupId = group ? group.id : '';
        items.push({
            character,
            index: getCharacterIndexForAvatar(character.avatar),
            settings: getConversationSettingsForCharacter(character, { groupId, personaId }),
            groupId,
            group,
            key: getConversationKey(character.avatar, groupId, { personaId }),
        });
    }
    return items;
}

export function getSelectedConversationGroup() {
    return getConversationGroupById(conversationState.conversationWorkspaceOpen ? conversationState.conversationSelectedGroupId : selected_group);
}

export function getCurrentGroupConversationMembers({ requireRoleplayReactions = false, groupId = null, group = null } = {}) {
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
        .filter(item => item.character?.avatar)
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

    getCurrentGroupConversationMembers().forEach(({ character }) => addTarget(character, 'Group chat', getConversationGroupIdForAvatar(character?.avatar)));

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

    if (message.role === 'member' || message.role === 'system') {
        const memberAvatar = message.extra?.member_avatar;
        if (memberAvatar) {
            return getThumbnailUrl('avatar', memberAvatar);
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

    const conversationMessages = getConversationMessages(avatar, { groupId, personaId });
    const messageIndex = conversationMessages.findIndex(item => item.id === message.id);
    if (messageIndex >= 0 && conversationMessages.slice(messageIndex + 1).some(item => !['user', 'system'].includes(item.role))) {
        return 'Seen';
    }

    const seenAt = getConversationSeenAt(avatar, { groupId, personaId });
    const createdAt = parsePositiveInt(message.created_at, 0, 0);
    return seenAt > 0 && createdAt > 0 && seenAt >= createdAt ? 'Seen' : 'Delivered';
}
