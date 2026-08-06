import { conversationTimeouts } from './state.js';

export function setConversationTimeout(callback, delay) {
    const timeoutId = window.setTimeout(() => {
        conversationTimeouts.delete(timeoutId);
        callback();
    }, delay);
    conversationTimeouts.add(timeoutId);
    return timeoutId;
}

export function clearConversationTimeout(timeoutId) {
    if (!timeoutId) {
        return;
    }

    window.clearTimeout(timeoutId);
    conversationTimeouts.delete(timeoutId);
}

export function clearConversationTimeouts() {
    for (const timeoutId of conversationTimeouts) {
        window.clearTimeout(timeoutId);
    }
    conversationTimeouts.clear();
}
