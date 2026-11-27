import {
    default_user_avatar,
    getThumbnailUrl,
    messageFormatting,
    name1,
} from '../../script.js';
import {
    CHROME_IDS,
    CONVERSATION_ATTACHMENT_ACCEPT,
    SELFIE_COMMAND_RE,
} from './constants.js';
import { truncateConversationReplyPreview } from './preview-utils.js';
import {
    getActiveConversationChat,
    getConversationChats,
    getConversationGroupById,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationRecord,
    getCurrentCharAvatar,
    getCurrentCharName,
} from './context.js';
import { conversationData } from './conversation-data-browser.js';
import { promptConversationText } from './dialogs.js';
import { commitCharacterReplyCommands, extractCharacterReplyCommands, generateConversationRaw, generateSelfieFromContext, getCharacterReplyCommandMetadata, reportConversationGenerationError } from './generation.js';
import { dropQueueItemsOfDeletedMessages, removeChatMessages } from './message-deletion.js';
import { getConversationMessagesRevision } from './message-identity-utils.js';
import { getCharacterForAvatar, getConversationParticipants, getEffectiveConversationStatus } from './media.js';
import { getConversationMessageAvatar, getConversationMessageReceipt } from './conversation-list.js';
import { escapeRegExp, getCharacterMentionHandles } from './members.js';
import { buildConversationPromptMessages, buildConversationSystemPrompt, renderConversationAttachments } from './prompt.js';
import { getPinEvents, isPinned, setMessagePin } from './pin-model.js';
import { createPinnedMark, detachPinEventRows, placePinEventRows } from './pin-events-ui.js';
import { createReactionChips, createToolbarReactionButtons } from './reactions-ui.js';
import { buildConversationRenderKey } from './render-key.js';
import { getConversationRenderChatId } from './screen-target.js';
import { registerConversationRenderer, scheduleInterfaceRefresh, scheduleConversationListRender, scheduleTimelineRender } from './render-scheduler.js';
import { escapeHtmlText, getConversationMessageExtraFingerprint, hashConversationRenderFingerprint } from './render-utils.js';
import { getSettings } from './settings-store.js';
import {
    beginConversationGenerationOperation,
    conversationState,
    endConversationGenerationOperation,
    regenerationBusyKeys,
    sendQueue,
} from './state.js';
import { getConversationTimelineMessages } from './timeline-search.js';
import { narrateConversationMessage } from './tts.js';
import {
    addConversationReminder,
    buildConversationMessageReplyReference,
    getConversationAttachmentSummary,
    getConversationSeenAt,
    getConversationMessages,
    saveConversationMessages,
} from './conversation-store.js';
import { getActiveTypingParticipants, getPrimaryTypingParticipant, withTypingParticipant } from './typing.js';
import { getConversationWorldInfo } from './world-info.js';
import { createStatusPage } from '../sillybunny-editor/status-page.js';
import { toSafeAttachmentUrl } from './safe-url.js';

export { escapeHtmlAttribute, escapeHtmlText } from './render-utils.js';
export { getConversationTimelineMessages } from './timeline-search.js';
export {
    appendConversationOocNote,
    handleConversationSlashAction,
    parseConversationReminderArgs,
    parseConversationSlashCommand,
    quickConversationSummarize,
} from './timeline-slash-commands.js';

function buildTimelineFingerprint({ avatar, groupId, chatId, personaId, settings, allMessages, messages }) {
    const activeTyping = getActiveTypingParticipants(avatar, { chatId, groupId, personaId });
    const statusAvatars = new Set([avatar]);
    for (const participant of activeTyping) {
        if (participant?.avatar) {
            statusAvatars.add(participant.avatar);
        }
    }

    const messageParts = messages.map((message) => {
        const speakerAvatar = message?.role === 'member' ? message.extra?.member_avatar : avatar;
        if (speakerAvatar && message?.role !== 'user' && message?.role !== 'system') {
            statusAvatars.add(speakerAvatar);
        }

        return [
            message?.id || '',
            message?.role || '',
            message?.name || '',
            message?.send_date || '',
            message?.created_at || '',
            message?.mes || '',
            getConversationMessageExtraFingerprint(message),
        ].join('\u001f');
    });

    const typingPart = activeTyping
        .map(participant => `${participant?.avatar || ''}:${participant?.name || ''}`)
        .join(',');
    const statusPart = Array.from(statusAvatars)
        .filter(Boolean)
        .map(statusAvatar => `${statusAvatar}:${getEffectiveConversationStatus(statusAvatar)}`)
        .join(',');
    const settingsPart = [
        settings?.prose_polisher ? '1' : '0',
    ].join(':');

    return hashConversationRenderFingerprint([
        personaId || '',
        avatar || '',
        groupId || '',
        chatId || '',
        conversationState.conversationTimelineSearchQuery || '',
        allMessages.length,
        messages.length,
        conversationState.generationActive ? '1' : '0',
        conversationState.imageGenerationActive ? '1' : '0',
        getConversationSeenAt(avatar, { groupId, personaId }),
        settingsPart,
        typingPart,
        statusPart,
        messageParts.join('\u001e'),
    ].join('\u001d'));
}

function buildConversationMessageFingerprint(message, { avatar, groupId, personaId, settings, index }) {
    const speakerAvatar = message?.role === 'member' ? message.extra?.member_avatar : avatar;
    const speakerStatus = speakerAvatar && message?.role !== 'user' && message?.role !== 'system'
        ? getEffectiveConversationStatus(speakerAvatar)
        : '';

    return hashConversationRenderFingerprint([
        message?.id || '',
        message?.role || '',
        message?.name || '',
        message?.send_date || '',
        message?.created_at || '',
        message?.mes || '',
        personaId || '',
        getConversationMessageExtraFingerprint(message),
        getConversationMessageReceipt(message, avatar, { groupId, personaId }),
        getConversationMessageAvatar(message, avatar),
        settings?.prose_polisher ? '1' : '0',
        speakerStatus,
        index > 8 ? 'lazy' : 'eager',
    ].join('\u001f'));
}

function buildConversationMessageBaseFingerprint(message, context) {
    if (!message?.extra || typeof message.extra !== 'object' || !Object.hasOwn(message.extra, 'conversation_reactions')) {
        return buildConversationMessageFingerprint(message, context);
    }
    return buildConversationMessageFingerprint({
        ...message,
        extra: { ...message.extra, conversation_reactions: undefined },
    }, context);
}

function getConversationSelfieCommandRequests(message) {
    if (!message || ['user', 'system'].includes(message.role || '')) {
        return [];
    }

    const requests = [];
    const addRequest = (context) => {
        const text = String(context || '').trim();
        if (!requests.some(request => request.context === text)) {
            requests.push({ context: text });
        }
    };

    const storedRequests = message.extra?.conversation_commands?.selfieRequests;
    if (Array.isArray(storedRequests)) {
        storedRequests.forEach(addRequest);
    }

    const text = String(message.mes || '');
    SELFIE_COMMAND_RE.lastIndex = 0;
    let match;
    while ((match = SELFIE_COMMAND_RE.exec(text)) !== null) {
        addRequest(match[1]);
    }
    SELFIE_COMMAND_RE.lastIndex = 0;

    return requests;
}

function createConversationSelfieCommandActions(message) {
    const requests = getConversationSelfieCommandRequests(message);
    if (!requests.length) {
        return null;
    }

    const actions = document.createElement('div');
    actions.className = 'sb-conversation-selfie-actions';
    requests.forEach((request, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sb-conversation-selfie-action';
        button.dataset.sbConversationAction = 'generate-selfie-command';
        button.dataset.messageId = message.id;
        button.dataset.selfieIndex = String(index);
        button.title = request.context ? `Generate Selfie: ${request.context}` : 'Generate Selfie With Quick Image Gen';
        button.setAttribute('aria-label', button.title);
        button.innerHTML = '<span>Generate Selfie</span>';
        actions.appendChild(button);
    });

    return actions;
}

function getConversationReplyReferencePreview(reference) {
    if (!reference || typeof reference !== 'object' || !String(reference.messageId || '').trim()) {
        return '';
    }

    return truncateConversationReplyPreview(reference.text || reference.attachmentSummary);
}

function createConversationReplyReferenceElement(reference, className) {
    const previewText = getConversationReplyReferencePreview(reference);
    if (!previewText) {
        return null;
    }

    const wrapper = document.createElement('div');
    wrapper.className = className;

    const name = document.createElement('span');
    name.className = 'sb-conversation-reply-name';
    name.textContent = reference?.name || 'Speaker';

    const text = document.createElement('span');
    text.className = 'sb-conversation-reply-text';
    text.textContent = previewText;

    wrapper.append(name, text);
    return wrapper;
}

