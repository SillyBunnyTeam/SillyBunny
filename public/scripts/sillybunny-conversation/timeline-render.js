import {
    characters,
    default_user_avatar,
    getThumbnailUrl,
    messageFormatting,
    name1,
} from '../../script.js';
import { world_names } from '../world-info.js';
import {
    CHROME_IDS,
    CONVERSATION_ATTACHMENT_ACCEPT,
    CONVERSATION_REACTION_LABELS,
    CONVERSATION_TIMELINE_CHANNELS,
    DEFAULT_AUTO_CHAT_COOLDOWN,
    SELFIE_COMMAND_RE,
} from './constants.js';
import { truncateConversationReplyPreview } from './preview-utils.js';
import {
    createConversationBranch,
    getActiveConversationBranch,
    getConversationGroupById,
    getConversationBranches,
    getConversationGroupIdForAvatar,
    getConversationPersonaId,
    getConversationThreadStore,
    getCurrentCharAvatar,
    getCurrentCharName,
    persistConversationStore,
} from './context.js';
import { promptConversationText } from './dialogs.js';
import { commitCharacterReplyCommands, extractCharacterReplyCommands, generateConversationRaw, generateSelfieFromContext, getCharacterReplyCommandMetadata, reportConversationGenerationError } from './generation.js';
import { getConversationMessagesRevision } from './message-identity-utils.js';
import { getCharacterForAvatar, getConversationParticipants, getEffectiveConversationStatus } from './media.js';
import { getConversationMessageAvatar, getConversationMessageReceipt } from './pals-rail.js';
import { escapeRegExp, getCharacterMentionHandles, parseAvatarList } from './partners.js';
import { getConnectionProfiles } from './personas.js';
import { buildConversationPromptMessages, buildConversationSystemPrompt, renderConversationAttachments } from './prompt.js';
import { registerConversationRenderer, scheduleInterfaceRefresh, schedulePalsRailRender, scheduleTimelineRender } from './render-scheduler.js';
import { escapeHtmlAttribute, escapeHtmlText, getConversationMessageExtraFingerprint, hashConversationRenderFingerprint } from './render-utils.js';
import { getConversationReplyMaxTokens } from './schedule.js';
import { getSettings } from './settings-store.js';
import {
    beginConversationGenerationOperation,
    conversationState,
    endConversationGenerationOperation,
    regenerationBusyKeys,
} from './state.js';
import { getConversationTimelineMessages } from './timeline-search.js';
import { narrateConversationMessage } from './tts.js';
import {
    addConversationReminder,
    buildConversationMessageReplyReference,
    getConversationAttachmentSummary,
    getConversationSeenAt,
    getConversationMessagePreviewText,
    getConversationThread,
    saveConversationThread,
} from './thread-store.js';
import { getActiveTypingParticipants, getPrimaryTypingParticipant, updateLastPreviewFromConversation, withTypingParticipant } from './typing.js';

export { escapeHtmlAttribute, escapeHtmlText } from './render-utils.js';
export { getConversationTimelineMessages } from './timeline-search.js';
export {
    appendConversationOocNote,
    handleConversationSlashAction,
    parseConversationReminderArgs,
    parseConversationSlashCommand,
    quickConversationSummarize,
} from './timeline-slash-commands.js';

function getConversationRenderBranchId(avatar, groupId, personaId) {
    const store = getConversationThreadStore(avatar, { create: false, groupId, personaId });
    return String(store?.activeBranchId || getActiveConversationBranch(avatar, { create: false, groupId, personaId })?.id || '');
}

function buildConversationRenderThreadKey(avatar, groupId, branchId, personaId) {
    return [personaId || '', avatar || '', groupId || '', branchId || ''].join('\u001f');
}

