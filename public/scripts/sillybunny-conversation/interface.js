import { online_status } from '../../script.js';
import { isConversationStylesheetLoading, setConversationInterfaceActive } from './chrome.js';
import { CHROME_IDS } from './constants.js';
import {
    getActiveConversationChat,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationRecord,
    getCurrentCharacter,
    getCurrentCharAvatar,
    getCurrentCharName,
} from './context.js';
import { generateConversationRaw, normalizeConversationOutputText } from './generation.js';
import { getConversationMessageRevision } from './message-identity-utils.js';
import { getConversationDisplayName, getConversationParticipants, getEffectiveConversationStatus, renderConversationParticipantStack } from './media.js';
import { describeHeaderSubtitle } from './conversation-list-model.js';
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
import { updateUserFooter } from './pickers.js';
import { getCharacterStatus } from './schedule.js';
import { getSettings } from './settings-store.js';
import { conversationState } from './state.js';
import { getConversationMessages, saveConversationMessages } from './conversation-store.js';
import { renderConversationTimeline } from './timeline-render.js';
import { getActiveTypingParticipants, getLastConversationPreview } from './typing.js';
import { registerConversationRenderer, scheduleInterfaceRefresh, scheduleTimelineRender } from './render-scheduler.js';
import { hashConversationRenderFingerprint } from './render-utils.js';
import { createSpinner } from '../sillybunny-editor/status-page.js';
import { getConversationListViewKey, renderConversationListView } from './conversation-list-view.js';

/** The name of a row is the name that the header shows. */
function getListRowName({ name, character, settings, groupId }) {
    return getConversationDisplayName(character.avatar, settings, { groupId, name });
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
                : 'Pick or start a conversation from the list.';
            status.title = status.textContent;
        }
        return;
    }

    if (stage instanceof HTMLElement) {
        stage.dataset.ambientStatus = String(effectiveStatus || settings.availability || 'online');
    }

    const participants = getConversationParticipants(avatar, settings, { groupId });
    renderHeaderParticipantStack(participantsContainer, participants, {
        status: effectiveStatus,
        groupId,
        zoomable: true,
    });
    if (name instanceof HTMLElement) {
        name.textContent = getConversationDisplayName(avatar, settings, { groupId, personaId });
    }
    if (status instanceof HTMLElement) {
        const typingNames = getActiveTypingParticipants(avatar, { groupId, personaId }).map(participant => participant?.name || 'Character');
        const hasRoutineActivity = current.source !== 'manual';
        status.textContent = describeHeaderSubtitle({
            typingNames,
            isGroup: Boolean(groupId),
            description: getConversationGroupById(groupId)?.description ?? '',
            status: {
                label: getAvailabilityCopy(current.status).label,
                activity: hasRoutineActivity ? current.activity : '',
                delayed: ['dnd', 'offline'].includes(current.status),
            },
        });
        status.title = status.textContent;
    }
}

export function updateConversationChrome(settings = getSettings()) {
    updateConversationHeader(settings);
    renderConversationList();
}

export function refreshConversationInterface() {
    const avatar = getCurrentCharAvatar();
    const personaId = getConversationPersonaId();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId, personaId });
    // First open lazy-loads the Conversation sheet; keep Roleplay painted until it applies.
    const active = Boolean(conversationState.conversationWorkspaceOpen) && !isConversationStylesheetLoading();

    setConversationInterfaceActive(active);

    if (active) {
        if (avatar) {
            const record = getConversationRecord(avatar, { groupId, personaId });
            const chatId = record?.activeChatId || '';
            const address = record && chatId ? { conversationId: record.id, chatId } : null;
            conversationData.setOpen(address);
            if (address && !conversationData.chat(address)) {
                void conversationData.loadChat(address).then(() => scheduleInterfaceRefresh(), () => {});
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
                        : 'Pick or start a conversation from the list…';
        }
        if (send instanceof HTMLButtonElement) {
            send.disabled = !avatar || chatLoading || !isConnected || conversationState.conversationUploadActive;
        }
        document.querySelectorAll(`#${CHROME_IDS.form} .sb-conversation-composer-tool`).forEach((button) => {
            if (button instanceof HTMLButtonElement) {
                button.disabled = !avatar;
            }
        });
    }

    updateProsePolisherButtonVisibility();
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