export function getActiveConversationReplyTarget(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const target = conversationState.conversationReplyTarget;
    const conversationRecord = getConversationRecord(avatar, { groupId, personaId });
    const resolvedChatId = chatId || conversationRecord?.activeChatId || '';
    if (!target) {
        return null;
    }
    if (
        target.avatar !== avatar
        || String(target.groupId || '') !== String(groupId || '')
        || String(target.personaId || '') !== String(personaId || '')
        || String(target.chatId || '') !== String(resolvedChatId)
    ) {
        conversationState.conversationReplyTarget = null;
        return null;
    }

    return target;
}

export function renderConversationComposerReplyPreview() {
    const preview = document.getElementById(CHROME_IDS.replyPreview);
    if (!(preview instanceof HTMLElement)) {
        return;
    }

    const target = getActiveConversationReplyTarget();
    preview.textContent = '';
    if (!target) {
        preview.hidden = true;
        return;
    }

    const reference = createConversationReplyReferenceElement(target, 'sb-conversation-composer-reply-card');
    if (!reference) {
        preview.hidden = true;
        return;
    }

    const label = document.createElement('span');
    label.className = 'sb-conversation-reply-label';
    label.textContent = 'Replying to';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'sb-conversation-reply-cancel fa-solid fa-xmark';
    cancel.dataset.sbConversationAction = 'clear-reply-target';
    cancel.title = 'Cancel Reply';
    cancel.setAttribute('aria-label', 'Cancel Reply');

    reference.prepend(label);
    preview.append(reference, cancel);
    preview.hidden = false;
}

export function clearConversationReplyTarget() {
    conversationState.conversationReplyTarget = null;
    renderConversationComposerReplyPreview();
}

