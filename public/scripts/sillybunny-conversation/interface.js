import { online_status } from '../../script.js';
import { isConversationStylesheetLoading, setConversationInterfaceActive } from './chrome.js';
import { CHROME_IDS, DEFAULT_CHAT_ID, DEFAULT_SETTINGS, SETTINGS_FIELDS } from './constants.js';
import {
    getActiveConversationChat,
    getConversationChats,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationRecord,
    getCurrentCharacter,
    getCurrentCharAvatar,
    getCurrentCharName,
    parsePositiveInt,
} from './context.js';
import { generateConversationRaw, normalizeConversationOutputText } from './generation.js';
import { getConversationMessageRevision } from './message-identity-utils.js';
import { getConversationDisplayName, getConversationParticipants, getEffectiveConversationStatus, renderConversationParticipantStack } from './media.js';
import {
    clearUnreadCount,
    getBadgeLabel,
    getUnreadCount,
    isConversationActive,
    updateConversationNotificationIndicators,
} from './notifications.js';
import { conversationData } from './conversation-data-browser.js';
import { getConversationRailItems } from './conversation-list.js';
import { getAvailabilityCopy } from './personas.js';
import { readChimingMembersFromList, updateUserFooter } from './pickers.js';
import { clamp, getCharacterStatus } from './schedule.js';
import { getSettings, saveSettings } from './settings-store.js';
import { conversationState } from './state.js';
import { getConversationMessages, saveConversationMessages } from './conversation-store.js';
import { renderConversationTimeline, syncSettingsDrawerRows } from './timeline-render.js';
import { getActiveTypingParticipants, getLastConversationPreview } from './typing.js';
import { registerConversationRenderer, scheduleInterfaceRefresh, scheduleTimelineRender } from './render-scheduler.js';
import { hashConversationRenderFingerprint } from './render-utils.js';
import { createSpinner } from '../sillybunny-editor/status-page.js';
import { getConversationListViewKey, renderConversationListView } from './conversation-list-view.js';

/** The name the conversation was given, else its members' names (a direct conversation: the character's own). */
function getListRowName({ name, character, settings, groupId }) {
    if (name) {
        return name;
    }
    const members = getConversationParticipants(character.avatar, settings, { groupId });
    return groupId && members.length ? members.map(member => member?.name || 'Character').join(', ') : character.name || 'Character';
}

function buildListEntry(item, personaId) {
    const { character, index, settings, groupId, key, favorite, lastMessageRole } = item;
    const avatar = character.avatar;
    const unread = getUnreadCount(avatar, { groupId, personaId });
    return {
        id: key,
        name: getListRowName(item),
        favorite,
        muted: Boolean(settings?.notifications_muted),
        unread,
        badge: getBadgeLabel(unread),
        preview: getLastConversationPreview(avatar, { groupId, personaId }),
        lastMessageRole,
        active: isConversationActive(avatar, groupId, { personaId }),
        avatar,
        characterIndex: String(index),
        groupId: groupId || '',
        participants: getConversationParticipants(avatar, settings, { groupId }),
        status: getEffectiveConversationStatus(avatar),
    };
}

/** The rows of the conversation list as it shows them now, in the order of the data module. */
export function getConversationListEntries() {
    const personaId = getConversationPersonaId();
    return getConversationRailItems({ personaId }).map(item => buildListEntry(item, personaId));
}

function buildConversationListFingerprint(entries) {
    const parts = [String(entries.length), getConversationPersonaId(), getConversationListViewKey()];
    for (const entry of entries) {
        parts.push([
            entry.id,
            entry.name,
            entry.favorite ? '1' : '0',
            entry.muted ? '1' : '0',
            entry.unread,
            entry.preview,
            entry.lastMessageRole,
            entry.active ? '1' : '0',
            entry.avatar,
            entry.groupId,
            entry.participants.map(participant => `${participant?.avatar || ''}:${participant?.name || ''}:${getEffectiveConversationStatus(participant?.avatar)}`).join(','),
        ].join('\u001f'));
    }

    return hashConversationRenderFingerprint(parts.join('\u001e'));
}

function buildHeaderParticipantsFingerprint(participants, { groupId = '', status = 'online', interactive = false } = {}) {
    const participantParts = (Array.isArray(participants) ? participants : []).map(participant => [
        participant?.avatar || '',
        participant?.name || '',
        participant?.avatar ? getEffectiveConversationStatus(participant.avatar) : status,
    ].join('\u001f'));

    return hashConversationRenderFingerprint([
        groupId || '',
        status || '',
        interactive ? '1' : '0',
        participantParts.join('\u001e'),
    ].join('\u001f'));
}

