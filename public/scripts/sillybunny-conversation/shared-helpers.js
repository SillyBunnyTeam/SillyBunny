/**
 * Shared conversation prompt and normalization helpers.
 * Used by both browser code and REST API endpoint.
 * @module sillybunny-conversation/shared-helpers
 */

const TRANSCRIPT_MESSAGE_LIMIT = 20;

/**
 * Check if a message has content (text or attachments).
 */
export function hasConversationMessageContent(message) {
    if (!message) {
        return false;
    }

    const text = String(message.mes ?? message.text ?? '').trim();
    if (text) {
        return true;
    }

    const attachments = message.extra?.attachments;
    return Array.isArray(attachments) && attachments.length > 0;
}

/**
 * Format text for use in prompts by removing HTML, normalizing whitespace, and truncating.
 */
export function formatPromptText(value, maxLength = 1400) {
    return String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

/**
 * Get the display name for a conversation message speaker.
 */
export function getConversationSpeakerName(message, userName = 'User') {
    if (message?.role === 'user') {
        return userName;
    }

    return String(message?.name || 'Speaker').trim() || 'Speaker';
}

/**
 * Find the index of the last user message with content.
 */
export function getLastUserMessageIndex(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === 'user' && hasConversationMessageContent(messages[index])) {
            return index;
        }
    }

    return -1;
}

/**
 * Find the last non-user, non-system message before a given index.
 */
export function getLastNonUserMessageBefore(messages, beforeIndex) {
    for (let index = beforeIndex - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role !== 'user' && message?.role !== 'system' && hasConversationMessageContent(message)) {
            return message;
        }
    }

    return null;
}

/**
 * Build group reference context to help resolve ambiguous pronouns in group DMs.
 */
export function buildConversationGroupReferenceContext(messages, { groupId = '', speakerName = 'Character', userName = 'User' } = {}) {
    if (!groupId) {
        return '';
    }

    const recentMessages = messages
        .filter(message => hasConversationMessageContent(message) && message?.role !== 'system')
        .slice(-TRANSCRIPT_MESSAGE_LIMIT);
    const latestUserIndex = getLastUserMessageIndex(recentMessages);
    if (latestUserIndex < 0) {
        return '';
    }

    const latestUserMessage = recentMessages[latestUserIndex];
    const replyReference = latestUserMessage.extra?.conversation_reply_to;
    const lastNonUserMessage = getLastNonUserMessageBefore(recentMessages, latestUserIndex);
    const rawTargetName = replyReference?.name || (lastNonUserMessage ? getConversationSpeakerName(lastNonUserMessage, userName) : '');
    const targetName = formatPromptText(rawTargetName, 80);
    if (!targetName) {
        return '';
    }

    const speaker = formatPromptText(speakerName || 'Character', 80);
    const latestText = formatPromptText(latestUserMessage.mes, 500);
    const targetReason = replyReference?.name
        ? `The latest user message is an explicit reply to ${targetName}.`
        : `The latest user message most likely addresses ${targetName}, the last non-user speaker before it, when it uses implicit references like you, your, that, this, or why.`;

    return [
        'Group DM reference context:',
        latestText ? `Latest user message: ${latestText}` : '',
        targetReason,
        `${speaker} should silently use this to resolve ambiguous references. If ${speaker} is not ${targetName}, do not assume every you means ${speaker}; the user may be referring to ${targetName}.`,
        'Do not mention this context or explain the reference resolution; just reply naturally.',
    ].filter(Boolean).join('\n');
}

/**
 * Build Grounded Dialogue Rules system prompt section.
 */
export function getGroundedDialogueRulesPrompt(settings) {
    if (!settings?.grounded_dialogue_rules_enabled) {
        return '';
    }

    return String(settings.grounded_dialogue_rules || '').trim().slice(0, 8000);
}

/**
 * Compile Geechan-style system prompt with variable substitution.
 */
export function compileGeechanPrompt(settings, charName, userName, defaultPrompt = '') {
    let compiledPrompt = settings.geechan_chatroom_prompt || defaultPrompt;
    compiledPrompt = compiledPrompt.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
    compiledPrompt = compiledPrompt.replace(/\{\{trim\}\}/g, '');
    if (settings.custom_instructions && settings.custom_instructions.trim()) {
        compiledPrompt = compiledPrompt.replace(/\{\{#if \.player-instructions\}\}([\s\S]*?)\{\{\/if\}\}/gi, (match, block) => {
            return block.replace(/\{\{getvar::player-instructions\}\}/gi, settings.custom_instructions);
        });
    } else {
        compiledPrompt = compiledPrompt.replace(/\{\{#if \.player-instructions\}\}([\s\S]*?)\{\{\/if\}\}/gi, '');
    }

    return compiledPrompt
        .replace(/\{\{char\}\}/g, charName)
        .replace(/\{\{user\}\}/g, userName)
        .trim();
}