export function consumeConversationReplyTarget(avatar = getCurrentCharAvatar(), { chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const target = getActiveConversationReplyTarget(avatar, { chatId, groupId, personaId });
    if (!target) {
        return null;
    }

    clearConversationReplyTarget();
    const reference = { ...target };
    delete reference.avatar;
    delete reference.chatId;
    delete reference.groupId;
    delete reference.personaId;
    return reference;
}

const CONVERSATION_GROUP_GAP_MS = 20 * 60 * 1000;

function getConversationMessageTimestampMs(message) {
    const createdAt = Number(message?.created_at);
    if (Number.isFinite(createdAt) && createdAt > 0) {
        return createdAt;
    }

    const sendDate = Date.parse(String(message?.send_date || ''));
    return Number.isFinite(sendDate) ? sendDate : 0;
}

function getConversationMessageDayKey(message) {
    const timestamp = getConversationMessageTimestampMs(message);
    if (!timestamp) {
        return '';
    }

    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatConversationMessageTime(message) {
    const timestamp = getConversationMessageTimestampMs(message);
    if (!timestamp) {
        return { text: '', datetime: '', title: '' };
    }

    const date = new Date(timestamp);
    return {
        text: date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        datetime: date.toISOString(),
        title: date.toLocaleString(),
    };
}

export function formatConversationDayLabel(dayKey, now = new Date()) {
    if (!dayKey) {
        return '';
    }

    const [year, month, day] = dayKey.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((today.getTime() - thatDay.getTime()) / 86400000);
    if (diffDays === 0) {
        return 'Today';
    }
    if (diffDays === 1) {
        return 'Yesterday';
    }
    if (diffDays > 1 && diffDays < 7) {
        return date.toLocaleDateString([], { weekday: 'long' });
    }

    return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function getConversationMessageSpeakerKey(message) {
    if (message?.role === 'user') {
        return 'user';
    }
    if (message?.role === 'system') {
        return `system:${message?.id || ''}`;
    }

    return `${message?.role || 'character'}:${message?.extra?.member_avatar || message?.name || ''}`;
}

function messagesShareConversationGroup(current, previous) {
    if (!current || !previous || current.role === 'system' || previous.role === 'system') {
        return false;
    }
    if (getConversationMessageSpeakerKey(current) !== getConversationMessageSpeakerKey(previous)) {
        return false;
    }
    if (getConversationMessageDayKey(current) !== getConversationMessageDayKey(previous)) {
        return false;
    }

    const currentTime = getConversationMessageTimestampMs(current);
    const previousTime = getConversationMessageTimestampMs(previous);
    if (!currentTime || !previousTime) {
        return true;
    }

    return currentTime - previousTime <= CONVERSATION_GROUP_GAP_MS;
}

function getConversationGroupPosition(continuesPrevious, continuesNext) {
    if (continuesPrevious && continuesNext) {
        return 'middle';
    }
    if (continuesPrevious) {
        return 'end';
    }
    if (continuesNext) {
        return 'start';
    }
    return 'single';
}

/**
 * @param {object[]} messages
 * @param {{ breaksAfter?: Set<string> }} [options] The ids of messages that a line of the timeline follows. A line ends a group, as a day divider does, so the message after it shows its header again.
 */
export function getConversationTimelineGroupMeta(messages, { breaksAfter = new Set() } = {}) {
    return (Array.isArray(messages) ? messages : []).map((message, index, list) => {
        const continuesPrevious = !breaksAfter.has(list[index - 1]?.id) && messagesShareConversationGroup(message, list[index - 1]);
        const continuesNext = !breaksAfter.has(message?.id) && messagesShareConversationGroup(list[index + 1], message);
        return {
            position: getConversationGroupPosition(continuesPrevious, continuesNext),
            showHeader: !continuesPrevious,
            dayKey: getConversationMessageDayKey(message),
            time: formatConversationMessageTime(message),
        };
    });
}

function createConversationDayDivider(dayKey) {
    const divider = document.createElement('div');
    divider.className = 'sb-conversation-day-divider';
    divider.dataset.dayKey = dayKey;
    const label = document.createElement('span');
    label.textContent = formatConversationDayLabel(dayKey);
    divider.append(label);
    return divider;
}

function stripConversationDayDividers(timeline) {
    timeline.querySelectorAll('.sb-conversation-day-divider').forEach(node => node.remove());
}

function insertConversationDayDividers(timeline, messages) {
    stripConversationDayDividers(timeline);
    let previousDayKey = '';
    for (const message of messages) {
        const dayKey = getConversationMessageDayKey(message);
        if (!dayKey || dayKey === previousDayKey) {
            previousDayKey = dayKey || previousDayKey;
            continue;
        }

        previousDayKey = dayKey;
        const node = timeline.querySelector(`.sb-conversation-message[data-message-id="${CSS.escape(String(message.id || ''))}"]`);
        node?.before(createConversationDayDivider(dayKey));
    }
}

function createConversationMessageElement(message, { avatar, groupId, settings, index, fingerprint, baseFingerprint }) {
    const item = document.createElement('article');
    item.className = 'sb-conversation-message';
    item.dataset.role = message.role || 'character';
    item.dataset.messageId = message.id;
    item.dataset.pinned = String(isPinned(message));
    item.dataset.sbConversationMessageFingerprint = fingerprint;
    if (baseFingerprint) {
        item.dataset.sbConversationMessageBaseFingerprint = baseFingerprint;
    }

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'sb-conversation-message-avatar';
    const messageAvatar = message.role === 'user'
        ? ''
        : message.role === 'member' || message.role === 'system'
            ? message.extra?.member_avatar || avatar
            : avatar;
    if (message.role !== 'user' && messageAvatar) {
        avatarWrap.dataset.sbConversationAction = 'zoom-avatar';
        avatarWrap.dataset.avatarFile = messageAvatar;
        avatarWrap.tabIndex = 0;
        avatarWrap.role = 'button';
        avatarWrap.setAttribute('aria-label', `Show Full Picture for ${message.name || getCurrentCharName()}`);
    }
    if (message.role !== 'user') {
        const image = document.createElement('img');
        image.alt = '';
        image.loading = index > 8 ? 'lazy' : 'eager';
        image.src = getConversationMessageAvatar(message, avatar);
        avatarWrap.appendChild(image);

        if (messageAvatar && message.role !== 'system') {
            const statusDot = document.createElement('span');
            statusDot.className = 'sb-conversation-status-dot';
            statusDot.dataset.status = getEffectiveConversationStatus(messageAvatar);
            statusDot.setAttribute('aria-hidden', 'true');
            avatarWrap.appendChild(statusDot);
        }
    } else {
        avatarWrap.setAttribute('aria-hidden', 'true');
    }

    const bubble = document.createElement('div');
    bubble.className = 'sb-conversation-message-bubble';

    const meta = document.createElement('div');
    meta.className = 'sb-conversation-message-meta';
    const name = document.createElement('span');
    name.className = 'sb-conversation-message-name';
    name.textContent = message.name || (message.role === 'user' ? name1 || 'You' : getCurrentCharName());
    const time = document.createElement('time');
    time.className = 'sb-conversation-message-time';
    const formattedTime = formatConversationMessageTime(message);
    time.textContent = formattedTime.text;
    if (formattedTime.datetime) {
        time.dateTime = formattedTime.datetime;
        time.title = formattedTime.title;
    }
    meta.append(name, time);

    // SillyBunny message actions: reactions | Reply, Edit, Copy, menu
    // at rest; data-sb-secondary items join in section order when the pill is expanded.
    const actionBar = document.createElement('span');
    actionBar.className = 'sb-conversation-message-actions';
    actionBar.append(...createToolbarReactionButtons(message));

    const isCharacterMessage = !['user', 'system'].includes(message.role || '');
    const actionSections = [
        [
            { action: 'reply-message', icon: 'fa-reply', label: 'Reply' },
            { action: 'edit-message', icon: 'fa-pencil', label: 'Edit Conversation Message', className: 'sb-conversation-message-edit' },
            settings.prose_polisher && message.role !== 'user' && { action: 'polish-character-message', icon: 'fa-wand-magic-sparkles', label: 'Polish Character Message', className: 'sb-conversation-message-polish', secondary: true },
        ],
        [
            { action: 'copy-message', icon: 'fa-copy', label: 'Copy Message' },
            { action: 'select-message', icon: 'fa-square-check', label: 'Select Message', secondary: true, menuOnly: true },
            { action: 'toggle-message-pin', icon: 'fa-thumbtack', label: isPinned(message) ? 'Unpin Message' : 'Pin Message', secondary: true },
            { action: 'branch-from-message', icon: 'fa-code-branch', label: 'Branch From Here', secondary: true },
        ],
        isCharacterMessage ? [
            { action: 'speak-message', icon: 'fa-volume-high', label: 'Speak', secondary: true },
            { action: 'regenerate-message', icon: 'fa-rotate-right', label: 'Regenerate Message', secondary: true },
        ] : [],
        [{ action: 'delete-message', icon: 'fa-trash-can', label: 'Delete Message', secondary: true }],
    ].map(section => section.filter(Boolean)).filter(section => section.length);

    const appendDivider = (secondary) => {
        const divider = document.createElement('span');
        divider.className = 'sb-conversation-message-divider';
        divider.setAttribute('aria-hidden', 'true');
        if (secondary) {
            divider.dataset.sbSecondary = '';
        }
        actionBar.appendChild(divider);
    };
    appendDivider(false);
    actionSections.forEach((section, index) => {
        if (index > 0) {
            appendDivider(true);
        }
        for (const messageAction of section) {
            const actionButton = document.createElement('button');
            actionButton.type = 'button';
            actionButton.className = `sb-conversation-message-action fa-solid ${messageAction.icon}`;
            if (messageAction.className) {
                actionButton.classList.add(messageAction.className);
            }
            actionButton.title = messageAction.label;
            actionButton.setAttribute('aria-label', messageAction.label);
            actionButton.dataset.sbConversationAction = messageAction.action;
            actionButton.dataset.messageId = message.id;
            actionButton.dataset.sbSection = String(index);
            if (messageAction.secondary) {
                actionButton.dataset.sbSecondary = '';
            }
            if (messageAction.menuOnly) {
                actionButton.dataset.sbMenuOnly = '';
            }
            actionBar.appendChild(actionButton);
        }
    });
    appendDivider(true);

    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'sb-conversation-message-action sb-conversation-message-menu fa-solid fa-ellipsis-vertical';
    menuButton.title = 'Message Actions';
    menuButton.setAttribute('aria-label', 'Message Actions');
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.dataset.sbConversationMenu = '';
    menuButton.dataset.messageId = message.id;
    actionBar.appendChild(menuButton);

    const mobileTrigger = document.createElement('button');
    mobileTrigger.type = 'button';
    mobileTrigger.className = 'sb-conversation-mobile-menu-trigger fa-solid fa-ellipsis-vertical';
    mobileTrigger.title = 'Message Actions';
    mobileTrigger.setAttribute('aria-label', 'Message Actions');
    mobileTrigger.setAttribute('aria-haspopup', 'menu');
    mobileTrigger.setAttribute('aria-expanded', 'false');
    mobileTrigger.dataset.sbConversationMenu = '';
    mobileTrigger.dataset.messageId = message.id;

    const text = document.createElement('div');
    text.className = 'sb-conversation-message-text';
    if (message.mes) {
        text.innerHTML = messageFormatting(message.mes, message.name, false, message.role === 'user', -1, {}, false);
        highlightConversationMentions(text, avatar);
    }

    const replyReference = createConversationReplyReferenceElement(
        message.extra?.conversation_reply_to,
        'sb-conversation-message-reply-preview',
    );

    const imageUrl = toSafeAttachmentUrl(message.extra?.image_url, { allowDataImage: true });
    if (imageUrl) {
        const figure = document.createElement('figure');
        figure.className = 'sb-conversation-image-preview';
        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = message.extra?.image_prompt || 'Generated image';
        img.loading = 'lazy';
        figure.appendChild(img);
        text.appendChild(figure);
    }

    renderConversationAttachments(text, message);

    const selfieActions = createConversationSelfieCommandActions(message);
    if (selfieActions) {
        text.appendChild(selfieActions);
    }

    const reactions = createReactionChips(message);

    const receiptText = getConversationMessageReceipt(message, avatar, { groupId });
    let receipt = null;
    if (receiptText) {
        receipt = document.createElement('span');
        receipt.className = 'sb-conversation-message-receipt';
        receipt.textContent = receiptText;
    }

    if (replyReference) {
        bubble.append(replyReference, text);
    } else {
        bubble.append(text);
    }
    const content = document.createElement('div');
    content.className = 'sb-conversation-message-content';
    content.append(bubble, actionBar);
    const body = document.createElement('div');
    body.className = 'sb-conversation-message-body';
    body.append(meta, content);
    if (isPinned(message)) {
        body.append(createPinnedMark());
    }
    if (reactions) {
        body.append(reactions);
    }
    if (receipt) {
        body.append(receipt);
    }
    item.append(avatarWrap, body, mobileTrigger);
    return item;
}

function createConversationTransientRow({ role, avatarSrc, nameHtml, textHtml, extraClass = '' }) {
    const item = document.createElement('div');
    item.className = `sb-conversation-message ${extraClass}`.trim();
    item.dataset.role = role;
    item.dataset.groupPosition = 'single';
    item.dataset.showHeader = 'true';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'sb-conversation-message-avatar';
    const image = document.createElement('img');
    image.alt = '';
    image.src = avatarSrc;
    avatarWrap.appendChild(image);

    const bubble = document.createElement('div');
    bubble.className = 'sb-conversation-message-bubble';
    bubble.innerHTML = textHtml;
    const body = document.createElement('div');
    body.className = 'sb-conversation-message-body';
    const meta = document.createElement('div');
    meta.className = 'sb-conversation-message-meta';
    meta.innerHTML = `<span class="sb-conversation-message-name">${nameHtml}</span>`;
    body.append(meta, bubble);
    item.append(avatarWrap, body);
    return item;
}

/** The timeline's empty and unavailable states are the shared status page; the class marks it for `removeTimelineTransientNodes`. */
function createConversationStatusPage(values) {
    const { element } = createStatusPage(values);
    element.classList.add('sb-conversation-timeline-empty');
    return element;
}

function removeTimelineTransientNodes(timeline) {
    timeline.querySelectorAll('.sb-conversation-timeline-empty, .sb-conversation-typing-indicator, .sb-conversation-image-pending').forEach(node => node.remove());
}

function requestConversationFrame(callback) {
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(callback);
        return;
    }

    setTimeout(callback, 0);
}

let timelineBottomScrollToken = 0;

function scrollConversationTimelineToBottom(timeline) {
    timeline.scrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
}

function anchorConversationTimelineToBottom(timeline, renderConversationKey) {
    const token = ++timelineBottomScrollToken;
    const applyScroll = () => {
        if (token !== timelineBottomScrollToken || !timeline.isConnected || conversationState.lastRenderedConversationKey !== renderConversationKey) {
            return false;
        }

        scrollConversationTimelineToBottom(timeline);
        return true;
    };

    applyScroll();
    requestConversationFrame(() => {
        if (!applyScroll()) {
            return;
        }

        requestConversationFrame(applyScroll);
    });
    setTimeout(applyScroll, 75);
    setTimeout(applyScroll, 250);
}

function findPreferredMenuTrigger(node) {
    const mobile = node.querySelector('.sb-conversation-mobile-menu-trigger');
    const desktop = node.querySelector('.sb-conversation-message-menu');
    const ordered = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)')?.matches
        ? [mobile, desktop]
        : [desktop, mobile];
    for (const candidate of ordered) {
        if (candidate instanceof HTMLElement && getComputedStyle(candidate).display !== 'none') {
            return candidate;
        }
    }
    return ordered.find(candidate => candidate instanceof HTMLElement) || null;
}

function findReactionChipFocusTarget(nextNode, reaction, previousIndex) {
    const chips = [...nextNode.querySelectorAll('.sb-conversation-message-reaction-chip')];
    const matching = chips.find(chip => chip.dataset.reaction === reaction);
    if (matching) {
        return matching;
    }
    if (chips.length) {
        return chips[Math.max(0, Math.min(previousIndex, chips.length - 1))];
    }
    return findPreferredMenuTrigger(nextNode);
}

function findReplacementFocusTarget(currentNode, nextNode) {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && currentNode.contains(active)
        ? active
        : currentNode.querySelector(':focus');
    if (!(focused instanceof HTMLElement)) {
        return null;
    }
    if (focused.hasAttribute('data-sb-conversation-menu')) {
        const selector = focused.classList.contains('sb-conversation-mobile-menu-trigger')
            ? '.sb-conversation-mobile-menu-trigger'
            : '.sb-conversation-message-menu';
        return nextNode.querySelector(selector);
    }
    if (focused.classList.contains('sb-conversation-message-reaction-chip')) {
        const previousChips = [...currentNode.querySelectorAll('.sb-conversation-message-reaction-chip')];
        return findReactionChipFocusTarget(nextNode, focused.dataset.reaction || '', previousChips.indexOf(focused));
    }
    if (focused.classList.contains('sb-conversation-reaction-more')) {
        return nextNode.querySelector('.sb-conversation-reaction-more');
    }
    if (focused.classList.contains('sb-conversation-reaction-button')) {
        const reaction = focused.dataset.reaction || '';
        const nextButtons = [...nextNode.querySelectorAll('.sb-conversation-reaction-button:not(.sb-conversation-reaction-more)')];
        const matching = nextButtons.find(button => button.dataset.reaction === reaction);
        if (matching) {
            return matching;
        }
        const previousButtons = [...currentNode.querySelectorAll('.sb-conversation-reaction-button:not(.sb-conversation-reaction-more)')];
        const index = previousButtons.indexOf(focused);
        return nextButtons[index] || nextNode.querySelector('.sb-conversation-reaction-more');
    }
    const action = focused.dataset.sbConversationAction;
    if (action) {
        const selfieIndex = focused.dataset.selfieIndex;
        const selector = selfieIndex !== undefined
            ? `[data-sb-conversation-action="${CSS.escape(action)}"][data-selfie-index="${CSS.escape(selfieIndex)}"]`
            : `[data-sb-conversation-action="${CSS.escape(action)}"]`;
        return nextNode.querySelector(selector);
    }
    return null;
}

/**
 * Updates only the reaction chips and toolbar quick-reaction buttons on an existing message node so an open reaction
 * popover (such as More Reactions with Shift+Click) keeps its trigger connected and its open-menu class intact.
 */
function updateMessageReactionsInPlace(node, message, fingerprint) {
    const active = document.activeElement;
    const focusedChip = active instanceof HTMLElement && node.contains(active) && active.classList.contains('sb-conversation-message-reaction-chip')
        ? active
        : node.querySelector('.sb-conversation-message-reaction-chip:focus');
    const focusedReaction = focusedChip instanceof HTMLElement ? focusedChip.dataset.reaction || '' : '';
    const focusedChipIndex = focusedChip instanceof HTMLElement
        ? [...node.querySelectorAll('.sb-conversation-message-reaction-chip')].indexOf(focusedChip)
        : -1;

    const body = node.querySelector('.sb-conversation-message-body');
    if (body) {
        const oldRow = body.querySelector(':scope > .sb-conversation-message-reactions');
        const nextRow = createReactionChips(message);
        if (oldRow && nextRow) {
            oldRow.replaceWith(nextRow);
        } else if (oldRow) {
            oldRow.remove();
        } else if (nextRow) {
            const receipt = body.querySelector(':scope > .sb-conversation-message-receipt');
            if (receipt) {
                receipt.before(nextRow);
            } else {
                body.append(nextRow);
            }
        }
    }

    const freshButtons = createToolbarReactionButtons(message).filter(button => !button.classList.contains('sb-conversation-reaction-more'));
    const existingButtons = node.querySelectorAll('.sb-conversation-message-actions > .sb-conversation-reaction-button:not(.sb-conversation-reaction-more)');
    existingButtons.forEach((button, idx) => {
        const fresh = freshButtons[idx];
        if (!fresh) {
            return;
        }
        if (button.dataset.reaction !== fresh.dataset.reaction) {
            button.textContent = fresh.textContent;
            button.dataset.reaction = fresh.dataset.reaction;
            button.title = fresh.title;
            button.setAttribute('aria-label', fresh.getAttribute('aria-label') || '');
        }
        button.setAttribute('aria-pressed', fresh.getAttribute('aria-pressed') || 'false');
    });

    node.dataset.sbConversationMessageFingerprint = fingerprint;
    return focusedChip ? findReactionChipFocusTarget(node, focusedReaction, focusedChipIndex) : null;
}

function reconcileConversationMessageNodes(timeline, messages, { avatar, groupId, personaId, settings, breaksAfter }) {
    const existingNodes = new Map();
    timeline.querySelectorAll('.sb-conversation-message[data-message-id]').forEach((node) => {
        if (node instanceof HTMLElement && !node.classList.contains('sb-conversation-typing-indicator') && !node.classList.contains('sb-conversation-image-pending')) {
            existingNodes.set(node.dataset.messageId || '', node);
        }
    });

    const grouping = getConversationTimelineGroupMeta(messages, { breaksAfter });
    messages.forEach((message, index) => {
        const messageId = String(message?.id || '');
        const fingerprintContext = { avatar, groupId, personaId, settings, index };
        const fingerprint = buildConversationMessageFingerprint(message, fingerprintContext);
        const baseFingerprint = buildConversationMessageBaseFingerprint(message, fingerprintContext);
        const currentNode = existingNodes.get(messageId) || null;
        let nextNode = currentNode;
        let focusTarget = null;
        if (!nextNode || nextNode.dataset.sbConversationMessageFingerprint !== fingerprint) {
            if (currentNode && currentNode.dataset.sbConversationMessageBaseFingerprint === baseFingerprint) {
                focusTarget = updateMessageReactionsInPlace(currentNode, message, fingerprint);
                nextNode = currentNode;
            } else {
                nextNode = createConversationMessageElement(message, { avatar, groupId, settings, index, fingerprint, baseFingerprint });
                if (currentNode) {
                    if (currentNode.classList.contains('has-open-menu')) {
                        nextNode.classList.add('has-open-menu');
                    }
                    focusTarget = findReplacementFocusTarget(currentNode, nextNode);
                    currentNode.replaceWith(nextNode);
                }
            }
        }

        existingNodes.delete(messageId);
        const referenceNode = timeline.children[index] || null;
        if (nextNode !== referenceNode) {
            timeline.insertBefore(nextNode, referenceNode);
        }
        const meta = grouping[index];
        if (meta) {
            nextNode.dataset.groupPosition = meta.position;
            if (meta.showHeader) {
                nextNode.dataset.showHeader = 'true';
            } else {
                nextNode.removeAttribute('data-show-header');
            }
        }
        focusTarget?.focus({ preventScroll: true });
    });

    existingNodes.forEach(node => node.remove());
}

export function renderConversationTimeline() {
    const timeline = document.getElementById(CHROME_IDS.timeline);
    const avatar = getCurrentCharAvatar();
    const personaId = getConversationPersonaId();
    if (!(timeline instanceof HTMLElement)) {
        return;
    }

    const previousScrollTop = timeline.scrollTop;
    const previousScrollBottom = timeline.scrollHeight - previousScrollTop - timeline.clientHeight;
    const previousConversationKey = conversationState.lastRenderedConversationKey || '';
    const previousMessageCount = conversationState.lastRenderedMessageCount;

    if (!avatar) {
        const unavailableGroup = conversationState.conversationUnavailableGroupId
            ? getConversationGroupById(conversationState.conversationUnavailableGroupId)
            : null;
        const fingerprint = unavailableGroup ? `no-avatar:${personaId}:${unavailableGroup.id}` : `no-avatar:${personaId}`;
        if (fingerprint === conversationState.lastTimelineFingerprint && timeline.dataset.sbConversationFingerprint === fingerprint) {
            updateConversationToolsState();
            return;
        }

        conversationState.lastTimelineFingerprint = fingerprint;
        timeline.dataset.sbConversationFingerprint = fingerprint;
        timeline.replaceChildren(createConversationStatusPage(unavailableGroup
            ? {
                state: 'unavailable',
                icon: 'user-group',
                title: 'No Conversation Members Available',
                description: `${unavailableGroup.name || 'This group'} does not currently have any eligible Conversation members. Add or enable a member, then try again.`,
            }
            : { state: 'empty', icon: 'comments', title: 'Choose a Conversation' }));
        conversationState.lastRenderedAvatar = null;
        conversationState.lastRenderedConversationKey = '';
        conversationState.lastRenderedMessageCount = 0;
        conversationState.timelineBottomScrollPending = false;
        updateConversationToolsState();
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId, personaId });
    const allMessages = getConversationMessages(avatar, { groupId, personaId });
    const messages = getConversationTimelineMessages(allMessages);
    const chatId = getConversationRenderChatId(avatar, groupId, personaId);
    const renderConversationKey = buildConversationRenderKey(avatar, groupId, chatId, personaId);
    const contextChanged = previousConversationKey !== renderConversationKey;
    // The chat of a conversation is read from the server when the conversation is opened.
    const openChat = getActiveConversationChat(avatar, { chatId, groupId, personaId });
    if (openChat && !openChat.loaded) {
        const loadingFingerprint = `loading:${renderConversationKey}`;
        if (timeline.dataset.sbConversationFingerprint !== loadingFingerprint) {
            conversationState.lastTimelineFingerprint = loadingFingerprint;
            timeline.dataset.sbConversationFingerprint = loadingFingerprint;
            timeline.replaceChildren(createConversationStatusPage({ state: 'loading', icon: 'message', title: 'Loading' }));
            conversationState.lastRenderedAvatar = avatar;
            conversationState.lastRenderedConversationKey = renderConversationKey;
            conversationState.lastRenderedMessageCount = 0;
        }
        updateConversationToolsState();
        return;
    }
    const messagesAdded = allMessages.length > previousMessageCount;
    const isNearBottom = previousScrollBottom <= 150;
    const needsBottomScroll = Boolean(conversationState.timelineBottomScrollPending);
    const fingerprint = buildTimelineFingerprint({ avatar, groupId, chatId, personaId, settings, allMessages, messages });
    if (!contextChanged && fingerprint === conversationState.lastTimelineFingerprint && timeline.dataset.sbConversationFingerprint === fingerprint) {
        updateConversationToolsState();
        if (needsBottomScroll) {
            conversationState.timelineBottomScrollPending = false;
            anchorConversationTimelineToBottom(timeline, renderConversationKey);
        }
        return;
    }

    conversationState.lastTimelineFingerprint = fingerprint;
    timeline.dataset.sbConversationFingerprint = fingerprint;
    let detachedPinRows = { rows: new Map(), focused: null };
    if (contextChanged) {
        timeline.textContent = '';
    } else {
        stripConversationDayDividers(timeline);
        removeTimelineTransientNodes(timeline);
        detachedPinRows = detachPinEventRows(timeline);
    }

    if (!allMessages.length) {
        timeline.replaceChildren(createConversationStatusPage({
            state: 'empty',
            icon: 'message',
            title: 'No Messages Yet',
            description: 'Type a message to begin chatting with this character!',
        }));
        conversationState.lastRenderedAvatar = avatar;
        conversationState.lastRenderedConversationKey = renderConversationKey;
        conversationState.lastRenderedMessageCount = allMessages.length;
        conversationState.timelineBottomScrollPending = false;
        updateConversationToolsState();
        if (contextChanged || messagesAdded || isNearBottom || needsBottomScroll) {
            anchorConversationTimelineToBottom(timeline, renderConversationKey);
        } else {
            timeline.scrollTop = previousScrollTop;
        }
        return;
    }

    if (!messages.length) {
        timeline.replaceChildren(createConversationStatusPage({
            state: 'no-results',
            title: 'No Matching Messages',
        }));
        conversationState.lastRenderedAvatar = avatar;
        conversationState.lastRenderedConversationKey = renderConversationKey;
        conversationState.lastRenderedMessageCount = allMessages.length;
        conversationState.timelineBottomScrollPending = false;
        updateConversationToolsState();
        return;
    }

    // A search shows the messages that match and not the course of the chat, so it shows no line between them.
    const pinEvents = conversationState.conversationTimelineSearchQuery ? [] : getPinEvents(messages, getConversationMessageTimestampMs);
    const breaksAfter = new Set(pinEvents.map(event => event.afterMessageId));
    reconcileConversationMessageNodes(timeline, messages, { avatar, groupId, personaId, settings, breaksAfter });
    insertConversationDayDividers(timeline, messages);
    placePinEventRows(timeline, pinEvents, detachedPinRows);

    const typingParticipants = getActiveTypingParticipants(avatar, { chatId, groupId, personaId });
    if (typingParticipants.length > 2) {
        timeline.appendChild(createConversationTransientRow({
            role: 'member',
            extraClass: 'sb-conversation-typing-indicator',
            avatarSrc: getThumbnailUrl('avatar', typingParticipants[0]?.avatar) || default_user_avatar,
            nameHtml: 'Several people',
            textHtml: `
                <div class="sb-conversation-message-text sb-conversation-typing-copy">
                    <span>Several people are typing</span>
                    <span class="sb-conversation-typing-dots"><span></span><span></span><span></span></span>
                </div>
            `,
        }));
    } else {
        for (const typingParticipant of typingParticipants) {
            const typingAvatar = typingParticipant?.avatar || getCurrentCharAvatar();
            const typingName = typingParticipant?.name || getCurrentCharName();
            timeline.appendChild(createConversationTransientRow({
                role: typingAvatar !== getCurrentCharAvatar() ? 'member' : 'character',
                extraClass: 'sb-conversation-typing-indicator',
                avatarSrc: getThumbnailUrl('avatar', typingAvatar) || default_user_avatar,
                nameHtml: escapeHtmlText(typingName),
                textHtml: '<div class="sb-conversation-message-text sb-conversation-typing-dots"><span></span><span></span><span></span></div>',
            }));
        }
    }

    if (conversationState.imageGenerationActive) {
        const pendingParticipant = getPrimaryTypingParticipant(avatar, { chatId, groupId, personaId });
        const pendingAvatar = pendingParticipant?.avatar || getCurrentCharAvatar();
        timeline.appendChild(createConversationTransientRow({
            role: pendingParticipant && pendingAvatar !== getCurrentCharAvatar() ? 'member' : 'character',
            extraClass: 'sb-conversation-image-pending',
            avatarSrc: getThumbnailUrl('avatar', pendingAvatar) || default_user_avatar,
            nameHtml: 'Image Generation',
            textHtml: `
                <div class="sb-conversation-message-text sb-conversation-typing-dots"><span></span><span></span><span></span></div>
                <button type="button" class="sb-conversation-stop-image" data-sb-conversation-action="stop-image-generation">Stop</button>
            `,
        }));
    }

    conversationState.lastRenderedAvatar = avatar;
    conversationState.lastRenderedConversationKey = renderConversationKey;
    conversationState.lastRenderedMessageCount = allMessages.length;
    conversationState.timelineBottomScrollPending = false;
    updateConversationToolsState();
    if (contextChanged || messagesAdded || isNearBottom || needsBottomScroll) {
        anchorConversationTimelineToBottom(timeline, renderConversationKey);
    } else {
        timeline.scrollTop = previousScrollTop;
    }
}