function renderHeaderParticipantStack(container, participants, options = {}) {
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const fingerprint = buildHeaderParticipantsFingerprint(participants, {
        groupId: options.groupId,
        status: options.status,
        interactive: typeof options.onAvatarClick === 'function' || Boolean(options.zoomable),
    });
    if (container.dataset.sbConversationFingerprint === fingerprint) {
        return;
    }

    container.dataset.sbConversationFingerprint = fingerprint;
    renderConversationParticipantStack(container, participants, options);
}

export function renderConversationList() {
    const list = document.getElementById(CHROME_IDS.listItems);
    if (!(list instanceof HTMLElement)) {
        return;
    }

    const entries = getConversationListEntries();
    const fingerprint = buildConversationListFingerprint(entries);
    if (fingerprint === conversationState.lastConversationListFingerprint && list.dataset.sbConversationFingerprint === fingerprint) {
        return;
    }

    conversationState.lastConversationListFingerprint = fingerprint;
    list.dataset.sbConversationFingerprint = fingerprint;
    renderConversationListView(list, entries);
    updateConversationNotificationIndicators();
}

export function updateConversationHeader(settings = getSettings()) {
    const character = getCurrentCharacter();
    const avatar = getCurrentCharAvatar();
    const personaId = getConversationPersonaId();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const stage = document.getElementById(CHROME_IDS.stage);
    const name = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-name]`);
    const status = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-status]`);
    const participantsContainer = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-participants]`);
    const statusCopy = getAvailabilityCopy(settings.availability);
    const current = avatar ? getCharacterStatus(avatar, new Date(), { personaId }) : null;
    const effectiveStatus = current ? current.status : settings.availability;

    if (!avatar || !character) {
        const unavailableGroup = conversationState.conversationUnavailableGroupId
            ? getConversationGroupById(conversationState.conversationUnavailableGroupId)
            : null;
        if (stage instanceof HTMLElement) {
            stage.dataset.ambientStatus = 'offline';
        }
        renderHeaderParticipantStack(participantsContainer, [], { status: 'offline' });
        if (name instanceof HTMLElement) {
            name.textContent = unavailableGroup?.name || 'Conversation';
        }
        if (status instanceof HTMLElement) {
            status.textContent = unavailableGroup
                ? 'No eligible Conversation members are available in this group yet.'
                : 'Pick or start a DM from the Pals rail.';
        }
        return;
    }

    if (stage instanceof HTMLElement) {
        stage.dataset.ambientStatus = String(effectiveStatus || settings.availability || 'online');
    }

    const participants = getConversationParticipants(avatar, settings, { groupId });
    const memberCount = Math.max(0, participants.length - 1);
    renderHeaderParticipantStack(participantsContainer, participants, {
        status: effectiveStatus,
        groupId,
        zoomable: true,
    });
    if (name instanceof HTMLElement) {
        name.textContent = getConversationDisplayName(avatar, settings);
    }
    if (status instanceof HTMLElement) {
        const activeChatId = getConversationRecord(avatar, { groupId, personaId })?.activeChatId || DEFAULT_CHAT_ID;
        const chatName = getConversationChats(avatar, { groupId }).find(chat => chat.id === activeChatId)?.name || 'Main';
        const typingParticipants = getActiveTypingParticipants(avatar, { groupId, personaId });
        let statusText;
        if (typingParticipants.length) {
            const typingNames = typingParticipants.map(participant => participant?.name || 'Character').filter(Boolean);
            if (typingNames.length > 2) {
                statusText = 'Several People Are Typing…';
            } else if (typingNames.length > 1) {
                statusText = `${typingNames.join(', ')} Are Writing…`;
            } else {
                statusText = `${typingNames[0] || 'Character'} Is Writing…`;
            }
        } else if (current && current.source !== 'manual') {
            const currentCopy = getAvailabilityCopy(current.status);
            const delayedNotice = ['dnd', 'offline'].includes(current.status) ? ' · replies may be delayed' : '';
            const memberNotice = memberCount ? ` · ${memberCount} pal${memberCount === 1 ? '' : 's'} can chime in` : '';
            statusText = `${currentCopy.label} · ${current.activity}${delayedNotice}${memberNotice}`;
        } else {
            const memberNotice = memberCount ? ` · ${memberCount} pal${memberCount === 1 ? '' : 's'} can chime in` : '';
            statusText = `${statusCopy.label}${memberNotice}`;
            status.title = statusCopy.detail;
        }
        status.textContent = `${chatName} · ${statusText}`;
        if ((current && current.source !== 'manual') || typingParticipants.length) {
            status.title = statusText;
        }
    }
}

export function updateConversationChrome(settings = getSettings()) {
    updateConversationHeader(settings);
    renderConversationList();
}

export function refreshConversationInterface({ syncControls = false } = {}) {
    const avatar = getCurrentCharAvatar();
    const personaId = getConversationPersonaId();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId, personaId });
    // First open lazy-loads the Conversation sheet; keep Roleplay painted until it applies.
    const active = Boolean(conversationState.conversationWorkspaceOpen) && !isConversationStylesheetLoading();

    setConversationInterfaceActive(active);

    if (syncControls && avatar) {
        applySettingsToPanel(settings);
    }

    if (active) {
        if (avatar) {
            const record = getConversationRecord(avatar, { groupId, personaId });
            const chatId = record?.activeChatId || '';
            const address = record && chatId ? { conversationId: record.id, chatId } : null;
            conversationData.setOpen(address);
            if (address && !conversationData.chat(address)) {
                void conversationData.loadChat(address).then(() => scheduleInterfaceRefresh({ syncControls: false }), () => {});
            } else {
                void clearUnreadCount(avatar, { chatId, groupId, personaId });
            }
        }
        renderConversationTimeline();
        updateConversationChrome(settings);
        updateUserFooter();

        const input = document.getElementById(CHROME_IDS.input);
        const send = document.getElementById(CHROME_IDS.send);
        const unavailableGroup = conversationState.conversationUnavailableGroupId
            ? getConversationGroupById(conversationState.conversationUnavailableGroupId)
            : null;
        const isConnected = online_status !== 'no_connection';
        const openChat = avatar ? getActiveConversationChat(avatar, { groupId, personaId }) : null;
        const chatLoading = Boolean(openChat) && !openChat.loaded;
        if (input instanceof HTMLTextAreaElement) {
            input.disabled = !avatar || chatLoading;
            input.placeholder = !isConnected
                ? 'Not connected to API!'
                : avatar
                    ? 'Type your message…'
                    : unavailableGroup
                        ? 'This group has no eligible Conversation members yet…'
                        : 'Pick or start a DM from the Pals rail…';
        }
        if (send instanceof HTMLButtonElement) {
            send.disabled = !avatar || chatLoading || !isConnected || conversationState.conversationUploadActive;
        }
        document.querySelectorAll(`#${CHROME_IDS.form} .sb-conversation-composer-quick`).forEach((button) => {
            if (button instanceof HTMLButtonElement) {
                button.disabled = !avatar;
            }
        });
    }

    updateProsePolisherButtonVisibility();
}

