import { name1 } from '../../script.js';
import { getExtensionCapability } from './extension-capabilities.js';
import { getConversationAttachmentSummary } from './thread-store-utils.js';

function getConversationTtsText(message) {
    const displayText = String(message?.extra?.display_text || '').trim();
    if (displayText) {
        return displayText;
    }

    const messageText = String(message?.mes || '').trim();
    if (messageText) {
        return messageText;
    }

    return getConversationAttachmentSummary(message);
}

function getConversationTtsMessage(message) {
    if (!message || typeof message !== 'object') {
        return null;
    }

    const role = String(message.role || '').trim();
    if (role === 'system') {
        return null;
    }

    const text = getConversationTtsText(message);
    return {
        name: String(message.name || (role === 'user' ? name1 || 'User' : 'Character')).trim(),
        mes: text,
        is_user: role === 'user',
        is_system: role === 'system',
        extra: message.extra || {},
    };
}

export async function narrateConversationMessage(message, { isStillVisible = null, manual = false, force = false } = {}) {
    const ttsMessage = getConversationTtsMessage(message);
    if (!ttsMessage) {
        return false;
    }

    if (!ttsMessage.mes && !ttsMessage.extra?.display_text) {
        if (manual || force) {
            globalThis.toastr?.info?.('No text to narrate.');
        }
        return false;
    }

    const tts = getExtensionCapability('tts');
    if (!tts) {
        return false;
    }

    try {
        return await tts.narrateTtsMessage(ttsMessage, {
            manual,
            force,
            isStillVisible,
            propagateErrors: true,
            unrestrictedVoiceMap: true,
        });
    } catch (error) {
        console.warn('Conversation Mode: TTS narration failed', error);
        if (manual || force) {
            globalThis.toastr?.warning?.('TTS narration failed. Check the TTS extension settings.');
        }
        return false;
    }
}