export function updateConversationToolsState() {
    renderConversationComposerReplyPreview();

    const tools = document.getElementById(CHROME_IDS.tools);
    if (!(tools instanceof HTMLElement)) {
        return;
    }

    const searchOpen = isConversationSearchBarOpen();
    tools.dataset.open = String(searchOpen);
    tools.inert = !searchOpen;
    const searchToggle = document.querySelector(`#${CHROME_IDS.header} [data-sb-conversation-action="toggle-search"]`);
    if (searchToggle instanceof HTMLElement) {
        searchToggle.setAttribute('aria-pressed', String(searchOpen));
    }

    const searchInput = document.getElementById(CHROME_IDS.search);
    if (searchInput instanceof HTMLInputElement && searchInput.value !== conversationState.conversationTimelineSearchQuery) {
        searchInput.value = conversationState.conversationTimelineSearchQuery;
    }
}

export function isConversationSearchBarOpen() {
    return Boolean(conversationState.conversationSearchOpen) || Boolean(conversationState.conversationTimelineSearchQuery);
}

export function toggleConversationSearchBar(open = !isConversationSearchBarOpen()) {
    if (!open) {
        conversationState.conversationSearchOpen = false;
        conversationState.conversationTimelineSearchQuery = '';
        const searchInput = document.getElementById(CHROME_IDS.search);
        if (searchInput instanceof HTMLInputElement) {
            searchInput.value = '';
        }
        updateConversationToolsState();
        scheduleTimelineRender();
        return;
    }

    conversationState.conversationSearchOpen = true;
    updateConversationToolsState();
    document.getElementById(CHROME_IDS.search)?.focus?.({ preventScroll: true });
}

