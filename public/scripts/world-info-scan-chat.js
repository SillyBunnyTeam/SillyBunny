/**
 * Builds the message history used for a World Info scan.
 * @param {object[]} chat Prompt messages that survived prompt processing.
 * @param {object[]} supplementalChat Messages removed only from the model prompt.
 * @param {Map<number, {prompt: string, worldInfo: string}>} messageVariants Pre-ICA message variants by original index.
 * @param {boolean} includeNames Whether to prefix messages with speaker names.
 * @returns {string[]} World Info scan history, newest message first.
 */
export function buildWorldInfoScanChat(chat, supplementalChat, messageVariants, includeNames) {
    const scanChat = [...chat];
    const supplementalByIndex = [...supplementalChat].sort((a, b) => a.index - b.index);

    for (const message of supplementalByIndex) {
        const insertionIndex = scanChat.findIndex(item => Number.isInteger(item.index) && item.index > message.index);
        scanChat.splice(insertionIndex === -1 ? scanChat.length : insertionIndex, 0, message);
    }

    return scanChat.map(message => {
        const variant = messageVariants.get(message.index);
        const content = variant?.prompt === message.mes ? variant.worldInfo : message.mes;
        return includeNames ? `${message.name}: ${content}` : content;
    }).reverse();
}
