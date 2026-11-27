/** What roleplay's message selection needs to know about the chat array, apart from the page. */

/** A tool call is its own message in the chat; it belongs to the assistant message that follows it. */
export function isToolCallMessage(message) {
    return Boolean(message?.is_system) && Array.isArray(message.extra?.tool_invocations);
}

export function isAssistantMessage(message) {
    return Boolean(message) && !message.is_user && !message.is_system;
}

/**
 * The index of the message that a row is selected and deleted with: its assistant message when it is a tool call of one.
 * Only an assistant message takes tool calls.
 * @param {object[]} chat
 * @param {number} index
 * @param {boolean} deleteToolCalls False gives every row its own key.
 */
export function getOwnerIndex(chat, index, deleteToolCalls) {
    if (!deleteToolCalls || !isToolCallMessage(chat[index])) {
        return index;
    }
    let cursor = index;
    while (isToolCallMessage(chat[cursor]) && cursor < chat.length - 1) {
        cursor++;
    }
    return isAssistantMessage(chat[cursor]) ? cursor : index;
}

/**
 * Every chat index that the keys stand for, highest first, so that deleting one never moves the next.
 * @param {object[]} chat
 * @param {Iterable<string>} keys The indexes of the messages that own the rows, as strings.
 * @param {boolean} deleteToolCalls
 * @returns {number[]}
 */
export function getMessageIndexes(chat, keys, deleteToolCalls) {
    const indexes = new Set();
    for (const key of keys) {
        const owner = Number(key);
        indexes.add(owner);
        if (deleteToolCalls && isAssistantMessage(chat[owner])) {
            for (let cursor = owner - 1; cursor >= 0 && isToolCallMessage(chat[cursor]); cursor--) {
                indexes.add(cursor);
            }
        }
    }
    return [...indexes].sort((left, right) => right - left);
}

/**
 * Where a deletion that reaches the last message starts, so that it can cut the chat there in one step.
 * @param {number[]} indexes
 * @param {number} chatLength
 * @returns {number} The first index of the run, or -1 when the indexes are not one unbroken run that ends at the last message.
 */
export function getTailStart(indexes, chatLength) {
    if (!indexes.length) {
        return -1;
    }
    const start = Math.min(...indexes);
    return new Set(indexes).size === chatLength - start && Math.max(...indexes) === chatLength - 1 ? start : -1;
}