export function updateConversationSearchQuery(value) {
    conversationState.conversationTimelineSearchQuery = String(value || '').trim();
    scheduleTimelineRender();
}

export function getConversationMessageById(messageId, { avatar = getCurrentCharAvatar(), chatId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar || !messageId) {
        return null;
    }

    const conversationRecord = getConversationRecord(avatar, { groupId, personaId });
    const resolvedChatId = chatId || conversationRecord?.activeChatId || '';
    const messages = getConversationMessages(avatar, { chatId: resolvedChatId, create: false, groupId, personaId });
    const message = messages.find(item => item.id === messageId);
    return message ? { avatar, chatId: resolvedChatId, groupId, messages, message, personaId } : null;
}

export function saveConversationContextMessages(context, { shrink = false } = {}) {
    if (!context?.avatar) {
        return;
    }

    saveConversationMessages(context.avatar, context.messages, {
        chatId: context.chatId,
        groupId: context.groupId,
        personaId: context.personaId,
        shrink,
    });
    scheduleTimelineRender();
}

export function replyToConversationMessage(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context || !context.message) {
        return;
    }

    const input = document.getElementById(CHROME_IDS.input);
    if (!(input instanceof HTMLTextAreaElement)) {
        return;
    }

    const reference = buildConversationMessageReplyReference(context.message);
    if (!reference) {
        return;
    }

    conversationState.conversationReplyTarget = {
        ...reference,
        avatar: context.avatar,
        chatId: context.chatId,
        groupId: context.groupId || '',
        personaId: context.personaId,
    };
    renderConversationComposerReplyPreview();
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
}