function buildTimelineFingerprint({ avatar, groupId, branchId, personaId, settings, allMessages, messages }) {
    const activeTyping = getActiveTypingParticipants(avatar, { branchId, groupId, personaId });
    const statusAvatars = new Set([avatar]);
    for (const participant of activeTyping) {
        if (participant?.avatar) {
            statusAvatars.add(participant.avatar);
        }
    }

    const messageParts = messages.map((message) => {
        const speakerAvatar = message?.role === 'partner' ? message.extra?.partner_avatar : avatar;
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
        .map(statusAvatar => `${statusAvatar}:${getEffectiveConversationStatus(statusAvatar, getSettings(statusAvatar, { groupId, personaId }))}`)
        .join(',');
    const settingsPart = [
        settings?.editable_messages ? '1' : '0',
        settings?.prose_polisher ? '1' : '0',
    ].join(':');

    return hashConversationRenderFingerprint([
        personaId || '',
        avatar || '',
        groupId || '',
        branchId || '',
        conversationState.conversationTimelineChannel || '',
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
    const speakerAvatar = message?.role === 'partner' ? message.extra?.partner_avatar : avatar;
    const speakerStatus = speakerAvatar && message?.role !== 'user' && message?.role !== 'system'
        ? getEffectiveConversationStatus(speakerAvatar, getSettings(speakerAvatar, { groupId, personaId }))
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
        settings?.editable_messages ? '1' : '0',
        settings?.prose_polisher ? '1' : '0',
        speakerStatus,
        index > 8 ? 'lazy' : 'eager',
    ].join('\u001f'));
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
        button.title = request.context ? `Generate selfie: ${request.context}` : 'Generate selfie with Quick Image Gen';
        button.setAttribute('aria-label', button.title);
        button.innerHTML = '<i class="fa-solid fa-camera" aria-hidden="true"></i><span>Generate selfie</span>';
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

export function getActiveConversationReplyTarget(avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const target = conversationState.conversationReplyTarget;
    const threadStore = getConversationThreadStore(avatar, { create: false, groupId, personaId });
    const resolvedBranchId = branchId || threadStore?.activeBranchId || '';
    if (!target) {
        return null;
    }
    if (
        target.avatar !== avatar
        || String(target.groupId || '') !== String(groupId || '')
        || String(target.personaId || '') !== String(personaId || '')
        || String(target.branchId || '') !== String(resolvedBranchId)
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
    cancel.title = 'Cancel reply';
    cancel.setAttribute('aria-label', 'Cancel reply');

    reference.prepend(label);
    preview.append(reference, cancel);
    preview.hidden = false;
}

export function clearConversationReplyTarget() {
    conversationState.conversationReplyTarget = null;
    renderConversationComposerReplyPreview();
}

export function consumeConversationReplyTarget(avatar = getCurrentCharAvatar(), { branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    const target = getActiveConversationReplyTarget(avatar, { branchId, groupId, personaId });
    if (!target) {
        return null;
    }

    clearConversationReplyTarget();
    const reference = { ...target };
    delete reference.avatar;
    delete reference.branchId;
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

    return `${message?.role || 'character'}:${message?.extra?.partner_avatar || message?.name || ''}`;
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

export function getConversationTimelineGroupMeta(messages) {
    return (Array.isArray(messages) ? messages : []).map((message, index, list) => {
        const continuesPrevious = messagesShareConversationGroup(message, list[index - 1]);
        const continuesNext = messagesShareConversationGroup(list[index + 1], message);
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

function createConversationMessageElement(message, { avatar, groupId, settings, index, fingerprint }) {
    const item = document.createElement('article');
    item.className = 'sb-conversation-message';
    item.dataset.role = message.role || 'character';
    item.dataset.messageId = message.id;
    item.dataset.pinned = String(Boolean(message.extra?.conversation_pinned));
    item.dataset.sbConversationMessageFingerprint = fingerprint;

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'sb-conversation-message-avatar';
    const messageAvatar = message.role === 'user'
        ? ''
        : message.role === 'partner' || message.role === 'system'
            ? message.extra?.partner_avatar || avatar
            : avatar;
    if (message.role !== 'user' && messageAvatar) {
        avatarWrap.dataset.sbConversationAction = 'zoom-avatar';
        avatarWrap.dataset.avatarFile = messageAvatar;
        avatarWrap.dataset.avatarType = 'avatar';
        avatarWrap.tabIndex = 0;
        avatarWrap.role = 'button';
        avatarWrap.setAttribute('aria-label', `Show full picture for ${message.name || getCurrentCharName()}`);
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
            statusDot.dataset.status = getEffectiveConversationStatus(messageAvatar, getSettings(messageAvatar, { groupId }));
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
    if (message.extra?.conversation_pinned) {
        const pin = document.createElement('i');
        pin.className = 'fa-solid fa-thumbtack sb-conversation-message-pin';
        pin.title = 'Pinned';
        pin.setAttribute('aria-label', 'Pinned');
        meta.append(pin);
    }

    // SillyBunny message actions (DESIGN.md "Message Actions"): reactions | Reply, Edit, Copy, menu
    // at rest; data-sb-secondary items join in section order when the pill is expanded.
    const actionBar = document.createElement('span');
    actionBar.className = 'sb-conversation-message-actions';
    const activeReactionCounts = message.extra?.conversation_reactions || {};
    for (const reaction of Object.keys(CONVERSATION_REACTION_LABELS)) {
        const reactionButton = document.createElement('button');
        reactionButton.type = 'button';
        reactionButton.className = 'sb-conversation-reaction-button';
        reactionButton.textContent = normalizeConversationReactionLabel(reaction);
        reactionButton.setAttribute('aria-pressed', String(Number(activeReactionCounts[reaction]) > 0));
        reactionButton.dataset.sbConversationAction = 'react-message';
        reactionButton.dataset.messageId = message.id;
        reactionButton.dataset.reaction = reaction;
        actionBar.appendChild(reactionButton);
    }

    const isCharacterMessage = !['user', 'system'].includes(message.role || '');
    const actionSections = [
        [
            { action: 'reply-message', icon: 'fa-reply', label: 'Reply' },
            settings.editable_messages && { action: 'edit-message', icon: 'fa-pencil', label: 'Edit Conversation message', className: 'sb-conversation-message-edit' },
            settings.prose_polisher && message.role !== 'user' && { action: 'polish-character-message', icon: 'fa-wand-magic-sparkles', label: 'Polish character message', className: 'sb-conversation-message-polish', secondary: true },
        ],
        [
            { action: 'copy-message', icon: 'fa-copy', label: 'Copy message' },
            { action: 'toggle-message-pin', icon: 'fa-thumbtack', label: message.extra?.conversation_pinned ? 'Unpin message' : 'Pin message', secondary: true },
            { action: 'branch-from-message', icon: 'fa-code-branch', label: 'Branch from here', secondary: true },
        ],
        isCharacterMessage ? [
            { action: 'speak-message', icon: 'fa-volume-high', label: 'Speak', secondary: true },
            { action: 'regenerate-message', icon: 'fa-rotate-right', label: 'Regenerate message', secondary: true },
        ] : [],
        [{ action: 'delete-message', icon: 'fa-trash-can', label: 'Delete message', secondary: true }],
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

    const imageUrl = message.extra?.image_url;
    if (typeof imageUrl === 'string' && imageUrl) {
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

    const activeReactions = Object.entries(message.extra?.conversation_reactions || {})
        .filter(([, count]) => Number(count) > 0);
    let reactions = null;
    if (activeReactions.length) {
        reactions = document.createElement('div');
        reactions.className = 'sb-conversation-message-reactions';
        for (const [reaction, count] of activeReactions) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'sb-conversation-message-reaction-chip';
            chip.textContent = `${normalizeConversationReactionLabel(reaction)} ${count}`;
            chip.setAttribute('aria-pressed', 'true');
            chip.dataset.sbConversationAction = 'react-message';
            chip.dataset.messageId = message.id;
            chip.dataset.reaction = reaction;
            reactions.appendChild(chip);
        }
    }

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
    bubble.append(actionBar);
    const body = document.createElement('div');
    body.className = 'sb-conversation-message-body';
    body.append(meta, bubble);
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

function removeTimelineTransientNodes(timeline) {
    timeline.querySelectorAll('.sb-conversation-thread-empty, .sb-conversation-typing-indicator, .sb-conversation-image-pending').forEach(node => node.remove());
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

function anchorConversationTimelineToBottom(timeline, renderThreadKey) {
    const token = ++timelineBottomScrollToken;
    const applyScroll = () => {
        if (token !== timelineBottomScrollToken || !timeline.isConnected || conversationState.lastRenderedThreadKey !== renderThreadKey) {
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

function reconcileConversationMessageNodes(timeline, messages, { avatar, groupId, personaId, settings }) {
    const existingNodes = new Map();
    timeline.querySelectorAll('.sb-conversation-message[data-message-id]').forEach((node) => {
        if (node instanceof HTMLElement && !node.classList.contains('sb-conversation-typing-indicator') && !node.classList.contains('sb-conversation-image-pending')) {
            existingNodes.set(node.dataset.messageId || '', node);
        }
    });

    const grouping = getConversationTimelineGroupMeta(messages);
    messages.forEach((message, index) => {
        const messageId = String(message?.id || '');
        const fingerprint = buildConversationMessageFingerprint(message, { avatar, groupId, personaId, settings, index });
        const currentNode = existingNodes.get(messageId) || null;
        let nextNode = currentNode;
        if (!nextNode || nextNode.dataset.sbConversationMessageFingerprint !== fingerprint) {
            nextNode = createConversationMessageElement(message, { avatar, groupId, settings, index, fingerprint });
            if (currentNode) {
                currentNode.replaceWith(nextNode);
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
    const previousThreadKey = conversationState.lastRenderedThreadKey || '';
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
        timeline.innerHTML = `
            <div class="sb-conversation-thread-empty">
                <div class="sb-conversation-thread-empty-icon fa-solid ${unavailableGroup ? 'fa-user-group' : 'fa-comments'}" aria-hidden="true"></div>
                <div>
                    <strong>${unavailableGroup ? 'No Conversation members available' : 'Choose a DM to begin'}</strong>
                    <p>${unavailableGroup
        ? `${escapeHtmlText(unavailableGroup.name || 'This group')} does not currently have any eligible Conversation members. Add or enable a member, then try again.`
        : 'Use the Pals rail plus button to start messaging a character without opening the character drawer.'}</p>
                </div>
            </div>
        `;
        conversationState.lastRenderedAvatar = null;
        conversationState.lastRenderedThreadKey = '';
        conversationState.lastRenderedMessageCount = 0;
        conversationState.timelineBottomScrollPending = false;
        updateConversationToolsState();
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId, personaId });
    const allMessages = getConversationThread(avatar, { groupId, personaId });
    const messages = getConversationTimelineMessages(allMessages);
    const branchId = getConversationRenderBranchId(avatar, groupId, personaId);
    const renderThreadKey = buildConversationRenderThreadKey(avatar, groupId, branchId, personaId);
    const contextChanged = previousThreadKey !== renderThreadKey;
    const messagesAdded = allMessages.length > previousMessageCount;
    const isNearBottom = previousScrollBottom <= 150;
    const needsBottomScroll = Boolean(conversationState.timelineBottomScrollPending);
    const fingerprint = buildTimelineFingerprint({ avatar, groupId, branchId, personaId, settings, allMessages, messages });
    if (!contextChanged && fingerprint === conversationState.lastTimelineFingerprint && timeline.dataset.sbConversationFingerprint === fingerprint) {
        updateConversationToolsState();
        if (needsBottomScroll) {
            conversationState.timelineBottomScrollPending = false;
            anchorConversationTimelineToBottom(timeline, renderThreadKey);
        }
        return;
    }

    conversationState.lastTimelineFingerprint = fingerprint;
    timeline.dataset.sbConversationFingerprint = fingerprint;
    if (contextChanged) {
        timeline.textContent = '';
    } else {
        stripConversationDayDividers(timeline);
        removeTimelineTransientNodes(timeline);
    }

    if (!allMessages.length) {
        timeline.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'sb-conversation-thread-empty';
        empty.innerHTML = `
            <div class="sb-conversation-thread-empty-icon fa-solid fa-message" aria-hidden="true"></div>
            <div>
                <strong>No DM messages yet</strong>
                <p>Type a message to begin chatting with this character!</p>
            </div>
        `;
        timeline.appendChild(empty);
        conversationState.lastRenderedAvatar = avatar;
        conversationState.lastRenderedThreadKey = renderThreadKey;
        conversationState.lastRenderedMessageCount = allMessages.length;
        conversationState.timelineBottomScrollPending = false;
        updateConversationToolsState();
        if (contextChanged || messagesAdded || isNearBottom || needsBottomScroll) {
            anchorConversationTimelineToBottom(timeline, renderThreadKey);
        } else {
            timeline.scrollTop = previousScrollTop;
        }
        return;
    }

    if (!messages.length) {
        timeline.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'sb-conversation-thread-empty';
        empty.innerHTML = `
            <div class="sb-conversation-thread-empty-icon fa-solid fa-filter" aria-hidden="true"></div>
            <div>
                <strong>No matching messages</strong>
                <p>Clear search or switch back to Main to see the full Conversation.</p>
            </div>
        `;
        timeline.appendChild(empty);
        conversationState.lastRenderedAvatar = avatar;
        conversationState.lastRenderedThreadKey = renderThreadKey;
        conversationState.lastRenderedMessageCount = allMessages.length;
        conversationState.timelineBottomScrollPending = false;
        updateConversationToolsState();
        return;
    }

    reconcileConversationMessageNodes(timeline, messages, { avatar, groupId, personaId, settings });
    insertConversationDayDividers(timeline, messages);

    const typingParticipants = getActiveTypingParticipants(avatar, { branchId, groupId, personaId });
    if (typingParticipants.length > 2) {
        timeline.appendChild(createConversationTransientRow({
            role: 'partner',
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
                role: typingAvatar !== getCurrentCharAvatar() ? 'partner' : 'character',
                extraClass: 'sb-conversation-typing-indicator',
                avatarSrc: getThumbnailUrl('avatar', typingAvatar) || default_user_avatar,
                nameHtml: escapeHtmlText(typingName),
                textHtml: '<div class="sb-conversation-message-text sb-conversation-typing-dots"><span></span><span></span><span></span></div>',
            }));
        }
    }

    if (conversationState.imageGenerationActive) {
        const pendingParticipant = getPrimaryTypingParticipant(avatar, { branchId, groupId, personaId });
        const pendingAvatar = pendingParticipant?.avatar || getCurrentCharAvatar();
        timeline.appendChild(createConversationTransientRow({
            role: pendingParticipant && pendingAvatar !== getCurrentCharAvatar() ? 'partner' : 'character',
            extraClass: 'sb-conversation-image-pending',
            avatarSrc: getThumbnailUrl('avatar', pendingAvatar) || default_user_avatar,
            nameHtml: 'Image generation',
            textHtml: `
                <div class="sb-conversation-message-text sb-conversation-typing-dots"><span></span><span></span><span></span></div>
                <button type="button" class="sb-conversation-stop-image" data-sb-conversation-action="stop-image-generation">Stop</button>
            `,
        }));
    }

    conversationState.lastRenderedAvatar = avatar;
    conversationState.lastRenderedThreadKey = renderThreadKey;
    conversationState.lastRenderedMessageCount = allMessages.length;
    conversationState.timelineBottomScrollPending = false;
    updateConversationToolsState();
    if (contextChanged || messagesAdded || isNearBottom || needsBottomScroll) {
        anchorConversationTimelineToBottom(timeline, renderThreadKey);
    } else {
        timeline.scrollTop = previousScrollTop;
    }
}

export function buildLorebookOptions(selected) {
    const options = ['<option value="">Character default (no override)</option>'];
    for (const worldName of (Array.isArray(world_names) ? world_names : [])) {
        const safe = escapeHtmlAttribute(worldName);
        options.push(`<option value="${safe}"${worldName === selected ? ' selected' : ''}>${escapeHtmlText(worldName)}</option>`);
    }
    return options.join('');
}

export function buildConnectionProfileOptions(selected) {
    const options = ['<option value="">Use current connection</option>'];
    for (const profile of getConnectionProfiles()) {
        if (!profile?.name) {
            continue;
        }
        const safe = escapeHtmlAttribute(profile.name);
        options.push(`<option value="${safe}"${profile.name === selected ? ' selected' : ''}>${escapeHtmlText(profile.name)}</option>`);
    }
    return options.join('');
}

export function buildPartnerOptions(selectedNames, emptyText = 'Enable more characters to pick partners.') {
    const selectedSet = new Set(parseAvatarList(selectedNames));
    const currentAvatar = getCurrentCharAvatar();
    const rows = [];
    (Array.isArray(characters) ? characters : []).forEach((character) => {
        if (!character?.avatar || character.avatar === currentAvatar) {
            return;
        }
        const charName = character.name || 'Character';
        const charAvatar = character.avatar;
        const checked = selectedSet.has(charAvatar) ? ' checked' : '';
        const thumbUrl = getThumbnailUrl('avatar', charAvatar);
        rows.push(`
            <div class="sb-conversation-partner-option" data-char-name="${escapeHtmlAttribute(charName.toLowerCase())}">
                <label class="sb-conversation-partner-pick">
                    <input type="checkbox" class="sb-conversation-partner-checkbox" value="${escapeHtmlAttribute(charAvatar)}"${checked} />
                    <img class="sb-conversation-partner-avatar" src="${escapeHtmlAttribute(thumbUrl)}" alt="${escapeHtmlAttribute(charName)}" loading="lazy" />
                    <span class="sb-conversation-partner-name">${escapeHtmlText(charName)}</span>
                </label>
            </div>
        `);
    });
    if (!rows.length) {
        return `<div class="sb-conversation-empty">${escapeHtmlText(emptyText)}</div>`;
    }
    return rows.join('');
}

export function buildChimingPartnerOptions(selectedNames) {
    return buildPartnerOptions(selectedNames, 'Enable more characters to pick chiming partners.');
}

export function setConversationTimelineChannel(channel) {
    conversationState.conversationTimelineChannel = CONVERSATION_TIMELINE_CHANNELS.includes(channel) ? channel : 'main';
    updateConversationToolsState();
    scheduleTimelineRender();
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

    tools.querySelectorAll('[data-channel]').forEach((button) => {
        if (button instanceof HTMLButtonElement) {
            const active = button.dataset.channel === conversationState.conversationTimelineChannel;
            button.setAttribute('aria-pressed', String(active));
            button.dataset.active = String(active);
        }
    });

    const searchInput = document.getElementById(CHROME_IDS.search);
    if (searchInput instanceof HTMLInputElement && searchInput.value !== conversationState.conversationTimelineSearchQuery) {
        searchInput.value = conversationState.conversationTimelineSearchQuery;
    }
}

export function isConversationSearchBarOpen() {
    return Boolean(conversationState.conversationSearchOpen)
        || conversationState.conversationTimelineChannel !== 'main'
        || Boolean(conversationState.conversationTimelineSearchQuery);
}

export function toggleConversationSearchBar(open = !isConversationSearchBarOpen()) {
    if (!open) {
        conversationState.conversationSearchOpen = false;
        conversationState.conversationTimelineSearchQuery = '';
        const searchInput = document.getElementById(CHROME_IDS.search);
        if (searchInput instanceof HTMLInputElement) {
            searchInput.value = '';
        }
        conversationState.conversationTimelineChannel = 'main';
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

export function getConversationMessageById(messageId, { avatar = getCurrentCharAvatar(), branchId = '', groupId = getConversationGroupIdForAvatar(avatar), personaId = getConversationPersonaId() } = {}) {
    if (!avatar || !messageId) {
        return null;
    }

    const threadStore = getConversationThreadStore(avatar, { create: false, groupId, personaId });
    const resolvedBranchId = branchId || threadStore?.activeBranchId || '';
    const messages = getConversationThread(avatar, { branchId: resolvedBranchId, create: false, groupId, personaId });
    const message = messages.find(item => item.id === messageId);
    return message ? { avatar, branchId: resolvedBranchId, groupId, messages, message, personaId } : null;
}

export function saveConversationMessageThread(context) {
    if (!context?.avatar) {
        return;
    }

    saveConversationThread(context.avatar, context.messages, {
        branchId: context.branchId,
        create: false,
        groupId: context.groupId,
        personaId: context.personaId,
    });
    if (context.messages.length) {
        updateLastPreviewFromConversation(context.avatar, {
            branchId: context.branchId,
            groupId: context.groupId,
            personaId: context.personaId,
        });
    } else {
        const branch = getActiveConversationBranch(context.avatar, {
            branchId: context.branchId,
            create: false,
            groupId: context.groupId,
            personaId: context.personaId,
        });
        if (branch) {
            branch.preview = 'Conversation ready';
            persistConversationStore();
        }
    }
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
        branchId: context.branchId,
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
        globalThis.toastr?.success?.('Message copied.');
    } catch {
        globalThis.toastr?.warning?.('Could not copy message text.');
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

    context.message.extra = { ...context.message.extra, conversation_pinned: !context.message.extra?.conversation_pinned };
    saveConversationMessageThread(context);
}

export function reactConversationMessage(messageId, reaction) {
    const context = getConversationMessageById(messageId);
    if (!context || !reaction) {
        return;
    }

    const reactions = { ...(context.message.extra?.conversation_reactions || {}) };
    reactions[reaction] = reactions[reaction] ? 0 : 1;
    context.message.extra = { ...context.message.extra, conversation_reactions: reactions };
    saveConversationMessageThread(context);
}

export function deleteConversationMessage(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context) {
        return;
    }

    context.messages = context.messages.filter(item => item.id !== messageId);
    saveConversationMessageThread(context);
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

    const speakerAvatar = context.message.extra?.partner_avatar || context.avatar;
    const settings = getSettings(speakerAvatar, { groupId: context.groupId, personaId: context.personaId });
    const speakerName = context.message.name || getCharacterForAvatar(speakerAvatar)?.name || getCurrentCharName();
    const operationKey = [context.personaId, context.avatar, context.groupId, context.branchId, messageId].join('\u001f');
    if (regenerationBusyKeys.has(operationKey)) {
        return;
    }

    const sourceMessages = context.messages.slice(0, index + 1);
    const sourceRevision = getConversationMessagesRevision(sourceMessages);
    regenerationBusyKeys.add(operationKey);
    const operation = beginConversationGenerationOperation();
    scheduleInterfaceRefresh({ syncControls: false });

    try {
        const prompt = await buildConversationPromptMessages(
            sourceMessages.slice(0, -1),
            '[System directive: Regenerate the selected Conversation reply. Keep the same speaker, casual DM style, and current context. Output only the replacement message.]',
            speakerName,
            { groupId: context.groupId, personaId: context.personaId },
        );
        const response = await withTypingParticipant(
            { avatar: speakerAvatar, name: speakerName },
            () => generateConversationRaw({
                prompt,
                systemPrompt: buildConversationSystemPrompt(settings, speakerAvatar, {
                    threadAvatar: context.avatar,
                    branchId: context.branchId,
                    groupId: context.groupId,
                    personaId: context.personaId,
                }),
                responseLength: getConversationReplyMaxTokens(settings),
                trimNames: true,
                cacheScope: 'conversation-mode',
            }, settings),
            context.avatar,
            { branchId: context.branchId, groupId: context.groupId, personaId: context.personaId },
        );

        if (!String(response || '').trim()) {
            globalThis.toastr?.warning?.('Regenerate returned no message.');
            return;
        }

        const targetContext = getConversationMessageById(messageId, {
            avatar: context.avatar,
            branchId: context.branchId,
            groupId: context.groupId,
            personaId: context.personaId,
        });
        const targetIndex = targetContext?.messages.findIndex(message => message.id === messageId) ?? -1;
        if (!targetContext || targetIndex < 0 || getConversationMessagesRevision(targetContext.messages.slice(0, targetIndex + 1)) !== sourceRevision) {
            return;
        }

        const commandParts = extractCharacterReplyCommands(response, settings);
        if (!commandParts.text) {
            globalThis.toastr?.warning?.('Regenerate returned no message.');
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
        saveConversationMessageThread(targetContext);
        commitCharacterReplyCommands(commandParts, speakerAvatar, {
            branchId: context.branchId,
            groupId: context.groupId,
            personaId: context.personaId,
            reminderAvatar: context.avatar,
        });
        globalThis.toastr?.success?.('Message regenerated.');
    } catch (error) {
        reportConversationGenerationError('regenerate', error, { level: 'warning' });
    } finally {
        regenerationBusyKeys.delete(operationKey);
        endConversationGenerationOperation(operation);
        scheduleInterfaceRefresh({ syncControls: false });
    }
}

export function branchConversationFromMessage(messageId) {
    const context = getConversationMessageById(messageId);
    if (!context) {
        return;
    }

    const index = context.messages.findIndex(item => item.id === messageId);
    if (index < 0) {
        return;
    }

    const sourceBranch = getActiveConversationBranch(context.avatar, {
        branchId: context.branchId,
        create: false,
        groupId: context.groupId,
        personaId: context.personaId,
    });
    if (!sourceBranch) {
        return;
    }

    const branch = createConversationBranch(`Branch ${getConversationBranches(context.avatar, { groupId: context.groupId }).length + 1}`);
    branch.messages = context.messages.slice(0, index + 1).map(item => ({ ...item, extra: { ...(item.extra || {}) } }));
    branch.preview = getConversationMessagePreviewText(branch.messages[branch.messages.length - 1]) || 'Conversation ready';
    branch.updatedAt = Date.now();
    if (sourceBranch.memorySummary) {
        branch.memorySummary = sourceBranch.memorySummary;
        branch.memoryMessageCount = sourceBranch.memoryMessageCount;
    }
    const store = getConversationThreadStore(context.avatar, { groupId: context.groupId, personaId: context.personaId });
    if (!store) {
        return;
    }

    store.branches[branch.id] = branch;
    store.activeBranchId = branch.id;
    const group = context.groupId ? getConversationGroupById(context.groupId, { personaId: context.personaId }) : null;
    if (group?.is_conversation_group) {
        group.updatedAt = Date.now();
    }
    persistConversationStore();
    window.dispatchEvent(new CustomEvent('sb:open-conversation-workspace', {
        detail: {
            avatar: context.avatar,
            branchId: branch.id,
            groupId: context.groupId || null,
            personaId: context.personaId,
            showToast: false,
        },
    }));
    scheduleTimelineRender();
    schedulePalsRailRender();

    if (context.message.role === 'user') {
        const replyText = String(context.message.mes || '').trim() || getConversationAttachmentSummary(context.message);
        if (replyText) {
            window.dispatchEvent(new CustomEvent('sb:queue-conversation-reply', {
                detail: {
                    avatar: context.avatar,
                    branchId: branch.id,
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
        globalThis.toastr?.warning?.('Pick a DM first.');
        return;
    }

    const groupId = getConversationGroupIdForAvatar(avatar);
    const personaId = getConversationPersonaId();
    const branchId = getConversationThreadStore(avatar, { create: false, groupId, personaId })?.activeBranchId || '';
    const settings = getSettings(avatar, { groupId, personaId });
    const context = await promptConversationText({
        title: 'Send a selfie',
        text: 'Describe the selfie context.',
        defaultValue: 'a casual selfie in the current DM conversation',
        confirmLabel: 'Generate',
    });
    if (typeof context !== 'string') {
        return;
    }

    await generateSelfieFromContext(context.trim(), settings, avatar, { branchId, groupId, personaId, force: true, notify: true });
}

export async function generateConversationSelfieFromMessageCommand(messageId, selfieIndex = 0) {
    const context = getConversationMessageById(messageId);
    if (!context || !context.message || ['user', 'system'].includes(context.message.role || '')) {
        return;
    }

    const requests = getConversationSelfieCommandRequests(context.message);
    const request = requests[Number(selfieIndex) || 0];
    if (!request) {
        globalThis.toastr?.warning?.('No selfie request found on this message.');
        return;
    }

    const speakerAvatar = context.message.role === 'partner'
        ? context.message.extra?.partner_avatar || context.avatar
        : context.avatar;
    const role = context.message.role === 'partner' ? 'partner' : 'character';
    const settings = getSettings(speakerAvatar, { groupId: context.groupId, personaId: context.personaId });
    const extra = role === 'partner' ? { partner_avatar: speakerAvatar } : {};
    await generateSelfieFromContext(request.context, settings, speakerAvatar, {
        threadAvatar: context.avatar,
        branchId: context.branchId,
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
    const branchId = getConversationThreadStore(avatar, { create: false, groupId, personaId })?.activeBranchId || '';
    const delay = await promptConversationText({
        title: 'Remind me',
        text: 'When should the reminder fire? For example 30m, 1h or 2d.',
        defaultValue: '1h',
        confirmLabel: 'Next',
    });
    if (typeof delay !== 'string' || !delay.trim()) {
        return;
    }

    const memo = await promptConversationText({
        title: 'Reminder text',
        defaultValue: 'Reply to this later',
        confirmLabel: 'Set reminder',
    });
    if (typeof memo !== 'string') {
        return;
    }

    addConversationReminder(avatar, groupId, delay, memo, { branchId, personaId });
}

export function updateConversationNotificationSettingsVisibility() {
    const muted = document.getElementById('sb_conv_notifications_muted');
    const priority = document.getElementById('sb_conv_notification_priority');
    const shouldDisablePriority = muted instanceof HTMLInputElement && muted.checked;
    if (priority instanceof HTMLSelectElement) {
        priority.disabled = shouldDisablePriority;
    }
}

export function normalizeConversationReactionLabel(reaction) {
    return CONVERSATION_REACTION_LABELS[reaction] || reaction;
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

function buildConversationSwitchRow({ id, labelHtml, title = '', extra = '' } = {}) {
    const safeId = escapeHtmlAttribute(id);
    const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : '';
    const input = `<input id="${safeId}" type="checkbox" class="sb-conversation-switch" />`;
    if (extra) {
        return `<div class="sb-conversation-pref-row"${titleAttr}><label class="sb-conversation-pref-copy" for="${safeId}">${labelHtml}</label>${extra}${input}</div>`;
    }
    return `<label class="sb-conversation-pref-row"${titleAttr} for="${safeId}"><span class="sb-conversation-pref-copy">${labelHtml}</span>${input}</label>`;
}

export function buildSettingsDrawerHtml() {
    const avatar = getCurrentCharAvatar();
    const groupId = getConversationGroupIdForAvatar(avatar);
    const settings = getSettings(avatar, { groupId });
    const isGroupConversation = Boolean(groupId);
    const drawerTitle = isGroupConversation ? 'Group controls' : 'DM controls';
    const proactiveTitle = isGroupConversation
        ? 'Let group members message you first based on the group schedule and mood'
        : 'Let the character message you first based on their schedule and mood';
    const proactiveLabel = isGroupConversation ? 'Let group members message me first' : 'Let this character message me first';
    const proactiveHint = isGroupConversation
        ? 'These proactive controls apply only to this group Conversation, not solo DMs.'
        : 'Max reply tokens is the generation budget for each Conversation reply. Raise it if messages cut off mid-thought.';
    const relatedMemoryLabel = isGroupConversation ? 'Remember solo DMs in this group DM' : 'Remember group DMs in this solo DM';
    const relatedMemoryHint = isGroupConversation
        ? 'When enabled, this group DM can reference saved memory from this character\'s solo DM.'
        : 'When enabled, this solo DM can reference saved memory from group DMs that include this character.';
    const groundedRulesEdit = '<button type="button" class="menu_button menu_button_icon sb-conversation-pref-suffix" data-sb-conversation-action="edit-grounded-dialogue-rules" title="Edit Grounded Dialogue Rules" aria-label="Edit Grounded Dialogue Rules"><i class="fa-solid fa-pencil" aria-hidden="true"></i></button>';
    return `
        <div class="sb-conversation-settings-header">
            <button type="button" class="sb-conversation-flat-button sb-conversation-settings-close" data-sb-conversation-action="close-settings" title="Close Conversation settings" aria-label="Close Conversation settings">
                <i class="fa-solid fa-xmark sb-conversation-settings-close-x" aria-hidden="true"></i>
                <i class="fa-solid fa-arrow-left sb-conversation-settings-close-back" aria-hidden="true"></i>
            </button>
            <div>
                <div class="sb-conversation-settings-kicker">Conversation Mode</div>
                <div class="sb-conversation-settings-title">${drawerTitle}</div>
            </div>
        </div>
        <div class="sb-conversation-settings-body">
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-signal" aria-hidden="true"></i><span>Presence &amp; availability</span></h4>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_availability">Status</label>
                    <select id="sb_conv_availability" class="text_pole textarea_compact wide100p">
                        <option value="online">Online</option>
                        <option value="idle">Idle</option>
                        <option value="dnd">Do Not Disturb</option>
                        <option value="offline">Offline</option>
                    </select>
                </div>
                <div class="sb-conversation-pref-list">
                    ${buildConversationSwitchRow({ id: 'sb_conv_idle_followup', labelHtml: 'Send auto follow-up <span class="sb-conversation-setting-scope">Global</span>', title: 'After the user has been quiet, send a check-in tied to the current conversation.' })}
                    ${buildConversationSwitchRow({ id: 'sb_conv_idle_spontaneous', labelHtml: 'Spontaneous ping <span class="sb-conversation-setting-scope">Global</span>', title: 'After a longer quiet stretch, start a casual new topic or send an ambient thought.' })}
                </div>
                <p class="sb-conversation-field-hint">Follow-ups react to silence in the current thread. Spontaneous pings can start a fresh thought; when both are enabled, pings wait for a longer quiet stretch.</p>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_idle_limit">Idle Minimum (minutes)</label>
                    <input id="sb_conv_idle_limit" class="text_pole textarea_compact wide100p" type="number" min="1" max="1440" step="1" value="15" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_offline_message">Offline/DND Auto-responder</label>
                    <input id="sb_conv_offline_message" class="text_pole textarea_compact wide100p" type="text" placeholder="[{{user}} is currently offline. Leave a message!]" />
                </div>
                ${buildConversationSwitchRow({ id: 'sb_conv_notifications_muted', labelHtml: 'Mute this DM', title: 'Keep unread badges but suppress sounds and popups for this Conversation.' })}
                <div class="sb-conversation-notification-grid">
                    <label class="sb-conversation-field-stack" for="sb_conv_notification_priority">
                        <span>Priority</span>
                        <select id="sb_conv_notification_priority" class="text_pole textarea_compact wide100p">
                            <option value="normal">Normal</option>
                            <option value="silent">Silent</option>
                            <option value="priority">Priority</option>
                        </select>
                    </label>
                    <label class="sb-conversation-field-stack" for="sb_conv_quiet_hours_start">
                        <span>Quiet start</span>
                        <input id="sb_conv_quiet_hours_start" class="text_pole textarea_compact wide100p sb-conversation-quiet-time-input" type="text" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="HH:MM" />
                    </label>
                    <label class="sb-conversation-field-stack" for="sb_conv_quiet_hours_end">
                        <span>Quiet end</span>
                        <input id="sb_conv_quiet_hours_end" class="text_pole textarea_compact wide100p sb-conversation-quiet-time-input" type="text" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="HH:MM" />
                    </label>
                </div>
                <p class="sb-conversation-field-hint">Unread badges still update while muted or inside quiet hours.</p>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-calendar-days" aria-hidden="true"></i><span>Character schedule</span></h4>
                <p class="sb-conversation-field-hint">Auto-generate a weekly schedule using the current active connection profile and selected model. This informs when the character is available to chat.</p>
                <div class="sb-conversation-field-stack">
                    <div class="sb-conversation-field-row sb-conversation-schedule-actions">
                        <button type="button" class="menu_button sb-conversation-generate-schedule" data-sb-conversation-action="generate-schedule">
                            <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>Generate schedule</span>
                        </button>
                        <button type="button" class="menu_button" data-sb-conversation-action="edit-schedule">
                            <i class="fa-solid fa-pencil" aria-hidden="true"></i><span>Edit schedule</span>
                        </button>
                    </div>
                    <div class="sb-conversation-schedule-display" id="sb_conv_schedule_display" aria-live="polite"></div>
                    <input id="sb_conv_auto_schedule" type="hidden" value="${escapeHtmlAttribute(settings.auto_schedule)}" />
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-comment-dots" aria-hidden="true"></i><span>Proactive messaging</span></h4>
                ${buildConversationSwitchRow({ id: 'sb_conv_proactive_messaging', labelHtml: escapeHtmlText(proactiveLabel), title: proactiveTitle })}
                <div class="sb-conversation-proactive-inputs">
                    <div class="sb-conversation-field-stack">
                        <label for="sb_conv_inactivity_threshold">Patience (mins)</label>
                        <input id="sb_conv_inactivity_threshold" class="text_pole textarea_compact wide100p" type="number" min="15" max="360" step="5" value="120" />
                    </div>
                    <div class="sb-conversation-field-stack">
                        <label for="sb_conv_max_followups">Max follow-ups</label>
                        <input id="sb_conv_max_followups" class="text_pole textarea_compact wide100p" type="number" min="1" max="3" step="1" value="3" />
                    </div>
                    <div class="sb-conversation-field-stack">
                        <label for="sb_conv_talkativeness">Talkativeness</label>
                        <input id="sb_conv_talkativeness" class="text_pole textarea_compact wide100p" type="number" min="0" max="100" step="5" value="50" />
                    </div>
                    <div class="sb-conversation-field-stack">
                        <label for="sb_conv_reply_delay_multiplier">Reply delay</label>
                        <input id="sb_conv_reply_delay_multiplier" class="text_pole textarea_compact wide100p" type="number" min="0" max="300" step="10" value="100" />
                    </div>
                    <div class="sb-conversation-field-stack">
                        <label for="sb_conv_reply_max_tokens">Max reply tokens</label>
                        <input id="sb_conv_reply_max_tokens" class="text_pole textarea_compact wide100p" type="number" min="64" max="64000" step="64" value="16000" />
                    </div>
                </div>
                <p class="sb-conversation-field-hint">${proactiveHint}</p>
                <div class="sb-conversation-pref-list">
                    ${buildConversationSwitchRow({ id: 'sb_conv_selfie_command_enabled', labelHtml: 'Selfies through Quick Image Gen ([selfie])', title: 'Let the character turn [selfie: prompt] into a Quick Image Gen request' })}
                    ${buildConversationSwitchRow({ id: 'sb_conv_schedule_command_enabled', labelHtml: 'Character status updates ([schedule_update])', title: 'Let the character update its current availability/activity through [schedule_update]' })}
                </div>
                <p class="sb-conversation-field-hint">Selfie commands are hidden from the chat and sent as image prompts. Schedule updates let the character adjust what they are doing now.</p>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-brain" aria-hidden="true"></i><span>Chat memories</span></h4>
                <p class="sb-conversation-field-hint">Persistent notes the LLM writes for continuity. They survive deleted chats and only clear when you use Clear memory.</p>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_memory_summary">Conversation memory</label>
                    <textarea id="sb_conv_memory_summary" class="text_pole textarea_compact wide100p sb-conversation-memory-summary" rows="5" readonly placeholder="No memory summary yet. It appears after enough messages, or you can refresh it manually once this Conversation has chat history."></textarea>
                    <p id="sb_conv_memory_meta" class="sb-conversation-field-hint sb-conversation-memory-meta"></p>
                </div>
                <div class="sb-conversation-field-row sb-conversation-memory-actions">
                    <button type="button" class="menu_button" data-sb-conversation-action="create-memory">
                        <i class="fa-solid fa-plus" aria-hidden="true"></i><span>Create memory</span>
                    </button>
                    <button type="button" class="menu_button" data-sb-conversation-action="refresh-memory">
                        <i class="fa-solid fa-rotate" aria-hidden="true"></i><span>Refresh memory</span>
                    </button>
                    <button type="button" class="menu_button" data-sb-conversation-action="clear-memory">
                        <i class="fa-solid fa-eraser" aria-hidden="true"></i><span>Clear memory</span>
                    </button>
                </div>
                <input id="sb_conv_copy_memory_to_new_branch" type="checkbox" hidden />
                <p class="sb-conversation-field-hint">Memory is kept across new chats and deleted histories until you clear it.</p>
                ${buildConversationSwitchRow({ id: 'sb_conv_include_related_memory', labelHtml: escapeHtmlText(relatedMemoryLabel), title: 'Share saved memory summaries between this character\'s solo and group Conversation threads' })}
                <p class="sb-conversation-field-hint">${relatedMemoryHint}</p>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-clock" aria-hidden="true"></i><span>Manual scheduling</span></h4>
                <p class="sb-conversation-field-hint">Use this for fixed-time check-ins. Weekly slots decide when messages can happen; cooldown prevents repeated sends too close together.</p>
                ${buildConversationSwitchRow({ id: 'sb_conv_auto_message', labelHtml: 'Enable Scheduling', title: 'Enable autonomous scheduled messages' })}
                <label class="sb-conversation-field-stack sb-conversation-inline-number" title="Auto-message minimum delay/cooldown in seconds">
                    <span>Cooldown</span>
                    <span class="sb-conversation-inline-number-row">
                        <input id="sb_conv_cooldown" class="text_pole textarea_compact widthUnset" type="number" min="10" max="9999" step="1" value="60" />
                        <span class="auto_mode_delay_unit">secs</span>
                    </span>
                </label>
                <div class="sb-conversation-field-stack">
                    <label>Weekly Schedule</label>
                    <div class="sb-conversation-weekly-schedule" id="sb_conv_weekly_schedule_editor"></div>
                    <button type="button" class="menu_button sb-conversation-weekly-add" data-sb-conversation-action="weekly-add">
                        <i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add weekly slot</span>
                    </button>
                    <input id="sb_conv_weekly_schedule" type="hidden" value="${escapeHtmlAttribute(settings.weekly_schedule)}" />
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-scroll" aria-hidden="true"></i><span>Prompts &amp; formats</span></h4>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_geechan_chatroom_prompt">Geechan Chatroom System Prompt</label>
                    <textarea id="sb_conv_geechan_chatroom_prompt" class="text_pole textarea_compact autoSetHeight wide100p" rows="3" placeholder="Type the chatroom system prompt here..."></textarea>
                    <button type="button" class="menu_button sb-conversation-reset-prompt" data-sb-conversation-action="reset-prompt">
                        <i class="fa-solid fa-rotate-left" aria-hidden="true"></i><span>Reset to default</span>
                    </button>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_custom_instructions">Custom Instructions <span class="sb-conversation-setting-scope">Global</span></label>
                    <textarea id="sb_conv_custom_instructions" class="text_pole textarea_compact autoSetHeight wide100p" rows="3" placeholder="Type any custom instructions or guidelines here..."></textarea>
                    <p class="sb-conversation-field-hint">Applies to every solo and group Conversation DM.</p>
                </div>
                <div class="sb-conversation-field-stack">
                    ${buildConversationSwitchRow({ id: 'sb_conv_grounded_dialogue_rules_enabled', labelHtml: 'Grounded Dialogue Rules <span class="sb-conversation-setting-scope">Global</span>', title: 'Apply the global Grounded Dialogue Rules block to Conversation Mode prompts.', extra: groundedRulesEdit })}
                    <textarea id="sb_conv_grounded_dialogue_rules" hidden></textarea>
                    <p class="sb-conversation-field-hint">Optional anti-cliché style guard. Use the pencil to edit the full rules without expanding this drawer.</p>
                </div>
                ${buildConversationSwitchRow({ id: 'sb_conv_multi_char', labelHtml: 'Add additional members in the chat', title: 'Enable additional characters in the chat to chime in' })}
                <div id="sb_conv_group_members_wrapper" class="sb-conversation-field-stack">
                    <div class="sb-conversation-field-stack">
                        <label>Group DM Members</label>
                        <p class="sb-conversation-field-hint">Selected characters are considered part of this Conversation thread. Type @Name, such as @Kaveh, to tag them. Autonomous character-to-character chat uses this same group list.</p>
                        <input type="text" id="sb_conv_multi_char_search" class="text_pole textarea_compact wide100p sb-conversation-member-search" placeholder="Search group members..." />
                        <div class="sb-conversation-partner-list" id="sb_conv_chiming_partner_list">${buildChimingPartnerOptions(settings.multi_char_names)}</div>
                        <input id="sb_conv_multi_char_names" type="hidden" value="${escapeHtmlAttribute(settings.multi_char_names)}" />
                    </div>
                    ${buildConversationSwitchRow({ id: 'sb_conv_auto_character_chat', labelHtml: 'Allow characters to talk to each other', title: 'Allow enabled characters to chat with each other autonomously in this thread' })}
                    <label class="sb-conversation-field-stack sb-conversation-inline-number" title="Minimum time between autonomous character-to-character messages in this Conversation thread">
                        <span>Character chat cooldown</span>
                        <span class="sb-conversation-inline-number-row">
                            <input id="sb_conv_auto_chat_cooldown" class="text_pole textarea_compact widthUnset" type="number" min="1" max="1440" step="1" value="${DEFAULT_AUTO_CHAT_COOLDOWN}" />
                            <span class="auto_mode_delay_unit">mins</span>
                        </span>
                    </label>
                </div>
                ${buildConversationSwitchRow({ id: 'sb_conv_roleplay_reactions', labelHtml: 'React to current roleplay', title: 'Allow this character to privately react to the current roleplay or group chat' })}
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-book-atlas" aria-hidden="true"></i><span>Context overrides</span></h4>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_lorebook_override">Lorebook Override</label>
                    <select id="sb_conv_lorebook_override" class="text_pole textarea_compact wide100p">
                        ${buildLorebookOptions(settings.lorebook_override)}
                    </select>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_connection_profile">Connection Profile <span class="sb-conversation-setting-scope">Global</span></label>
                    <select id="sb_conv_connection_profile" class="text_pole textarea_compact wide100p">
                        ${buildConnectionProfileOptions(settings.connection_profile)}
                    </select>
                    <p class="sb-conversation-field-hint">Used for all Conversation Mode generations unless left on the current active connection.</p>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_authors_note">Author's Note Override</label>
                    <textarea id="sb_conv_authors_note" class="text_pole textarea_compact autoSetHeight wide100p" rows="2" placeholder="[Author's Note: Keep responses short, direct, and conversational as if chatting in a DM.]"></textarea>
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-image" aria-hidden="true"></i><span>Image generation</span></h4>
                ${buildConversationSwitchRow({ id: 'sb_conv_image_gen_enabled', labelHtml: 'Enable chatroom image generation', title: 'Enable in-chat image generation' })}
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_image_gen_prompt_template">Image Prompt Template</label>
                    <input id="sb_conv_image_gen_prompt_template" type="text" class="text_pole wide100p" placeholder="a photo of {{char}}, {{scene}}" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_image_gen_negative">Negative Prompt</label>
                    <input id="sb_conv_image_gen_negative" type="text" class="text_pole wide100p" placeholder="blurry, distorted" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_image_gen_cooldown">Image Cooldown (minutes)</label>
                    <input id="sb_conv_image_gen_cooldown" type="number" min="0" max="1440" step="1" class="text_pole wide100p" value="10" />
                </div>
                ${buildConversationSwitchRow({ id: 'sb_conv_spontaneous_selfies', labelHtml: 'Enable Spontaneous Selfies', title: 'Character spontaneously generates selfies during the conversation' })}
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_selfie_prompt">Selfie Prompt Template</label>
                    <input id="sb_conv_selfie_prompt" type="text" class="text_pole wide100p" placeholder="raw photo, selfie of {{char}}" />
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>DM tweaks</span></h4>
                <div class="sb-conversation-pref-list">
                    ${buildConversationSwitchRow({ id: 'sb_conv_editable_messages', labelHtml: 'Enable Quick-Edit DM Actions', title: 'Add quick inline edit buttons next to messages in the Conversation thread' })}
                    ${buildConversationSwitchRow({ id: 'sb_conv_prose_polisher', labelHtml: 'Character Prose Polisher', title: 'Enable a magic wand icon on character replies to polish and refine their outputs.' })}
                </div>
            </div>
        </div>
    `;
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
            <button id="${CHROME_IDS.palsToggle}" type="button" class="sb-conversation-flat-button sb-conversation-header-back" data-sb-conversation-action="toggle-pals" title="Back to conversations" aria-label="Back to conversations">
                <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
                <span class="sb-conversation-pals-toggle-badge" hidden></span>
            </button>
            <div class="sb-conversation-header-avatar" data-sb-conversation-participants></div>
            <button type="button" class="sb-conversation-header-title" data-sb-conversation-action="open-branch-menu" aria-haspopup="menu" title="Branches">
                <span class="sb-conversation-header-copy">
                    <span class="sb-conversation-header-name" data-sb-conversation-name>Conversation</span>
                    <span class="sb-conversation-header-status" data-sb-conversation-status></span>
                </span>
                <i class="fa-solid fa-chevron-down sb-conversation-header-caret" aria-hidden="true"></i>
            </button>
            <div class="sb-conversation-header-actions">
                <button type="button" class="sb-conversation-flat-button sb-conversation-header-search" data-sb-conversation-action="toggle-search" title="Search" aria-label="Search" aria-pressed="false" aria-controls="${CHROME_IDS.tools}">
                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                </button>
                <button type="button" class="sb-conversation-flat-button sb-conversation-header-settings" data-sb-conversation-action="open-settings" title="Conversation settings" aria-label="Conversation settings">
                    <i class="fa-solid fa-gear" aria-hidden="true"></i>
                </button>
                <button type="button" class="sb-conversation-flat-button sb-conversation-header-menu" data-sb-conversation-action="open-conversation-menu" title="Conversation menu" aria-label="Conversation menu" aria-haspopup="menu">
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
        stage.setAttribute('aria-label', 'Conversation messages');
        stage.innerHTML = `
            <div id="${CHROME_IDS.tools}" class="sb-conversation-search-bar" role="search" aria-label="Search this conversation" data-open="false">
                <label class="sb-conversation-search-wrap" for="${CHROME_IDS.search}">
                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                    <span class="sr-only">Search Conversation messages</span>
                    <input id="${CHROME_IDS.search}" class="sb-conversation-search-entry" type="search" placeholder="Search this DM" autocomplete="off" />
                </label>
                <div class="sb-conversation-channel-tabs" role="toolbar" aria-label="Conversation filters">
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="main" aria-pressed="true">Main</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="pinned" aria-pressed="false">Pins</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="selfies" aria-pressed="false">Selfies</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="media" aria-pressed="false">Files</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="ooc" aria-pressed="false">OOC</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="memories" aria-pressed="false">Memories</button>
                </div>
            </div>
            <div id="${CHROME_IDS.timeline}" class="sb-conversation-timeline" role="log" aria-live="polite"></div>
            <div id="${CHROME_IDS.dropHint}" class="sb-conversation-drop-hint" hidden>Drop files to attach</div>
            <form id="${CHROME_IDS.form}" class="sb-conversation-composer">
                <div id="${CHROME_IDS.replyPreview}" class="sb-conversation-reply-preview" hidden></div>
                <div id="${CHROME_IDS.attachmentPreview}" class="sb-conversation-attachment-preview" hidden></div>
                <div class="sb-conversation-composer-row">
                    <button type="button" class="sb-conversation-flat-button sb-conversation-composer-more" data-sb-conversation-action="open-composer-menu" title="Attach and more" aria-label="Attach and more" aria-haspopup="menu">
                        <i class="fa-solid fa-plus" aria-hidden="true"></i>
                    </button>
                    <button id="${CHROME_IDS.attach}" type="button" class="sb-conversation-flat-button sb-conversation-composer-attach sb-conversation-composer-quick" data-sb-conversation-action="attach-file" title="Attach files" aria-label="Attach files">
                        <i class="fa-solid fa-paperclip" aria-hidden="true"></i>
                    </button>
                    <input id="${CHROME_IDS.fileInput}" class="displayNone" type="file" accept="${CONVERSATION_ATTACHMENT_ACCEPT}" multiple aria-label="Conversation attachments" />
                    <label class="sr-only" for="${CHROME_IDS.input}">Conversation message</label>
                    <textarea id="${CHROME_IDS.input}" class="text_pole" rows="1" placeholder="Type your message..."></textarea>
                    <div class="sb-conversation-composer-actions" role="group" aria-label="Message tools">
                        <button type="button" class="sb-conversation-flat-button sb-conversation-composer-quick" data-sb-conversation-action="quick-selfie" title="Send a selfie" aria-label="Send a selfie">
                            <i class="fa-solid fa-camera" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="sb-conversation-flat-button sb-conversation-composer-quick" data-sb-conversation-action="quick-remind" title="Remind me" aria-label="Remind me">
                            <i class="fa-solid fa-bell" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="sb-conversation-flat-button sb-conversation-composer-quick" data-sb-conversation-action="quick-summarize" title="Summarize memory" aria-label="Summarize memory">
                            <i class="fa-solid fa-book-open" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="sb-conversation-flat-button sb-conversation-composer-quick" data-sb-conversation-action="force-response" title="Force a reply" aria-label="Force a reply">
                            <i class="fa-solid fa-bolt" aria-hidden="true"></i>
                        </button>
                    </div>
                    <button id="${CHROME_IDS.send}" type="submit" class="sb-conversation-send-button" title="Send Conversation message" aria-label="Send Conversation message">
                        <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
                    </button>
                </div>
            </form>
        `;
        sheld.insertBefore(stage, chatElement);
    }

    let palsRail = document.getElementById(CHROME_IDS.palsRail);
    if (!(palsRail instanceof HTMLElement)) {
        palsRail = document.createElement('aside');
        palsRail.id = CHROME_IDS.palsRail;
        palsRail.hidden = true;
        palsRail.setAttribute('aria-label', 'Conversations');
        palsRail.innerHTML = `
            <div class="sb-conversation-headerbar sb-conversation-rail-header">
                <div id="${CHROME_IDS.railFooter}" class="sb-conversation-rail-persona">
                    <button type="button" class="sb-conversation-flat-button sb-conversation-persona-button" data-sb-conversation-action="open-persona-menu" aria-haspopup="menu" title="Your status and persona">
                        <img id="sb_conv_footer_persona_avatar" alt="" loading="lazy" />
                        <span class="sb-conversation-status-dot sb-conversation-rail-footer-dot" data-status="online" aria-hidden="true"></span>
                        <span class="sr-only"><span id="sb_conv_footer_persona_name"></span>, <span id="sb_conv_footer_user_status"></span></span>
                    </button>
                </div>
                <h2 class="sb-conversation-rail-title">Conversations</h2>
                <button type="button" class="sb-conversation-flat-button sb-conversation-rail-new-button" data-sb-conversation-action="open-new-menu" aria-haspopup="menu" title="New conversation" aria-label="New conversation">
                    <i class="fa-solid fa-plus" aria-hidden="true"></i>
                </button>
            </div>
            <div class="sb-conversation-rail-search">
                <label class="sb-conversation-search-wrap" for="sb_conversation_pals_search">
                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                    <span class="sr-only">Search conversations</span>
                    <input type="search" id="sb_conversation_pals_search" class="sb-conversation-search-entry" placeholder="Search" autocomplete="off" />
                </label>
            </div>
            <div id="${CHROME_IDS.palsList}" class="sb-conversation-pals-list"></div>
        `;
        sheld.insertBefore(palsRail, header);
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

    if (!(document.getElementById(CHROME_IDS.addDmPicker) instanceof HTMLElement)) {
        const addDmPicker = document.createElement('div');
        addDmPicker.id = CHROME_IDS.addDmPicker;
        addDmPicker.className = 'sb-conversation-picker sb-conversation-add-dm-picker';
        addDmPicker.setAttribute('role', 'dialog');
        addDmPicker.setAttribute('aria-label', 'Start a conversation');
        addDmPicker.hidden = true;
        sheld.appendChild(addDmPicker);
    }

    if (!(document.getElementById(CHROME_IDS.personaPicker) instanceof HTMLElement)) {
        const personaPicker = document.createElement('div');
        personaPicker.id = CHROME_IDS.personaPicker;
        personaPicker.className = 'sb-conversation-picker sb-conversation-persona-picker';
        personaPicker.setAttribute('role', 'listbox');
        personaPicker.setAttribute('aria-label', 'Choose persona');
        personaPicker.hidden = true;
        sheld.appendChild(personaPicker);
    }

    if (!(document.getElementById(CHROME_IDS.userStatusPicker) instanceof HTMLElement)) {
        const statusPicker = document.createElement('div');
        statusPicker.id = CHROME_IDS.userStatusPicker;
        statusPicker.className = 'sb-conversation-picker sb-conversation-status-picker';
        statusPicker.setAttribute('role', 'listbox');
        statusPicker.setAttribute('aria-label', 'Set your status');
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

    let backdrop = document.getElementById(CHROME_IDS.settingsBackdrop);
    if (!(backdrop instanceof HTMLElement)) {
        backdrop = document.createElement('div');
        backdrop.id = CHROME_IDS.settingsBackdrop;
        backdrop.hidden = true;
        sheld.appendChild(backdrop);
    }

    let drawer = document.getElementById(CHROME_IDS.settingsDrawer);
    if (!(drawer instanceof HTMLElement)) {
        drawer = document.createElement('aside');
        drawer.id = CHROME_IDS.settingsDrawer;
        drawer.hidden = true;
        drawer.setAttribute('aria-label', 'Conversation settings');
        drawer.innerHTML = buildSettingsDrawerHtml();
        sheld.appendChild(drawer);
    }

    bindConversationChromeControlsAsync(sheld);
    return { sheld, header, stage, palsRail, backdrop, drawer };
}

registerConversationRenderer('timeline', renderConversationTimeline);