export function readSettingsFromPanel(avatar, { groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const settings = getSettings(avatar, { groupId, personaId });

    for (const field of SETTINGS_FIELDS) {
        const element = document.getElementById(field.id);
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        if (field.prop === 'checked') {
            settings[field.key] = Boolean(element.checked);
        } else if (field.type === 'number') {
            const parsed = parsePositiveInt(element.value, field.fallback, field.min);
            settings[field.key] = typeof field.max === 'number' ? clamp(parsed, field.min, field.max) : parsed;
        } else {
            settings[field.key] = element.value ?? '';
        }
    }

    return settings;
}

export function saveCurrentPanelSettings(options = {}) {
    const avatar = options?.avatar || getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const groupId = Object.prototype.hasOwnProperty.call(options, 'groupId') ? options.groupId || '' : getConversationGroupIdForAvatar(avatar);
    const personaId = options?.personaId || getConversationPersonaId();

    // Sync dynamic editor state into hidden backing inputs before reading
    const chimingInput = document.getElementById('sb_conv_multi_char_names');
    if (chimingInput instanceof HTMLInputElement) {
        chimingInput.value = readChimingMembersFromList();
    }

    const settings = readSettingsFromPanel(avatar, { groupId, personaId });
    saveSettings(avatar, settings, { groupId, personaId });
    if (personaId === getConversationPersonaId()) {
        scheduleInterfaceRefresh({ syncControls: false });
    }
    updateGroupMembersVisibility();
}

export function applySettingsToPanel(settings) {
    for (const field of SETTINGS_FIELDS) {
        const element = document.getElementById(field.id);
        if (!(element instanceof HTMLElement)) {
            continue;
        }

        if (field.prop === 'checked') {
            element.checked = Boolean(settings[field.key]);
        } else {
            element.value = settings[field.key] ?? '';
        }
    }
    updateGroupMembersVisibility();
    syncSettingsDrawerRows();
}

/** The list of extras is shown while the conversation has any. */
export function updateGroupMembersVisibility() {
    const names = document.getElementById('sb_conv_multi_char_names');
    const wrapper = document.getElementById('sb_conv_group_members_wrapper');
    if (names instanceof HTMLInputElement && wrapper instanceof HTMLElement) {
        wrapper.hidden = !names.value;
    }
}

export function loadCurrentPanelSettings() {
    const avatar = getCurrentCharAvatar();
    const personaId = getConversationPersonaId();

    if (!avatar) {
        applySettingsToPanel(DEFAULT_SETTINGS);
        scheduleInterfaceRefresh({ syncControls: false });
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId, personaId });
    applySettingsToPanel(settings);
    scheduleInterfaceRefresh({ syncControls: false });
}