export async function copyConversationMessage(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context) {
        return;
    }

    const payload = context.message.mes || getConversationAttachmentSummary(context.message) || '';
    if (!payload) {
        return;
    }

    try {
        await navigator.clipboard.writeText(payload);
        globalThis.toastr?.success?.('Message copied');
    } catch {
        globalThis.toastr?.warning?.('Could not copy message text');
    }
}

export async function speakConversationMessage(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context) {
        return;
    }

    await narrateConversationMessage(context.message, { manual: true, force: true });
}

export function toggleConversationMessagePin(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context) {
        return;
    }

    setMessagePin(context.message, !isPinned(context.message));
    saveConversationContextMessages(context);
}

/**
 * Deletes messages of the open chat in one commit. Besides the messages it keeps the composer, the read marker and the
 * send queue free of references to them.
 * @param {string[]} messageIds
 * @returns {string[]} The ids that were deleted.
 */
export function deleteConversationMessages(messageIds) {
    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const personaId = getConversationPersonaId();
    const address = avatar ? conversationData.resolve({ avatar, groupId, personaId }) : null;
    if (!address) {
        return [];
    }

    const removed = removeChatMessages(conversationData, address, messageIds);
    if (!removed.length) {
        return [];
    }

    const replyTarget = conversationState.conversationReplyTarget;
    if (replyTarget && removed.includes(replyTarget.messageId)) {
        clearConversationReplyTarget();
    }
    dropQueueItemsOfDeletedMessages(sendQueue, { chatId: address.chatId, messageIds: removed });
    scheduleTimelineRender();
    return removed;
}

export function deleteConversationMessage(messageId) {
    deleteConversationMessages([messageId]);
}

export async function regenerateConversationMessage(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context || ['user', 'system'].includes(context.message.role || '')) {
        return;
    }

    const index = context.messages.findIndex(item => item.id === messageId);
    if (index < 0) {
        return;
    }

    const speakerAvatar = context.message.extra?.member_avatar || context.avatar;
    const settings = getSettings(speakerAvatar, { groupId: context.groupId, personaId: context.personaId });
    const speakerName = context.message.name || getCharacterForAvatar(speakerAvatar)?.name || getCurrentCharName();
    const operationKey = [context.personaId, context.avatar, context.groupId, context.chatId, messageId].join('\u001f');
    if (regenerationBusyKeys.has(operationKey)) {
        return;
    }

    const sourceMessages = context.messages.slice(0, index + 1);
    const sourceRevision = getConversationMessagesRevision(sourceMessages);
    regenerationBusyKeys.add(operationKey);
    const operation = beginConversationGenerationOperation();
    scheduleInterfaceRefresh();

    try {
        const transcript = sourceMessages.slice(0, -1);
        const worldInfo = await getConversationWorldInfo(transcript, settings, {
            avatar: speakerAvatar,
            personaId: context.personaId,
            trigger: 'regenerate',
        });
        const prompt = await buildConversationPromptMessages(
            transcript,
            '[System directive: Regenerate the selected Conversation reply. Keep the same speaker, casual DM style, and current context. Output only the replacement message.]',
            speakerName,
            { groupId: context.groupId, personaId: context.personaId, worldInfo },
        );
        const response = await withTypingParticipant(
            { avatar: speakerAvatar, name: speakerName },
            () => generateConversationRaw({
                prompt,
                systemPrompt: buildConversationSystemPrompt(settings, speakerAvatar, {
                    anchorAvatar: context.avatar,
                    chatId: context.chatId,
                    groupId: context.groupId,
                    personaId: context.personaId,
                    worldInfo,
                }),
                trimNames: true,
                cacheScope: 'conversation-mode',
            }, settings),
            context.avatar,
            { chatId: context.chatId, groupId: context.groupId, personaId: context.personaId },
        );

        if (!String(response || '').trim()) {
            globalThis.toastr?.warning?.('Regenerate returned no message');
            return;
        }

        const targetContext = getConversationMessageById(messageId, {
            avatar: context.avatar,
            chatId: context.chatId,
            groupId: context.groupId,
            personaId: context.personaId,
        });
        const targetIndex = targetContext?.messages.findIndex(message => message.id === messageId) ?? -1;
        if (!targetContext || targetIndex < 0 || getConversationMessagesRevision(targetContext.messages.slice(0, targetIndex + 1)) !== sourceRevision) {
            return;
        }

        const commandParts = extractCharacterReplyCommands(response, settings);
        if (!commandParts.text) {
            globalThis.toastr?.warning?.('Regenerate returned no message');
            return;
        }
        const extra = { ...targetContext.message.extra };
        delete extra.conversation_commands;
        const commandMetadata = getCharacterReplyCommandMetadata(commandParts);
        if (commandMetadata) {
            extra.conversation_commands = commandMetadata;
        }
        targetContext.message.mes = commandParts.text;
        targetContext.message.extra = { ...extra, regenerated_at: Date.now() };
        saveConversationContextMessages(targetContext);
        commitCharacterReplyCommands(commandParts, speakerAvatar, {
            chatId: context.chatId,
            groupId: context.groupId,
            personaId: context.personaId,
            reminderAvatar: context.avatar,
        });
        globalThis.toastr?.success?.('Message regenerated');
    } catch (error) {
        reportConversationGenerationError('regenerate', error, { level: 'warning' });
    } finally {
        regenerationBusyKeys.delete(operationKey);
        endConversationGenerationOperation(operation);
        scheduleInterfaceRefresh();
    }
}

