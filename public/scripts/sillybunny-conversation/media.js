import { characters, default_user_avatar, getThumbnailUrl } from '../../script.js';
import { DEFAULT_SETTINGS, MAX_STACKED_PARTICIPANT_AVATARS } from './constants.js';
import {
    getActiveConversationBranch,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getCurrentCharacter,
    getCurrentCharAvatar,
    getCurrentCharName,
} from './context.js';
import { parseAvatarList } from './partners.js';
import { formatPromptText } from './prompt.js';
import { scheduleTimelineRender } from './render-scheduler.js';
import { getCurrentActivityFromSchedule, getStoredSchedule } from './schedule.js';
import { getSettings } from './settings-store.js';
import { conversationState } from './state.js';
import { getConversationThread } from './thread-store.js';

export async function generateConversationImage(prompt, negative = '') {
    if (conversationState.imageGenerationActive) {
        return null;
    }

    conversationState.imageGenerationActive = true;
    conversationState.imageGenerationAbortController = new AbortController();
    scheduleTimelineRender();
    try {
        const qig = await import('../extensions/quick-image-gen/index.js');
        const entry = await qig.withTransientGenerationSettings({}, async () => {
            const settings = qig.getGenerationSettingsForRun();
            const raw = await qig.generateForProvider(prompt, negative, settings, conversationState.imageGenerationAbortController.signal, {});
            return raw ? qig.finalizeGeneratedEntry(raw, prompt, negative, settings, {}) : null;
        });

        return entry?.url ?? null;
    } catch (error) {
        console.warn('Conversation Mode: QIG not available or generation failed', error);
        return null;
    } finally {
        conversationState.imageGenerationActive = false;
        conversationState.imageGenerationAbortController = null;
        scheduleTimelineRender();
    }
}

export function getCharacterForAvatar(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return getCurrentCharacter();
    }

    return (Array.isArray(characters) ? characters : []).find(character => character?.avatar === avatar) || null;
}

export function getCharacterIndexForAvatar(avatar) {
    return (Array.isArray(characters) ? characters : []).findIndex(character => character?.avatar === avatar);
}

export function addUniqueAvatar(avatars, avatar, currentAvatar = '') {
    if (!avatar || avatar === currentAvatar || avatars.includes(avatar)) {
        return;
    }

    avatars.push(avatar);
}

