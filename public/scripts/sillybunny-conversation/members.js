import { MEMBER_FOLLOWUP_RECENT_WINDOW } from './constants.js';
import { getConversationGroupIdForAvatar, getConversationPersonaId, getCurrentCharAvatar } from './context.js';
import { normalizeConversationOutputText } from './generation.js';
import { getCharacterForAvatar, getConversationMemberAvatars } from './media.js';
import { getSettings } from './settings-store.js';
import { getConversationMessages } from './conversation-store.js';
import {
    getLastMemberMessageIndex,
    getRecentlySilentMentionedMemberFromConversation,
    isCharacterMentionedInText,
    parseAvatarList,
    stripSpeakerPrefixText,
} from './members-utils.js';

export {
    escapeRegExp,
    getCharacterMentionHandles,
    getLastMemberMessageIndex,
    getRecentlySilentMentionedMemberFromConversation,
    hasMentionBoundaryMatch,
    isCharacterMentionedInText,
    parseAvatarList,
} from './members-utils.js';

export function getAllowedMemberCharacters(selectedAvatars, currentAvatar = getCurrentCharAvatar(), settings = getSettings(currentAvatar), { chatId = '', groupId = getConversationGroupIdForAvatar(currentAvatar), includeConversationMembers = true, personaId = getConversationPersonaId() } = {}) {
    const configuredAvatars = Array.isArray(selectedAvatars)
        ? selectedAvatars
        : parseAvatarList(selectedAvatars ?? settings?.multi_char_names);
    const avatars = Array.from(new Set([
        ...configuredAvatars,
        ...getConversationMemberAvatars(currentAvatar, {
            ...settings,
            multi_char_names: configuredAvatars.join(','),
        }, { chatId, groupId, includeConversationMembers, personaId }),
    ]));
    return avatars
        .map(avatar => getCharacterForAvatar(avatar))
        .filter(character => character?.avatar && character.avatar !== currentAvatar);
}

export function getLastUserConversationText(avatar, { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const userMessage = [...getConversationMessages(avatar, { chatId, create: false, groupId, personaId })].reverse().find(message => message?.role === 'user' && message.mes);
    return userMessage?.mes || '';
}

export function chooseConversationMember(avatar, selectedAvatars, settings = getSettings(avatar), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const members = getAllowedMemberCharacters(selectedAvatars, avatar, settings, { chatId, groupId, personaId });
    if (!members.length) {
        return null;
    }

    const lastUserText = getLastUserConversationText(avatar, { chatId, groupId, personaId });
    const mentioned = members.find(character => isCharacterMentionedInText(character, lastUserText, members));
    return mentioned || (Math.random() < 0.75 ? getLeastRecentMember(avatar, selectedAvatars, settings, { chatId, groupId, personaId }) : members[Math.floor(Math.random() * members.length)]);
}

export function getConversationMemberSettings(memberAvatar, hostSettings, { groupId = getConversationGroupIdForAvatar(memberAvatar), personaId = getConversationPersonaId() } = {}) {
    if (!memberAvatar) {
        return hostSettings;
    }

    const memberSettings = getSettings(memberAvatar, { groupId, personaId });
    return {
        ...hostSettings,
        availability: memberSettings.availability,
        inactivity_threshold: memberSettings.inactivity_threshold,
        authors_note: memberSettings.authors_note,
        lorebook_override: memberSettings.lorebook_override,
        connection_profile: memberSettings.connection_profile,
    };
}

export function getLeastRecentMember(avatar, selectedAvatars, settings = getSettings(avatar), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const members = getAllowedMemberCharacters(selectedAvatars, avatar, settings, { chatId, groupId, personaId });
    if (!members.length) {
        return null;
    }

    const messages = getConversationMessages(avatar, { chatId, create: false, groupId, personaId });
    return [...members].sort((left, right) => {
        const leftIndex = getLastMemberMessageIndex(messages, left);
        const rightIndex = getLastMemberMessageIndex(messages, right);
        return leftIndex - rightIndex;
    })[0];
}

export function getRecentlySilentMentionedMember(avatar, selectedAvatars, settings = getSettings(avatar), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const members = getAllowedMemberCharacters(selectedAvatars, avatar, settings, { chatId, groupId, personaId });
    if (!members.length) {
        return null;
    }

    const messages = getConversationMessages(avatar, { chatId, create: false, groupId, personaId });
    return getRecentlySilentMentionedMemberFromConversation(messages, members, MEMBER_FOLLOWUP_RECENT_WINDOW);
}

export function stripSpeakerPrefix(messageText, speakerName) {
    return stripSpeakerPrefixText(messageText, speakerName, normalizeConversationOutputText);
}