export async function branchConversationFromMessage(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context) {
        return;
    }

    const store = getConversationRecord(context.avatar, { groupId: context.groupId, personaId: context.personaId });
    if (!store || !context.messages.some(item => item.id === messageId)) {
        return;
    }

    // The server writes the messages as the first save of the new chat, so a crash cannot leave a listed chat that is empty.
    let created;
    try {
        created = await conversationData.branchChat({ conversationId: store.id, chatId: context.chatId }, messageId, { name: `Chat ${getConversationChats(context.avatar, { groupId: context.groupId }).length + 1}`, activate: true });
    } catch (error) {
        console.error('Conversation Mode: the chat could not be branched', error);
        globalThis.toastr?.error?.('The chat could not be branched');
        return;
    }
    const chat = { id: created.address.chatId };
    window.dispatchEvent(new CustomEvent('sb:open-conversation-workspace', {
        detail: {
            avatar: context.avatar,
            chatId: chat.id,
            groupId: context.groupId || null,
            personaId: context.personaId,
            showToast: false,
        },
    }));
    scheduleTimelineRender();
    scheduleConversationListRender();

    if (context.message.role === 'user') {
        const replyText = String(context.message.mes || '').trim() || getConversationAttachmentSummary(context.message);
        if (replyText) {
            window.dispatchEvent(new CustomEvent('sb:queue-conversation-reply', {
                detail: {
                    avatar: context.avatar,
                    chatId: chat.id,
                    groupId: context.groupId || null,
                    messageIds: [context.message.id],
                    personaId: context.personaId,
                    text: replyText,
                    createdAt: Date.now(),
                    force: true,
                },
            }));
        }
    }
}

export async function quickConversationSelfie() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        globalThis.toastr?.warning?.('Pick a conversation first');
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const personaId = getConversationPersonaId();
    const chatId = getConversationRecord(avatar, { groupId, personaId })?.activeChatId || '';
    const settings = getSettings(avatar, { groupId, personaId });
    const context = await promptConversationText({
        title: 'Send a Selfie',
        text: 'Describe the selfie context',
        defaultValue: 'a casual selfie in the current conversation',
        confirmLabel: 'Generate',
    });
    if (typeof context !== 'string') {
        return;
    }

    await generateSelfieFromContext(context.trim(), settings, avatar, { chatId, groupId, personaId, force: true, notify: true });
}

export async function generateConversationSelfieFromMessageCommand(messageId, selfieIndex = 0) {
    const context = getConversationMessageById(messageId);
    if (!context || !context.message || ['user', 'system'].includes(context.message.role || '')) {
        return;
    }

    const requests = getConversationSelfieCommandRequests(context.message);
    const request = requests[Number(selfieIndex) || 0];
    if (!request) {
        globalThis.toastr?.warning?.('No selfie request found on this message');
        return;
    }

    const speakerAvatar = context.message.role === 'member'
        ? context.message.extra?.member_avatar || context.avatar
        : context.avatar;
    const role = context.message.role === 'member' ? 'member' : 'character';
    const settings = getSettings(speakerAvatar, { groupId: context.groupId, personaId: context.personaId });
    const extra = role === 'member' ? { member_avatar: speakerAvatar } : {};
    await generateSelfieFromContext(request.context, settings, speakerAvatar, {
        anchorAvatar: context.avatar,
        chatId: context.chatId,
        role,
        name: context.message.name || '',
        extra,
        groupId: context.groupId,
        personaId: context.personaId,
        force: true,
        notify: true,
    });
}

export async function quickConversationReminder() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const personaId = getConversationPersonaId();
    const chatId = getConversationRecord(avatar, { groupId, personaId })?.activeChatId || '';
    const delay = await promptConversationText({
        title: 'Remind Me',
        text: 'When should the reminder fire? For example 30m, 1h or 2d.',
        defaultValue: '1h',
        confirmLabel: 'Next',
    });
    if (typeof delay !== 'string' || !delay.trim()) {
        return;
    }

    const memo = await promptConversationText({
        title: 'Reminder Text',
        defaultValue: 'Reply to this later',
        confirmLabel: 'Set Reminder',
    });
    if (typeof memo !== 'string') {
        return;
    }

    addConversationReminder(avatar, groupId, delay, memo, { chatId, personaId });
}

export function getConversationMentionTargets(avatar = getCurrentCharAvatar()) {
    if (!avatar) {
        return [];
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    return getConversationParticipants(avatar, getSettings(avatar, { groupId }), { groupId })
        .filter(character => character?.avatar && character.name);
}

export function collectMentionTextNodes(node, nodes = []) {
    if (!node) {
        return nodes;
    }

    if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue?.includes('@')) {
            nodes.push(node);
        }
        return nodes;
    }

    if (node instanceof HTMLElement && node.matches('a, code, pre, .sb-conversation-mention')) {
        return nodes;
    }

    node.childNodes.forEach(child => collectMentionTextNodes(child, nodes));
    return nodes;
}

export function highlightConversationMentions(container, avatar = getCurrentCharAvatar()) {
    if (!(container instanceof HTMLElement)) {
        return;
    }

    const handles = [];
    for (const character of getConversationMentionTargets(avatar)) {
        for (const handle of getCharacterMentionHandles(character)) {
            if (!handles.includes(handle)) {
                handles.push(handle);
            }
        }
    }

    if (!handles.length) {
        return;
    }

    const mentionRe = new RegExp(`(^|[^a-z0-9_])(${handles.sort((left, right) => right.length - left.length).map(escapeRegExp).join('|')})(?=$|[^a-z0-9_])`, 'gi');
    for (const textNode of collectMentionTextNodes(container)) {
        const value = textNode.nodeValue || '';
        mentionRe.lastIndex = 0;
        if (!mentionRe.test(value)) {
            continue;
        }

        mentionRe.lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;
        while ((match = mentionRe.exec(value)) !== null) {
            const prefix = match[1] || '';
            const mention = match[2] || '';
            const mentionStart = match.index + prefix.length;
            if (mentionStart > lastIndex) {
                fragment.appendChild(document.createTextNode(value.slice(lastIndex, mentionStart)));
            }

            const tag = document.createElement('span');
            tag.className = 'sb-conversation-mention';
            tag.textContent = mention;
            fragment.appendChild(tag);
            lastIndex = mentionStart + mention.length;
        }

        if (lastIndex < value.length) {
            fragment.appendChild(document.createTextNode(value.slice(lastIndex)));
        }
        textNode.parentNode?.replaceChild(fragment, textNode);
    }
}

function bindConversationChromeControlsAsync(sheld) {
    void import('./chrome.js')
        .then(({ bindConversationChromeControls }) => bindConversationChromeControls(sheld))
        .catch(error => console.warn('Conversation Mode: could not bind chrome controls', error));
}