export function updateProsePolisherButtonVisibility() {
    const button = document.getElementById('sb_prose_polisher_but');
    if (button instanceof HTMLElement) {
        button.classList.add('displayNone');
        button.hidden = true;
    }
}

export async function handleCharacterMessagePolish(messageId, buttonElement) {
    const avatar = getCurrentCharAvatar();
    if (!avatar) return;

    const personaId = getConversationPersonaId();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const chatId = getConversationRecord(avatar, { groupId, personaId })?.activeChatId || '';
    if (!chatId) {
        return;
    }
    const messages = getConversationMessages(avatar, { chatId, create: false, groupId, personaId });
    const msg = messages.find(m => String(m.id) === String(messageId));
    if (!msg || !msg.mes) {
        return;
    }
    const sourceRevision = getConversationMessageRevision(msg);

    if (buttonElement instanceof HTMLElement) {
        // The button draws its icon with a Font Awesome class, so the spinner is a child while the class is off.
        buttonElement.classList.remove('fa-wand-magic-sparkles');
        buttonElement.append(createSpinner({ label: buttonElement.getAttribute('aria-label') || undefined }));
    }

    try {
        const charName = msg.name || getCurrentCharName();
        const systemPrompt = `You are an editor for ${charName}'s messages. Polish ${charName}'s reply in this instant messaging chatroom to make it more expressive, fitting for their personality, and natural. Correct any structural awkwardness while preserving the exact meaning, spelling quirks, and intent of the original text. Output only the polished reply without formatting prefixes or labels.`;
        const prompt = `Polish this message text:\n"${msg.mes}"`;
        const settings = getSettings(avatar, { groupId, personaId });
        const response = await generateConversationRaw({
            prompt,
            systemPrompt,
            responseLength: 300,
            trimNames: true,
        }, settings);

        if (response?.trim()) {
            const targetMessages = getConversationMessages(avatar, { chatId, create: false, groupId, personaId });
            const targetMessage = targetMessages.find(message => String(message.id) === String(messageId));
            if (!targetMessage || getConversationMessageRevision(targetMessage) !== sourceRevision) {
                return;
            }
            targetMessage.mes = normalizeConversationOutputText(response.trim());
            saveConversationMessages(avatar, targetMessages, { chatId, create: false, groupId, personaId });
            if (isConversationActive(avatar, groupId, { chatId, personaId })) {
                scheduleTimelineRender();
            }
            globalThis.toastr?.success?.('Character reply polished successfully!');
        } else {
            globalThis.toastr?.error?.('Polishing failed. No response received.');
        }
    } catch (error) {
        console.error('Character prose polishing error:', error);
        globalThis.toastr?.error?.('Error polishing character reply');
    } finally {
        if (buttonElement instanceof HTMLElement) {
            buttonElement.querySelector(':scope > .sb-spinner')?.remove();
            buttonElement.classList.add('fa-wand-magic-sparkles');
        }
    }
}

registerConversationRenderer('conversationList', renderConversationList);
registerConversationRenderer('interface', refreshConversationInterface);