export function getConversationPartnerAvatars(avatar = getCurrentCharAvatar(), settings = null, { includeThreadPartners = true, groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const resolvedSettings = settings || getSettings(avatar, { groupId });
    const partnerAvatars = [];
    parseAvatarList(resolvedSettings?.multi_char_names).forEach(partnerAvatar => addUniqueAvatar(partnerAvatars, partnerAvatar, avatar));

    const group = getConversationGroupById(groupId);
    if (group?.members?.length) {
        group.members
            .filter(memberAvatar => !group.disabled_members?.includes(memberAvatar))
            .forEach(memberAvatar => addUniqueAvatar(partnerAvatars, memberAvatar, avatar));
    }

    if (includeThreadPartners) {
        getConversationThread(avatar, { groupId }).forEach((message) => {
            if (message?.role !== 'partner') {
                return;
            }

            addUniqueAvatar(partnerAvatars, message.extra?.partner_avatar, avatar);
        });
    }

    return partnerAvatars.filter(partnerAvatar => getCharacterForAvatar(partnerAvatar));
}

export function getConversationParticipants(avatar = getCurrentCharAvatar(), settings = null, options = {}) {
    const { groupId = getConversationGroupIdForAvatar(avatar) } = options;
    const resolvedSettings = settings || getSettings(avatar, { groupId });
    const participants = [];
    const primary = getCharacterForAvatar(avatar);
    if (primary?.avatar) {
        participants.push(primary);
    }

    getConversationPartnerAvatars(avatar, resolvedSettings, options).forEach((partnerAvatar) => {
        const partner = getCharacterForAvatar(partnerAvatar);
        if (partner?.avatar && !participants.some(participant => participant.avatar === partner.avatar)) {
            participants.push(partner);
        }
    });

    return participants;
}

export function getEffectiveConversationStatus(avatar = getCurrentCharAvatar(), settings = getSettings(avatar)) {
    const schedule = getStoredSchedule(avatar);
    if (schedule) {
        return getCurrentActivityFromSchedule(schedule, avatar).status;
    }

    return settings?.availability || DEFAULT_SETTINGS.availability;
}

export function getParticipantNamesForDisplay(participants) {
    return participants
        .map(participant => participant?.name || 'Character')
        .filter(Boolean);
}

export function renderConversationParticipantStack(container, participants, {
    status = 'online',
    max = MAX_STACKED_PARTICIPANT_AVATARS,
    groupId = getConversationGroupIdForAvatar(getCurrentCharAvatar()),
    onAvatarClick = null,
    zoomable = false,
} = {}) {
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const participantList = Array.isArray(participants) ? participants : [];
    const visibleParticipants = participantList.filter(participant => participant?.avatar).slice(0, max);
    container.textContent = '';
    container.title = getParticipantNamesForDisplay(participantList).join(', ');

    if (!visibleParticipants.length) {
        const fallbackItem = document.createElement('span');
        fallbackItem.className = 'sb-conversation-participant-avatar';
        fallbackItem.dataset.primary = 'true';
        const fallbackImage = document.createElement('img');
        fallbackImage.alt = '';
        fallbackImage.loading = 'lazy';
        fallbackImage.src = default_user_avatar;
        fallbackItem.appendChild(fallbackImage);
        container.appendChild(fallbackItem);
        return;
    }

    visibleParticipants.forEach((participant, index) => {
        const avatarItem = document.createElement('span');
        avatarItem.className = 'sb-conversation-participant-avatar';
        avatarItem.dataset.primary = String(index === 0);
        avatarItem.title = participant.name || 'Character';

        if (typeof onAvatarClick === 'function') {
            avatarItem.classList.add('is-interactive');
            avatarItem.tabIndex = 0;
            avatarItem.role = 'button';
            avatarItem.setAttribute('aria-label', `Open solo DM with ${participant.name || 'Character'}`);
            avatarItem.addEventListener('click', (event) => {
                event.stopPropagation();
                onAvatarClick(participant);
            });
            avatarItem.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onAvatarClick(participant);
                }
            });
        } else if (zoomable) {
            avatarItem.classList.add('is-interactive');
            avatarItem.dataset.sbConversationAction = 'zoom-avatar';
            avatarItem.dataset.avatarFile = participant.avatar;
            avatarItem.dataset.avatarType = 'avatar';
            avatarItem.tabIndex = 0;
            avatarItem.role = 'button';
            avatarItem.setAttribute('aria-label', `Show full picture for ${participant.name || 'Character'}`);
        }

        const image = document.createElement('img');
        image.alt = '';
        image.loading = index > 0 ? 'lazy' : 'eager';
        image.src = getThumbnailUrl('avatar', participant.avatar) || default_user_avatar;
        avatarItem.appendChild(image);

        const statusDot = document.createElement('span');
        statusDot.className = 'sb-conversation-status-dot';
        statusDot.dataset.status = participant.avatar
            ? getEffectiveConversationStatus(participant.avatar, getSettings(participant.avatar, { groupId }))
            : status;
        statusDot.setAttribute('aria-hidden', 'true');
        avatarItem.appendChild(statusDot);

        container.appendChild(avatarItem);
    });

    if (participantList.length > visibleParticipants.length) {
        const overflow = document.createElement('span');
        overflow.className = 'sb-conversation-participant-overflow';
        overflow.textContent = `+${participantList.length - visibleParticipants.length}`;
        overflow.setAttribute('aria-hidden', 'true');
        container.appendChild(overflow);
    }
}

export function getCharacterImageDetails(avatar = getCurrentCharAvatar()) {
    const character = getCharacterForAvatar(avatar);
    if (!character) {
        return '';
    }

    return [
        character.description ? `Description: ${character.description}` : '',
        character.personality ? `Personality: ${character.personality}` : '',
        character.scenario ? `Context: ${character.scenario}` : '',
        character.data?.creator_notes ? `Creator notes: ${character.data.creator_notes}` : '',
    ].filter(Boolean).map(value => formatPromptText(value, 900)).join('\n');
}

export function getCharacterAuthorNote(avatar = getCurrentCharAvatar()) {
    const character = getCharacterForAvatar(avatar);
    return String(character?.data?.extensions?.depth_prompt?.prompt || '').trim();
}

export function getConversationDisplayName(avatar = getCurrentCharAvatar(), settings = getSettings(avatar), { groupId = getConversationGroupIdForAvatar(avatar) } = {}) {
    const branch = getActiveConversationBranch(avatar, { create: false, groupId });
    if (branch?.name && branch.name !== 'Main') {
        return branch.name;
    }

    const names = getParticipantNamesForDisplay(getConversationParticipants(avatar, settings, { groupId }));
    return names.length ? names.join(', ') : 'Conversation';
}

export function buildCharacterImagePrompt(template, scene = 'the current DM conversation', avatar = getCurrentCharAvatar()) {
    const character = getCharacterForAvatar(avatar);
    const charName = character?.name || getCurrentCharName();
    const details = getCharacterImageDetails(avatar);
    const basePrompt = String(template || DEFAULT_SETTINGS.image_gen_prompt_template)
        .replace(/\{\{char\}\}/g, charName)
        .replace(/\{\{scene\}\}/g, scene)
        .replace(/\{\{appearance\}\}/g, details || `${charName}'s established appearance`);

    if (!details) {
        return basePrompt;
    }

    return [
        basePrompt,
        `Depict ${charName} specifically, not a generic person. Use these character-card details: ${details}`,
    ].join('\n');
}
