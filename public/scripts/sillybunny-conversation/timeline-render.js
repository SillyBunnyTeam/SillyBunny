import {
    characters,
    default_user_avatar,
    getThumbnailUrl,
    messageFormatting,
    name1,
} from '../../script.js';
import { user_avatar } from '../personas.js';
import { world_names } from '../world-info.js';
import {
    CHROME_IDS,
    CONVERSATION_ATTACHMENT_ACCEPT,
    CONVERSATION_REACTION_LABELS,
    CONVERSATION_TIMELINE_CHANNELS,
    DEFAULT_AUTO_CHAT_COOLDOWN,
    SELFIE_COMMAND_RE,
} from './constants.js';
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

function truncateConversationReplyPreview(value, maxLength = 160) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
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
        ? user_avatar
        : message.role === 'partner' || message.role === 'system'
            ? message.extra?.partner_avatar || avatar
            : avatar;
    if (messageAvatar) {
        avatarWrap.dataset.sbConversationAction = 'zoom-avatar';
        avatarWrap.dataset.avatarFile = messageAvatar;
        avatarWrap.dataset.avatarType = message.role === 'user' ? 'persona' : 'avatar';
        avatarWrap.tabIndex = 0;
        avatarWrap.role = 'button';
        avatarWrap.setAttribute('aria-label', `Show full picture for ${message.name || (message.role === 'user' ? name1 || 'You' : getCurrentCharName())}`);
    }
    const image = document.createElement('img');
    image.alt = '';
    image.loading = index > 8 ? 'lazy' : 'eager';
    image.src = getConversationMessageAvatar(message, avatar);
    avatarWrap.appendChild(image);

    if (messageAvatar && message.role !== 'user' && message.role !== 'system') {
        const statusDot = document.createElement('span');
        statusDot.className = 'sb-conversation-status-dot';
        statusDot.dataset.status = getEffectiveConversationStatus(messageAvatar, getSettings(messageAvatar, { groupId }));
        statusDot.setAttribute('aria-hidden', 'true');
        avatarWrap.appendChild(statusDot);
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
    time.textContent = message.send_date || '';
    meta.append(name, time);

    const receiptText = getConversationMessageReceipt(message, avatar, { groupId });
    if (receiptText) {
        const receipt = document.createElement('span');
        receipt.className = 'sb-conversation-message-receipt';
        receipt.textContent = receiptText;
        meta.appendChild(receipt);
    }

    const actionBar = document.createElement('span');
    actionBar.className = 'sb-conversation-message-actions';

    if (settings.editable_messages) {
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'sb-conversation-message-action sb-conversation-message-edit fa-solid fa-pencil';
        editButton.title = 'Edit Conversation message';
        editButton.setAttribute('aria-label', 'Edit Conversation message');
        editButton.dataset.sbConversationAction = 'edit-message';
        editButton.dataset.messageId = message.id;
        actionBar.appendChild(editButton);
    }

    if (settings.prose_polisher && message.role !== 'user') {
        const polishButton = document.createElement('button');
        polishButton.type = 'button';
        polishButton.className = 'sb-conversation-message-action sb-conversation-message-polish fa-solid fa-wand-magic-sparkles';
        polishButton.title = 'Polish character message';
        polishButton.setAttribute('aria-label', 'Polish character message');
        polishButton.dataset.sbConversationAction = 'polish-character-message';
        polishButton.dataset.messageId = message.id;
        actionBar.appendChild(polishButton);
    }

    const messageActions = [
        { action: 'reply-message', icon: 'fa-reply', label: 'Reply' },
        { action: 'copy-message', icon: 'fa-copy', label: 'Copy message' },
        { action: 'toggle-message-pin', icon: 'fa-thumbtack', label: message.extra?.conversation_pinned ? 'Unpin message' : 'Pin message' },
        { action: 'branch-from-message', icon: 'fa-code-branch', label: 'Branch from here' },
    ];
    if (!['user', 'system'].includes(message.role || '')) {
        messageActions.push({ action: 'speak-message', icon: 'fa-volume-high', label: 'Speak' });
        messageActions.push({ action: 'regenerate-message', icon: 'fa-rotate-right', label: 'Regenerate message' });
    }
    messageActions.push({ action: 'delete-message', icon: 'fa-trash-can', label: 'Delete message' });
    for (const messageAction of messageActions) {
        const actionButton = document.createElement('button');
        actionButton.type = 'button';
        actionButton.className = `sb-conversation-message-action fa-solid ${messageAction.icon}`;
        actionButton.title = messageAction.label;
        actionButton.setAttribute('aria-label', messageAction.label);
        actionButton.dataset.sbConversationAction = messageAction.action;
        actionButton.dataset.messageId = message.id;
        actionBar.appendChild(actionButton);
    }
    for (const reaction of Object.keys(CONVERSATION_REACTION_LABELS)) {
        const reactionButton = document.createElement('button');
        reactionButton.type = 'button';
        reactionButton.className = 'sb-conversation-reaction-button';
        reactionButton.textContent = normalizeConversationReactionLabel(reaction);
        reactionButton.dataset.sbConversationAction = 'react-message';
        reactionButton.dataset.messageId = message.id;
        reactionButton.dataset.reaction = reaction;
        actionBar.appendChild(reactionButton);
    }

    const mobileTrigger = document.createElement('button');
    mobileTrigger.type = 'button';
    mobileTrigger.className = 'sb-conversation-mobile-menu-trigger fa-solid fa-ellipsis';
    mobileTrigger.title = 'Message options';
    mobileTrigger.setAttribute('aria-label', 'Message options');

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
    if (activeReactions.length) {
        const reactions = document.createElement('div');
        reactions.className = 'sb-conversation-message-reactions';
        for (const [reaction, count] of activeReactions) {
            const chip = document.createElement('span');
            chip.className = 'sb-conversation-message-reaction-chip';
            chip.textContent = `${normalizeConversationReactionLabel(reaction)} ${count}`;
            reactions.appendChild(chip);
        }
        text.appendChild(reactions);
    }

    if (replyReference) {
        bubble.append(meta, replyReference, text, actionBar, mobileTrigger);
    } else {
        bubble.append(meta, text, actionBar, mobileTrigger);
    }
    item.append(avatarWrap, bubble);
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

    const typingParticipants = getActiveTypingParticipants(avatar, { branchId, groupId, personaId });
    if (typingParticipants.length > 2) {
        const typingItem = document.createElement('div');
        typingItem.className = 'sb-conversation-message sb-conversation-typing-indicator';
        typingItem.dataset.role = 'partner';

        const typingAvatarWrap = document.createElement('div');
        typingAvatarWrap.className = 'sb-conversation-message-avatar';
        const typingImage = document.createElement('img');
        typingImage.alt = '';
        typingImage.src = getThumbnailUrl('avatar', typingParticipants[0]?.avatar) || default_user_avatar;
        typingAvatarWrap.appendChild(typingImage);

        const typingBubble = document.createElement('div');
        typingBubble.className = 'sb-conversation-message-bubble';
        typingBubble.innerHTML = `
            <div class="sb-conversation-message-meta">
                <span class="sb-conversation-message-name">Several people</span>
            </div>
            <div class="sb-conversation-message-text" style="font-style: italic; opacity: 0.8; display: flex; align-items: center; gap: 8px;">
                <span>Several people are typing</span>
                <span class="sb-conversation-typing-dots">
                    <span></span><span></span><span></span>
                </span>
            </div>
        `;
        typingItem.append(typingAvatarWrap, typingBubble);
        timeline.appendChild(typingItem);
    } else {
        for (const typingParticipant of typingParticipants) {
            const typingAvatar = typingParticipant?.avatar || getCurrentCharAvatar();
            const typingName = typingParticipant?.name || getCurrentCharName();
            const typingItem = document.createElement('div');
            typingItem.className = 'sb-conversation-message sb-conversation-typing-indicator';
            typingItem.dataset.role = typingAvatar !== getCurrentCharAvatar() ? 'partner' : 'character';

            const typingAvatarWrap = document.createElement('div');
            typingAvatarWrap.className = 'sb-conversation-message-avatar';
            const typingImage = document.createElement('img');
            typingImage.alt = '';
            typingImage.src = getThumbnailUrl('avatar', typingAvatar) || default_user_avatar;
            typingAvatarWrap.appendChild(typingImage);

            const typingBubble = document.createElement('div');
            typingBubble.className = 'sb-conversation-message-bubble';
            typingBubble.innerHTML = `
                <div class="sb-conversation-message-meta">
                    <span class="sb-conversation-message-name">${escapeHtmlText(typingName)}</span>
                </div>
                <div class="sb-conversation-message-text sb-conversation-typing-dots">
                    <span></span><span></span><span></span>
                </div>
            `;
            typingItem.append(typingAvatarWrap, typingBubble);
            timeline.appendChild(typingItem);
        }
    }

    if (conversationState.imageGenerationActive) {
        const pendingParticipant = getPrimaryTypingParticipant(avatar, { branchId, groupId, personaId });
        const pendingAvatar = pendingParticipant?.avatar || getCurrentCharAvatar();
        const imageItem = document.createElement('div');
        imageItem.className = 'sb-conversation-message sb-conversation-image-pending';
        imageItem.dataset.role = pendingParticipant && pendingAvatar !== getCurrentCharAvatar() ? 'partner' : 'character';
        const imageAvatarWrap = document.createElement('div');
        imageAvatarWrap.className = 'sb-conversation-message-avatar';
        const pendingImage = document.createElement('img');
        pendingImage.alt = '';
        pendingImage.src = getThumbnailUrl('avatar', pendingAvatar) || default_user_avatar;
        imageAvatarWrap.appendChild(pendingImage);
        const imageBubble = document.createElement('div');
        imageBubble.className = 'sb-conversation-message-bubble';
        imageBubble.innerHTML = `
            <div class="sb-conversation-message-meta">
                <span class="sb-conversation-message-name">Image generation</span>
                <button type="button" class="sb-conversation-stop-image" data-sb-conversation-action="stop-image-generation">Stop</button>
            </div>
            <div class="sb-conversation-message-text sb-conversation-typing-dots">
                <span></span><span></span><span></span>
            </div>
        `;
        imageItem.append(imageAvatarWrap, imageBubble);
        timeline.appendChild(imageItem);
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
    const context = globalThis.prompt?.('Describe the selfie context', 'a casual selfie in the current DM conversation');
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
    const delay = globalThis.prompt?.('When should the reminder fire?', '1h');
    if (typeof delay !== 'string' || !delay.trim()) {
        return;
    }

    const memo = globalThis.prompt?.('Reminder text', 'Reply to this later');
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
    return `
        <div class="sb-conversation-settings-header">
            <div>
                <div class="sb-conversation-settings-kicker">Conversation Mode</div>
                <div class="sb-conversation-settings-title">${drawerTitle}</div>
            </div>
            <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="close-settings" title="Close Conversation settings" aria-label="Close Conversation settings">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="sb-conversation-settings-body">
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-signal" aria-hidden="true"></i><span>Presence & Availability</span></h4>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_availability">Status</label>
                    <select id="sb_conv_availability" class="text_pole textarea_compact wide100p">
                        <option value="online">Online</option>
                        <option value="idle">Idle</option>
                        <option value="dnd">Do Not Disturb</option>
                        <option value="offline">Offline</option>
                    </select>
                </div>
                <div class="sb-conversation-field-stack">
                    <label>User Idle Actions <span class="sb-conversation-setting-scope">Global</span></label>
                    <div class="sb-conversation-idle-actions">
                        <label class="checkbox_label" title="After the user has been quiet, send a check-in tied to the current conversation.">
                            <input id="sb_conv_idle_followup" type="checkbox" />
                            <span>Send auto follow-up</span>
                        </label>
                        <label class="checkbox_label" title="After a longer quiet stretch, start a casual new topic or send an ambient thought.">
                            <input id="sb_conv_idle_spontaneous" type="checkbox" />
                            <span>Spontaneous ping</span>
                        </label>
                    </div>
                    <p class="sb-conversation-field-hint">Follow-ups react to silence in the current thread. Spontaneous pings can start a fresh thought; when both are enabled, pings wait for a longer quiet stretch.</p>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_idle_limit">Idle Minimum (minutes)</label>
                    <input id="sb_conv_idle_limit" class="text_pole textarea_compact wide100p" type="number" min="1" max="1440" step="1" value="15" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_offline_message">Offline/DND Auto-responder</label>
                    <input id="sb_conv_offline_message" class="text_pole textarea_compact wide100p" type="text" placeholder="[{{user}} is currently offline. Leave a message!]" />
                </div>
                <div class="sb-conversation-field-stack">
                    <label>DM Notifications</label>
                    <div class="sb-conversation-notification-grid">
                        <label class="checkbox_label" title="Keep unread badges but suppress sounds and popups for this Conversation.">
                            <input id="sb_conv_notifications_muted" type="checkbox" />
                            <span>Mute this DM</span>
                        </label>
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
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-calendar-days" aria-hidden="true"></i><span>Character Schedule</span></h4>
                <p class="sb-conversation-field-hint">Auto-generate a weekly schedule using the current active connection profile and selected model. This informs when the character is available to chat.</p>
                <div class="sb-conversation-field-stack">
                    <div class="sb-conversation-field-row" style="gap: 8px;">
                        <button type="button" class="menu_button sb-conversation-generate-schedule" data-sb-conversation-action="generate-schedule" style="flex: 1;">
                            <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>Generate schedule</span>
                        </button>
                        <button type="button" class="menu_button" data-sb-conversation-action="edit-schedule" style="flex: 1;">
                            <i class="fa-solid fa-pencil" aria-hidden="true"></i><span>Edit schedule</span>
                        </button>
                    </div>
                    <div class="sb-conversation-schedule-display" id="sb_conv_schedule_display" aria-live="polite"></div>
                    <input id="sb_conv_auto_schedule" type="hidden" value="${escapeHtmlAttribute(settings.auto_schedule)}" />
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-comment-dots" aria-hidden="true"></i><span>Proactive Messaging</span></h4>
                <label class="checkbox_label" title="${escapeHtmlAttribute(proactiveTitle)}">
                    <input id="sb_conv_proactive_messaging" type="checkbox" />
                    <span>${proactiveLabel}</span>
                </label>
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
                <div class="sb-conversation-field-row">
                    <label class="checkbox_label" title="Let the character turn [selfie: prompt] into a Quick Image Gen request">
                        <input id="sb_conv_selfie_command_enabled" type="checkbox" />
                        <span>Selfies through Quick Image Gen ([selfie])</span>
                    </label>
                    <label class="checkbox_label" title="Let the character update its current availability/activity through [schedule_update]">
                        <input id="sb_conv_schedule_command_enabled" type="checkbox" />
                        <span>Character status updates ([schedule_update])</span>
                    </label>
                </div>
                <p class="sb-conversation-field-hint">Selfie commands are hidden from the chat and sent as image prompts. Schedule updates let the character adjust what they are doing now.</p>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-brain" aria-hidden="true"></i><span>Chat Memories</span></h4>
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
                <label class="checkbox_label" title="Share saved memory summaries between this character's solo and group Conversation threads">
                    <input id="sb_conv_include_related_memory" type="checkbox" />
                    <span>${relatedMemoryLabel}</span>
                </label>
                <p class="sb-conversation-field-hint">${relatedMemoryHint}</p>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-clock" aria-hidden="true"></i><span>Manual Scheduling (optional)</span></h4>
                <p class="sb-conversation-field-hint">Use this for fixed-time check-ins. Weekly slots decide when messages can happen; cooldown prevents repeated sends too close together.</p>
                <div class="sb-conversation-field-row">
                    <label class="checkbox_label" title="Enable autonomous scheduled messages">
                        <input id="sb_conv_auto_message" type="checkbox" />
                        <span>Enable Scheduling</span>
                    </label>
                    <label class="checkbox_label sb-conversation-inline-number" title="Auto-message minimum delay/cooldown in seconds">
                        <span>Cooldown</span>
                        <input id="sb_conv_cooldown" class="text_pole textarea_compact widthUnset" type="number" min="10" max="9999" step="1" value="60" />
                        <span class="auto_mode_delay_unit">secs</span>
                    </label>
                </div>
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
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-scroll" aria-hidden="true"></i><span>Prompts & Formats</span></h4>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_geechan_chatroom_prompt">Geechan Chatroom System Prompt</label>
                    <textarea id="sb_conv_geechan_chatroom_prompt" class="text_pole textarea_compact autoSetHeight wide100p" rows="3" placeholder="Type the chatroom system prompt here..."></textarea>
                    <button type="button" class="menu_button sb-conversation-reset-prompt" data-sb-conversation-action="reset-prompt" style="margin-top: 4px; align-self: flex-start; padding: 4px 8px; font-size: var(--sb-type-meta);">
                        <i class="fa-solid fa-rotate-left" aria-hidden="true"></i><span>Reset to default</span>
                    </button>
                </div>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_custom_instructions">Custom Instructions <span class="sb-conversation-setting-scope">Global</span></label>
                    <textarea id="sb_conv_custom_instructions" class="text_pole textarea_compact autoSetHeight wide100p" rows="3" placeholder="Type any custom instructions or guidelines here..."></textarea>
                    <p class="sb-conversation-field-hint">Applies to every solo and group Conversation DM.</p>
                </div>
                <div class="sb-conversation-field-stack">
                    <div class="sb-conversation-field-row" style="align-items: center; gap: 8px;">
                        <label class="checkbox_label" title="Apply the global Grounded Dialogue Rules block to Conversation Mode prompts." style="flex: 1; min-width: 0;">
                            <input id="sb_conv_grounded_dialogue_rules_enabled" type="checkbox" />
                            <span>Grounded Dialogue Rules <span class="sb-conversation-setting-scope">Global</span></span>
                        </label>
                        <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="edit-grounded-dialogue-rules" title="Edit Grounded Dialogue Rules" aria-label="Edit Grounded Dialogue Rules">
                            <i class="fa-solid fa-pencil" aria-hidden="true"></i>
                        </button>
                    </div>
                    <textarea id="sb_conv_grounded_dialogue_rules" hidden></textarea>
                    <p class="sb-conversation-field-hint">Optional anti-cliché style guard. Use the pencil to edit the full rules without expanding this drawer.</p>
                </div>
                <label class="checkbox_label" title="Enable additional characters in the chat to chime in">
                    <input id="sb_conv_multi_char" type="checkbox" />
                    <span>Add additional members in the chat</span>
                </label>
                <div id="sb_conv_group_members_wrapper" class="sb-conversation-field-stack">
                    <div class="sb-conversation-field-stack" style="margin: 0; padding: 0;">
                        <label>Group DM Members</label>
                        <p class="sb-conversation-field-hint">Selected characters are considered part of this Conversation thread. Type @Name, such as @Kaveh, to tag them. Autonomous character-to-character chat uses this same group list.</p>
                        <input type="text" id="sb_conv_multi_char_search" class="text_pole textarea_compact wide100p" placeholder="Search group members..." style="margin-bottom: 8px;" />
                        <div class="sb-conversation-partner-list" id="sb_conv_chiming_partner_list">${buildChimingPartnerOptions(settings.multi_char_names)}</div>
                        <input id="sb_conv_multi_char_names" type="hidden" value="${escapeHtmlAttribute(settings.multi_char_names)}" />
                    </div>
                    <label class="checkbox_label" title="Allow enabled characters to chat with each other autonomously in this thread">
                        <input id="sb_conv_auto_character_chat" type="checkbox" />
                        <span>Allow characters to talk to each other</span>
                    </label>
                    <label class="checkbox_label sb-conversation-inline-number" title="Minimum time between autonomous character-to-character messages in this Conversation thread">
                        <span>Character chat cooldown</span>
                        <input id="sb_conv_auto_chat_cooldown" class="text_pole textarea_compact widthUnset" type="number" min="1" max="1440" step="1" value="${DEFAULT_AUTO_CHAT_COOLDOWN}" />
                        <span class="auto_mode_delay_unit">mins</span>
                    </label>
                </div>
                <label class="checkbox_label" title="Allow this character to privately react to the current roleplay or group chat">
                    <input id="sb_conv_roleplay_reactions" type="checkbox" />
                    <span>React to current roleplay</span>
                </label>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-book-atlas" aria-hidden="true"></i><span>Context Overrides</span></h4>
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
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-image" aria-hidden="true"></i><span>Image Generation</span></h4>
                <label class="checkbox_label" title="Enable in-chat image generation via Quick Image Gen">
                    <input id="sb_conv_image_gen_enabled" type="checkbox" />
                    <span>Enable chatroom image generation (Quick Image Gen)</span>
                </label>
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
                <label class="checkbox_label" title="Character spontaneously generates selfies during the conversation">
                    <input id="sb_conv_spontaneous_selfies" type="checkbox" />
                    <span>Enable Spontaneous Selfies</span>
                </label>
                <div class="sb-conversation-field-stack">
                    <label for="sb_conv_selfie_prompt">Selfie Prompt Template</label>
                    <input id="sb_conv_selfie_prompt" type="text" class="text_pole wide100p" placeholder="raw photo, selfie of {{char}}" />
                </div>
            </div>
            <div class="sb-settings-group">
                <h4 class="sb-settings-group-title"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>DM Tweaks</span></h4>
                <label class="checkbox_label" title="Add quick inline edit buttons next to messages in the Conversation thread">
                    <input id="sb_conv_editable_messages" type="checkbox" />
                    <span>Enable Quick-Edit DM Actions</span>
                </label>
                <label class="checkbox_label" title="Enable a magic wand icon on character replies to polish and refine their outputs.">
                    <input id="sb_conv_prose_polisher" type="checkbox" />
                    <span>Character Prose Polisher</span>
                </label>
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
        header.hidden = true;
        header.innerHTML = `
            <button id="${CHROME_IDS.palsToggle}" type="button" class="menu_button menu_button_icon" data-sb-conversation-action="toggle-pals" title="Open Conversation pals" aria-label="Open Conversation pals">
                <i class="fa-solid fa-address-book"></i>
                <span class="sb-conversation-pals-toggle-badge" hidden></span>
            </button>
            <div class="sb-conversation-header-avatar" data-sb-conversation-participants></div>
            <div class="sb-conversation-header-copy">
                <div class="sb-conversation-header-kicker">Conversation</div>
                <div class="sb-conversation-header-name" data-sb-conversation-name>Conversation</div>
                <div class="sb-conversation-header-status" data-sb-conversation-status>Available for live DM replies.</div>
            </div>
            <div class="sb-conversation-header-actions">
                <button type="button" class="menu_button menu_button_icon sb-conversation-header-add-member" data-sb-conversation-action="open-add-member" title="Add member to Conversation" aria-label="Add member to Conversation" hidden>
                    <i class="fa-solid fa-user-plus" aria-hidden="true"></i>
                    <span>Add Member</span>
                </button>
                <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="new-chat" title="Clear DM History (New Chat)" aria-label="Clear DM History (New Chat)">
                    <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                    <span>New Chat</span>
                </button>
                <button type="button" class="menu_button menu_button_icon sb-conversation-header-settings" data-sb-conversation-action="open-settings" title="Conversation settings" aria-label="Conversation settings">
                    <i class="fa-solid fa-gear"></i>
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
            <div id="${CHROME_IDS.timeline}" class="sb-conversation-timeline" role="log" aria-live="polite"></div>
            <div id="${CHROME_IDS.tools}" class="sb-conversation-tools" aria-label="Conversation tools">
                <div class="sb-conversation-channel-tabs" role="tablist" aria-label="Conversation filters">
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="main" aria-pressed="true">Main</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="pinned" aria-pressed="false">Pins</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="selfies" aria-pressed="false">Selfies</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="media" aria-pressed="false">Files</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="ooc" aria-pressed="false">OOC</button>
                    <button type="button" class="sb-conversation-channel-tab" data-sb-conversation-action="set-channel" data-channel="memories" aria-pressed="false">Memories</button>
                </div>
                <div class="sb-conversation-quick-actions" aria-label="Quick actions">
                    <button type="button" class="sb-conversation-tool-button" data-sb-conversation-action="quick-selfie" title="Generate a selfie from the current context">
                        <i class="fa-solid fa-camera" aria-hidden="true"></i><span>Selfie</span>
                    </button>
                    <button type="button" class="sb-conversation-tool-button" data-sb-conversation-action="quick-remind" title="Schedule a reminder in this DM">
                        <i class="fa-solid fa-bell" aria-hidden="true"></i><span>Remind</span>
                    </button>
                    <button type="button" class="sb-conversation-tool-button" data-sb-conversation-action="edit-schedule" title="Edit character schedule">
                        <i class="fa-solid fa-calendar-days" aria-hidden="true"></i><span>Schedule</span>
                    </button>
                    <button type="button" class="sb-conversation-tool-button" data-sb-conversation-action="quick-summarize" title="Refresh Conversation memory">
                        <i class="fa-solid fa-book-open" aria-hidden="true"></i><span>Summarize</span>
                    </button>
                    <button type="button" class="sb-conversation-tool-button" data-sb-conversation-action="force-response" title="Force a response even if the character is DND or offline">
                        <i class="fa-solid fa-bolt" aria-hidden="true"></i><span>Force</span>
                    </button>
                </div>
                <label class="sb-conversation-search-wrap" for="${CHROME_IDS.search}">
                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                    <span class="sr-only">Search Conversation messages</span>
                    <input id="${CHROME_IDS.search}" class="text_pole textarea_compact" type="search" placeholder="Search this DM" autocomplete="off" />
                </label>
            </div>
            <div id="${CHROME_IDS.dropHint}" class="sb-conversation-drop-hint" hidden>Drop files to attach</div>
            <form id="${CHROME_IDS.form}" class="sb-conversation-composer">
                <label class="sr-only" for="${CHROME_IDS.input}">Conversation message</label>
                <div id="${CHROME_IDS.replyPreview}" class="sb-conversation-reply-preview" hidden></div>
                <textarea id="${CHROME_IDS.input}" class="text_pole" rows="1" placeholder="Type your message..."></textarea>
                <div id="${CHROME_IDS.attachmentPreview}" class="sb-conversation-attachment-preview" hidden></div>
                <div class="sb-conversation-composer-actions">
                    <button id="sb_conversation_toggle_tools" type="button" class="menu_button menu_button_icon" data-sb-conversation-action="toggle-tools" title="Toggle filters and tools" aria-label="Toggle filters and tools">
                        <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                    </button>
                    <button id="${CHROME_IDS.attach}" type="button" class="menu_button menu_button_icon" data-sb-conversation-action="attach-file" title="Attach images or files" aria-label="Attach images or files">
                        <i class="fa-solid fa-paperclip" aria-hidden="true"></i>
                    </button>
                    <input id="${CHROME_IDS.fileInput}" class="displayNone" type="file" accept="${CONVERSATION_ATTACHMENT_ACCEPT}" multiple aria-label="Conversation attachments" />
                    <button id="${CHROME_IDS.send}" type="submit" class="menu_button menu_button_icon" title="Send Conversation message" aria-label="Send Conversation message">
                        <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
                        <span>Send</span>
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
        palsRail.setAttribute('aria-label', 'Conversation pals');
        palsRail.innerHTML = `
            <div class="sb-conversation-rail-header" style="position: relative;">
                <div>
                    <div class="sb-conversation-rail-kicker">Pals</div>
                </div>
                <div class="sb-conversation-rail-start-actions">
                    <button type="button" class="menu_button menu_button_icon sb-conversation-rail-new-button" data-sb-conversation-action="open-add-dm" title="New Solo Chat" aria-label="New Solo Chat">
                        <i class="fa-solid fa-user-plus" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="menu_button menu_button_icon sb-conversation-rail-new-button" data-sb-conversation-action="open-new-group-chat" title="New Group Chat" aria-label="New Group Chat">
                        <i class="fa-solid fa-user-group" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="menu_button menu_button_icon sb-conversation-rail-new-button" data-sb-conversation-action="mark-all-read" title="Mark all Conversation pings as read" aria-label="Mark all Conversation pings as read">
                        <i class="fa-solid fa-check-double" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="menu_button menu_button_icon sb-conversation-rail-close" data-sb-conversation-action="close-pals" title="Close Conversation pals" aria-label="Close Conversation pals">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div id="sb_conversation_add_dm_picker" class="sb-conversation-add-dm-picker" style="position: absolute; inset-block-start: calc(100% + 4px); inset-inline-start: 12px; inset-inline-end: 12px; z-index: 95; padding: 10px; border-radius: var(--sb-radius-md); border: 1px solid var(--sb-shell-border); background-color: var(--SmartThemeBlurTintColor); backdrop-filter: blur(12px); box-shadow: 0 4px 20px var(--black50a);" hidden></div>
            </div>
            <div class="sb-conversation-rail-search" style="padding: 0 14px 8px;">
                <input type="text" id="sb_conversation_pals_search" class="text_pole textarea_compact wide100p" placeholder="Search direct messages..." style="font-size: var(--sb-type-meta);" />
            </div>
            <div id="${CHROME_IDS.palsList}" class="sb-conversation-pals-list"></div>
            <div id="${CHROME_IDS.railFooter}" class="sb-conversation-rail-footer">
                <div class="sb-conversation-rail-footer-avatar" data-sb-conversation-action="open-persona-picker" role="button" tabindex="0" title="Switch persona" aria-label="Switch persona">
                    <img id="sb_conv_footer_persona_avatar" alt="" loading="lazy" />
                    <span class="sb-conversation-status-dot sb-conversation-rail-footer-dot" data-status="online" aria-hidden="true"></span>
                    <div id="${CHROME_IDS.personaPicker}" class="sb-conversation-persona-picker" role="listbox" aria-label="Choose persona" hidden></div>
                </div>
                <div class="sb-conversation-rail-footer-copy">
                    <span id="sb_conv_footer_persona_name" class="sb-conversation-rail-footer-name"></span>
                    <span id="sb_conv_footer_user_status" class="sb-conversation-rail-footer-status"></span>
                </div>
                <div class="sb-conversation-rail-footer-actions">
                    <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="edit-user-persona-status" title="Edit persona status" aria-label="Edit persona status">
                        <i class="fa-solid fa-user-pen" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="menu_button menu_button_icon" data-sb-conversation-action="open-user-status-picker" title="Set your status" aria-label="Set your status" aria-haspopup="listbox">
                        <i class="fa-solid fa-circle-dot" aria-hidden="true"></i>
                    </button>
                    <div id="${CHROME_IDS.userStatusPicker}" class="sb-conversation-status-picker" role="listbox" aria-label="Set your status" hidden>
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
                    </div>
                </div>
            </div>
        `;
        sheld.insertBefore(palsRail, header);
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
        drawer.setAttribute('role', 'dialog');
        drawer.setAttribute('aria-modal', 'true');
        drawer.setAttribute('aria-label', 'Conversation settings');
        drawer.innerHTML = buildSettingsDrawerHtml();
        sheld.appendChild(drawer);
    }

    bindConversationChromeControlsAsync(sheld);
    return { sheld, header, stage, palsRail, backdrop, drawer };
}

registerConversationRenderer('timeline', renderConversationTimeline);
