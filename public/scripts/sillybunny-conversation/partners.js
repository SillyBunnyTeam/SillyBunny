import { PARTNER_FOLLOWUP_RECENT_WINDOW } from './constants.js';
import { getConversationGroupIdForAvatar, getCurrentCharAvatar } from './context.js';
import { normalizeConversationOutputText } from './generation.js';
import { getCharacterForAvatar, getConversationPartnerAvatars } from './media.js';
import { getSettings } from './settings-store.js';
import { getConversationThread } from './thread-store.js';
import {
    getLastPartnerMessageIndex,
    getRecentlySilentMentionedPartnerFromThread,
    isCharacterMentionedInText,
    parseAvatarList,
    stripSpeakerPrefixText,
} from './partners-utils.js';

export {
    escapeRegExp,
    getCharacterMentionHandles,
    getLastPartnerMessageIndex,
    getRecentlySilentMentionedPartnerFromThread,
    hasMentionBoundaryMatch,
    isCharacterMentionedInText,
    parseAvatarList,
} from './partners-utils.js';

export function getAllowedPartnerCharacters(selectedAvatars, currentAvatar = getCurrentCharAvatar(), settings = getSettings(currentAvatar), { groupId = getConversationGroupIdForAvatar(currentAvatar), includeThreadPartners = true } = {}) {
    const configuredAvatars = Array.isArray(selectedAvatars)
        ? selectedAvatars
        : parseAvatarList(selectedAvatars ?? settings?.multi_char_names);
    const avatars = Array.from(new Set([
        ...configuredAvatars,
        ...getConversationPartnerAvatars(currentAvatar, {
            ...settings,
            multi_char_names: configuredAvatars.join(','),
        }, { groupId, includeThreadPartners }),
    ]));
    return avatars
        .map(avatar => getCharacterForAvatar(avatar))
        .filter(character => character?.avatar && character.avatar !== currentAvatar);
}

export function getLastUserConversationText(avatar, { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const userMessage = [...getConversationThread(avatar, { groupId })].reverse().find(message => message?.role === 'user' && message.mes);
    return userMessage?.mes || '';
}

export function chooseConversationPartner(avatar, selectedAvatars, settings = getSettings(avatar), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { groupId });
    if (!partners.length) {
        return null;
    }

    const lastUserText = getLastUserConversationText(avatar, { groupId });
    const mentioned = partners.find(character => isCharacterMentionedInText(character, lastUserText, partners));
    return mentioned || (Math.random() < 0.75 ? getLeastRecentPartner(avatar, selectedAvatars, settings, { groupId }) : partners[Math.floor(Math.random() * partners.length)]);
}

export function getConversationPartnerSettings(partnerAvatar, hostSettings, { groupId = getConversationGroupIdForAvatar(partnerAvatar) } = {}) {
    if (!partnerAvatar) {
        return hostSettings;
    }

    const partnerSettings = getSettings(partnerAvatar, { groupId });
    return {
        ...hostSettings,
        availability: partnerSettings.availability,
        ai_schedule: partnerSettings.ai_schedule,
        weekly_schedule: partnerSettings.weekly_schedule,
        auto_schedule: partnerSettings.auto_schedule,
        schedule_generated_at: partnerSettings.schedule_generated_at,
        talkativeness: partnerSettings.talkativeness,
        inactivity_threshold: partnerSettings.inactivity_threshold,
        reply_delay_multiplier: partnerSettings.reply_delay_multiplier,
        authors_note: partnerSettings.authors_note,
        lorebook_override: partnerSettings.lorebook_override,
        connection_profile: partnerSettings.connection_profile,
    };
}

export function getLeastRecentPartner(avatar, selectedAvatars, settings = getSettings(avatar), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { groupId });
    if (!partners.length) {
        return null;
    }

    const thread = getConversationThread(avatar, { groupId });
    return [...partners].sort((left, right) => {
        const leftIndex = getLastPartnerMessageIndex(thread, left);
        const rightIndex = getLastPartnerMessageIndex(thread, right);
        return leftIndex - rightIndex;
    })[0];
}

export function getRecentlySilentMentionedPartner(avatar, selectedAvatars, settings = getSettings(avatar), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const partners = getAllowedPartnerCharacters(selectedAvatars, avatar, settings, { groupId });
    if (!partners.length) {
        return null;
    }

    const thread = getConversationThread(avatar, { groupId });
    return getRecentlySilentMentionedPartnerFromThread(thread, partners, PARTNER_FOLLOWUP_RECENT_WINDOW);
}

export function stripSpeakerPrefix(messageText, speakerName) {
    return stripSpeakerPrefixText(messageText, speakerName, normalizeConversationOutputText);
}
