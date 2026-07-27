export function getNonSystemMessageDepth(messages, messageId) {
    if (!Array.isArray(messages) || !Number.isInteger(messageId) || messageId < 0 || messageId >= messages.length) {
        return undefined;
    }

    if (messages[messageId]?.is_system) {
        return undefined;
    }

    let depth = 0;

    for (let index = messages.length - 1; index > messageId; index--) {
        if (!messages[index]?.is_system) {
            depth++;
        }
    }

    return depth;
}
