import { getConversationGroupIdForAvatar, getConversationPersonaId } from './context.js';
import { normalizeConversationOutputText } from './generation.js';
import { getSettings } from './settings-store.js';
import { stripSpeakerPrefixText } from './members-utils.js';

export {
    escapeRegExp,
    getCharacterMentionHandles,
    hasMentionBoundaryMatch,
    isCharacterMentionedInText,
    parseAvatarList,
} from './members-utils.js';

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

export function stripSpeakerPrefix(messageText, speakerName) {
    return stripSpeakerPrefixText(messageText, speakerName, normalizeConversationOutputText);
}
