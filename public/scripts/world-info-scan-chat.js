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

/**
 * Expands greeting macros while preserving automatic participant-name macros for World Info scans.
 * @param {string} message Greeting text
 * @param {(message: string) => string} substitute Macro substitution function
 * @param {{char: string, user: string}} names Participant names
 * @returns {{prompt: string, worldInfo: string}} Prompt and name-excluded World Info variants
 */
export function substituteWorldInfoGreeting(message, substitute, names) {
    const macros = [];
    const protectedMessage = String(message ?? '').replace(/{{\s*(char|user)\s*}}|<(BOT|CHAR|USER)>/gi, (macro, curlyName, legacyName) => {
        const placeholder = `__SB_WI_NAME_MACRO_${macros.length}__`;
        const name = String(curlyName || legacyName).toLowerCase() === 'user' ? 'user' : 'char';
        macros.push({ macro, name });
        return placeholder;
    });
    const substitutedMessage = substitute(protectedMessage);
    return macros.reduce((result, item, index) => {
        const placeholder = `__SB_WI_NAME_MACRO_${index}__`;
        return {
            prompt: result.prompt.replace(placeholder, () => names[item.name]),
            worldInfo: result.worldInfo.replace(placeholder, () => item.macro),
        };
    }, { prompt: substitutedMessage, worldInfo: substitutedMessage });
}
