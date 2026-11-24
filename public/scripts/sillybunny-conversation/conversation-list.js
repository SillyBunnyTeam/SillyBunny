import {
    characters,
    chat,
    default_user_avatar,
    getThumbnailUrl,
    name1,
} from '../../script.js';
import { selected_group } from '../group-chats.js';
import { user_avatar } from '../personas.js';
import { DEFAULT_CHAT_ID, DEFAULT_SETTINGS, GROUP_ASIDE_CONTEXT_LIMIT } from './constants.js';
import {
    getActiveConversationChat,
    getConversationGroupById,
    getConversationGroupAnchor,
    getConversationGroupIdForAvatar,
    getConversationGroups,
    getConversationPersonaId,
    getConversationStore,
    getConversationKey,
    getCurrentCharAvatar,
    isConversationKeyForPersona,
    normalizeConversationChat,
    parseConversationKey,
    parsePositiveInt,
} from './context.js';
import { getCharacterForAvatar, getCharacterIndexForAvatar, getConversationParticipants } from './media.js';
import { formatPromptText } from './shared-helpers.js';
import { getSettings } from './settings-store.js';
import { conversationState } from './state.js';
import { getConversationSeenAt, getConversationMessages } from './conversation-store.js';
import { stripPreviewText } from './typing.js';

export function getConversationSettingsForCharacter(character, { groupId = getConversationGroupIdForAvatar(character?.avatar), personaId = getConversationPersonaId() } = {}) {
    return character?.avatar ? getSettings(character.avatar, { groupId, personaId }) : { ...DEFAULT_SETTINGS };
}

export function getDirectConversations({ personaId = getConversationPersonaId() } = {}) {
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
    const addItem = ({ character, index, settings, groupId = '', group = null, conversationRecord = null }) => {
        const avatar = character?.avatar;
        if (!avatar || (!groupId && !settings?.enabled)) {
            return;
        }

        const key = getConversationKey(avatar, groupId || '', { personaId });
        if (!key || seen.has(key) || (groupId && seenGroupIds.has(String(groupId)))) {
            return;
        }

        if (groupId) {
            const chatId = conversationRecord?.activeBranchId || DEFAULT_CHAT_ID;
            const conversationChat = normalizeConversationChat(conversationRecord?.branches?.[chatId], chatId);
            const isEmptyConversation = !conversationChat.messages.length && !conversationChat.unread && conversationChat.preview === 'Conversation ready';
            if (isEmptyConversation && !group?.is_conversation_group) {
                return;
            }
        }

        seen.add(key);
        if (groupId) {
            seenGroupIds.add(String(groupId));
        }
        items.push({ character, index, settings, groupId: groupId || '', group, key });
    };

    getDirectConversations({ personaId }).forEach(conversation => addItem({ ...conversation, groupId: '' }));

    getConversationGroups({ personaId }).forEach((group) => {
        const anchor = getConversationGroupAnchor(group, { personaId });
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
            conversationRecord: anchor.conversationRecord,
        });
    });

    Object.entries(getConversationStore().characters || {}).forEach(([storeKey]) => {
        if (!isConversationKeyForPersona(storeKey, personaId)) {
            return;
        }

        const parsed = parseConversationKey(storeKey);
        if (!parsed.groupId || !parsed.avatar) {
            return;
        }

        const group = getConversationGroupById(parsed.groupId, { personaId });
        const anchor = getConversationGroupAnchor(group, { personaId });
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
            conversationRecord: anchor.conversationRecord,
        });
    });

    // Messaging-app order: newest message first. Selecting a thread must not move it.
    const activityTimes = new Map(items.map(item => [item.key, getRailItemActivityTime(item, personaId)]));
    return items.sort((first, second) => activityTimes.get(second.key) - activityTimes.get(first.key));
}

function getMessageTimeMs(message) {
    const createdAt = Number(message?.created_at);
    if (Number.isFinite(createdAt) && createdAt > 0) {
        return createdAt;
    }
    const sendDate = Date.parse(String(message?.send_date || ''));
    return Number.isFinite(sendDate) ? sendDate : 0;
}

function getRailItemActivityTime(item, personaId) {
    const conversationChat = getActiveConversationChat(item.character.avatar, { create: false, groupId: item.groupId, personaId });
    const messages = Array.isArray(conversationChat?.messages) ? conversationChat.messages : [];
    for (let index = messages.length - 1; index >= 0; index--) {
        const time = getMessageTimeMs(messages[index]);
        if (time) {
            return time;
        }
    }
    return Number((messages.length ? conversationChat?.updatedAt : conversationChat?.createdAt) || conversationChat?.updatedAt || 0);
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
        const memberAvatar = message.extra?.partner_avatar;
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