export function ensureConversationChrome() {
    const sheld = document.getElementById('sheld');
    const chatElement = document.getElementById('chat');
    if (!(sheld instanceof HTMLElement) || !(chatElement instanceof HTMLElement)) {
        return null;
    }

    let header = document.getElementById(CHROME_IDS.header);
    if (!(header instanceof HTMLElement)) {
        header = document.createElement('div');
        header.id = CHROME_IDS.header;
        header.className = 'sb-conversation-headerbar';
        header.hidden = true;
        header.innerHTML = `
            <button id="${CHROME_IDS.listToggle}" type="button" class="sb-conversation-flat-button sb-conversation-header-back" data-sb-conversation-action="toggle-list" title="Back to Conversations" aria-label="Back to Conversations">
                <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
                <span class="sb-conversation-list-toggle-badge" hidden></span>
            </button>
            <div class="sb-conversation-header-avatar" data-sb-conversation-participants></div>
            <button type="button" class="sb-conversation-header-title" data-sb-conversation-action="open-details" aria-haspopup="dialog" title="Details">
                <span class="sb-conversation-header-copy">
                    <span class="sb-conversation-header-name" data-sb-conversation-name>Conversation</span>
                    <span class="sb-conversation-header-status" data-sb-conversation-status></span>
                </span>
            </button>
            <div class="sb-conversation-header-actions">
                <button type="button" class="sb-conversation-flat-button sb-conversation-header-search" data-sb-conversation-action="toggle-search" title="Search" aria-label="Search" aria-pressed="false" aria-controls="${CHROME_IDS.tools}">
                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                </button>
                <button type="button" class="sb-conversation-flat-button sb-conversation-header-menu" data-sb-conversation-action="open-conversation-menu" title="Conversation Menu" aria-label="Conversation Menu" aria-haspopup="menu">
                    <i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i>
                </button>
            </div>
        `;
        sheld.insertBefore(header, chatElement);
    }

    let stage = document.getElementById(CHROME_IDS.stage);
    if (!(stage instanceof HTMLElement)) {
        stage = document.createElement('section');
        stage.id = CHROME_IDS.stage;
        stage.hidden = true;
        stage.setAttribute('aria-label', 'Conversation Messages');
        stage.innerHTML = `
            <div id="${CHROME_IDS.tools}" class="sb-conversation-search-bar" role="search" aria-label="Search This Conversation" data-open="false">
                <label class="sb-conversation-search-wrap" for="${CHROME_IDS.search}">
                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                    <span class="sr-only">Search Conversation Messages</span>
                    <input id="${CHROME_IDS.search}" class="sb-conversation-search-entry" type="search" placeholder="Search this conversation" autocomplete="off" />
                </label>
            </div>
            <div id="${CHROME_IDS.timeline}" class="sb-conversation-timeline" role="log" aria-live="polite"></div>
            <div id="${CHROME_IDS.dropHint}" class="sb-conversation-drop-hint" hidden>Drop files to attach</div>
            <form id="${CHROME_IDS.form}" class="sb-conversation-composer">
                <div id="${CHROME_IDS.replyPreview}" class="sb-conversation-reply-preview" hidden></div>
                <div id="${CHROME_IDS.attachmentPreview}" class="sb-conversation-attachment-preview" hidden></div>
                <div class="sb-conversation-composer-row">
                    <button id="${CHROME_IDS.attach}" type="button" class="sb-conversation-flat-button sb-conversation-composer-tool sb-conversation-composer-attach" data-sb-conversation-action="attach-file" title="Attach Files" aria-label="Attach Files">
                        <i class="fa-solid fa-paperclip" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="sb-conversation-flat-button sb-conversation-composer-tool sb-conversation-composer-more" data-sb-conversation-action="open-composer-menu" title="Add to Message" aria-label="Add to Message" aria-haspopup="menu">
                        <i class="fa-solid fa-plus" aria-hidden="true"></i>
                    </button>
                    <input id="${CHROME_IDS.fileInput}" class="displayNone" type="file" accept="${CONVERSATION_ATTACHMENT_ACCEPT}" multiple aria-label="Conversation Attachments" />
                    <label class="sr-only" for="${CHROME_IDS.input}">Conversation Message</label>
                    <textarea id="${CHROME_IDS.input}" class="text_pole" rows="1" placeholder="Type your message…"></textarea>
                    <button id="${CHROME_IDS.emoji}" type="button" class="sb-conversation-flat-button sb-conversation-composer-tool sb-conversation-composer-emoji" data-sb-conversation-action="open-emoji-chooser" title="Insert Emoji" aria-label="Insert Emoji" aria-haspopup="dialog" aria-keyshortcuts="Control+Period">
                        <i class="fa-solid fa-face-smile" aria-hidden="true"></i>
                    </button>
                    <button id="${CHROME_IDS.send}" type="submit" class="sb-conversation-send-button" title="Send Conversation Message" aria-label="Send Conversation Message">
                        <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
                    </button>
                </div>
            </form>
        `;
        sheld.insertBefore(stage, chatElement);
    }

    let conversationList = document.getElementById(CHROME_IDS.conversationList);
    if (!(conversationList instanceof HTMLElement)) {
        conversationList = document.createElement('aside');
        conversationList.id = CHROME_IDS.conversationList;
        conversationList.hidden = true;
        conversationList.setAttribute('aria-label', 'Conversations');
        conversationList.innerHTML = `
            <div class="sb-conversation-headerbar sb-conversation-rail-header">
                <div id="${CHROME_IDS.railFooter}" class="sb-conversation-rail-persona">
                    <button type="button" class="sb-conversation-flat-button sb-conversation-persona-button" data-sb-conversation-action="open-persona-menu" aria-haspopup="menu" title="Your Status and Persona">
                        <img id="sb_conv_footer_persona_avatar" alt="" loading="lazy" />
                        <span class="sb-conversation-status-dot sb-conversation-rail-footer-dot" data-status="online" aria-hidden="true"></span>
                        <span class="sr-only"><span id="sb_conv_footer_persona_name"></span>, <span id="sb_conv_footer_user_status"></span></span>
                    </button>
                </div>
                <div class="sb-conversation-rail-actions">
                    <button type="button" class="sb-conversation-flat-button sb-conversation-rail-new-button" data-sb-conversation-action="open-new-menu" aria-haspopup="menu" title="New" aria-label="New">
                        <i class="fa-solid fa-plus" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="sb-conversation-flat-button sb-conversation-rail-main-menu-button" data-sb-conversation-action="open-main-menu" aria-haspopup="menu" title="Main Menu" aria-label="Main Menu">
                        <i class="fa-solid fa-bars" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
            <div class="sb-conversation-rail-search">
                <label class="sb-conversation-search-wrap" for="sb_conversation_list_search">
                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                    <span class="sr-only">Search Conversations</span>
                    <input type="search" id="sb_conversation_list_search" class="sb-conversation-search-entry" placeholder="Search" autocomplete="off" />
                </label>
            </div>
            <div id="${CHROME_IDS.listItems}" class="sb-conversation-list-items" tabindex="-1"></div>
            <div class="sb-conversation-list-status sr-only" role="status" aria-live="polite"></div>
        `;
        sheld.insertBefore(conversationList, header);
    }

    // Pickers sit directly in #sheld (outside the sliding mobile pages) so they keep the delegated
    // click handler and can be shown as anchored popovers on desktop or bottom sheets on mobile.
    let pickerBackdrop = document.getElementById(CHROME_IDS.pickerBackdrop);
    if (!(pickerBackdrop instanceof HTMLElement)) {
        pickerBackdrop = document.createElement('div');
        pickerBackdrop.id = CHROME_IDS.pickerBackdrop;
        pickerBackdrop.className = 'sb-conversation-picker-backdrop';
        pickerBackdrop.setAttribute('aria-hidden', 'true');
        sheld.appendChild(pickerBackdrop);
    }

    if (!(document.getElementById(CHROME_IDS.personaPicker) instanceof HTMLElement)) {
        const personaPicker = document.createElement('div');
        personaPicker.id = CHROME_IDS.personaPicker;
        personaPicker.className = 'sb-conversation-picker sb-conversation-persona-picker';
        personaPicker.setAttribute('role', 'listbox');
        personaPicker.setAttribute('aria-label', 'Choose Persona');
        personaPicker.hidden = true;
        sheld.appendChild(personaPicker);
    }

    if (!(document.getElementById(CHROME_IDS.userStatusPicker) instanceof HTMLElement)) {
        const statusPicker = document.createElement('div');
        statusPicker.id = CHROME_IDS.userStatusPicker;
        statusPicker.className = 'sb-conversation-picker sb-conversation-status-picker';
        statusPicker.setAttribute('role', 'listbox');
        statusPicker.setAttribute('aria-label', 'Set Your Status');
        statusPicker.hidden = true;
        statusPicker.innerHTML = `
            <button type="button" class="sb-conversation-status-option" data-status="online" data-sb-conversation-action="set-user-status" role="option">
                <span class="sb-conversation-status-dot" data-status="online" aria-hidden="true"></span>Online
            </button>
            <button type="button" class="sb-conversation-status-option" data-status="idle" data-sb-conversation-action="set-user-status" role="option">
                <span class="sb-conversation-status-dot" data-status="idle" aria-hidden="true"></span>Idle
            </button>
            <button type="button" class="sb-conversation-status-option" data-status="dnd" data-sb-conversation-action="set-user-status" role="option">
                <span class="sb-conversation-status-dot" data-status="dnd" aria-hidden="true"></span>Do Not Disturb
            </button>
            <button type="button" class="sb-conversation-status-option" data-status="offline" data-sb-conversation-action="set-user-status" role="option">
                <span class="sb-conversation-status-dot" data-status="offline" aria-hidden="true"></span>Invisible
            </button>
        `;
        sheld.appendChild(statusPicker);
    }

    bindConversationChromeControlsAsync(sheld);
    return { sheld, header, stage, conversationList };
}

registerConversationRenderer('timeline', renderConversationTimeline);
