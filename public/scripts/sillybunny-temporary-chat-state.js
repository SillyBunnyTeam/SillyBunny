/**
 * State of a temporary chat: a chat with a character that is never written to disk.
 *
 * While the state is on, `characters[this_chid].chat` holds a reserved name that no chat file can have, so caches
 * keyed by chat id never reach the real chat of that character. The flag stays authoritative: whatever refreshes the
 * character list from the server puts the reserved name back with `reassertReservedChatName`.
 *
 * The module has no imports, so any module that must not write for a temporary chat can ask `isTemporaryChat`
 * without pulling in the app.
 */

/**
 * @typedef {object} TemporaryChatState
 * @property {string} avatar Avatar file of the character the chat is with.
 * @property {string} previousChatName Chat name the card had before; the one to restore and to write to the card form.
 * @property {string} reservedName Name that stands in for the chat while it is temporary.
 */

/** @type {TemporaryChatState|null} */
let current = null;

/**
 * @returns {string} 16 random hexadecimal digits
 */
function randomToken() {
    const words = new Uint32Array(2);
    globalThis.crypto.getRandomValues(words);
    return Array.from(words, word => word.toString(16).padStart(8, '0')).join('');
}

/**
 * @returns {boolean} Whether the open chat is temporary and must not be written anywhere.
 */
export function isTemporaryChat() {
    return current !== null;
}

/**
 * @param {string|undefined} avatar Avatar file of a character
 * @returns {boolean} Whether the temporary chat is with that character
 */
export function isTemporaryChatWith(avatar) {
    return current !== null && avatar !== undefined && current.avatar === avatar;
}

/**
 * @param {string|undefined} chatName A chat name
 * @returns {boolean} Whether the name is the stand-in for the open temporary chat
 */
export function isReservedChatName(chatName) {
    return current !== null && chatName === current.reservedName;
}

/**
 * @returns {TemporaryChatState|null} Copy of the state, or null when no temporary chat is open.
 */
export function getTemporaryChatState() {
    return current ? { ...current } : null;
}

/**
 * Makes a command that needs a chat file say so, where a refused write would give an empty result.
 * @throws {Error} While the chat is temporary
 */
export function assertChatFileWritable() {
    if (current) {
        throw new Error('TODO(copy)');
    }
}

/**
 * Starts the state for a character.
 * @param {object} options Options
 * @param {string} options.avatar Avatar file of the character
 * @param {string} options.previousChatName Chat name the card has now
 * @returns {string} The reserved chat name to put on the card in memory
 */
export function enterTemporaryState({ avatar, previousChatName }) {
    if (!avatar) {
        throw new TypeError('A temporary chat needs the avatar of its character.');
    }
    if (current) {
        throw new Error('A temporary chat is already open.');
    }
    // A colon is one of the characters that the server removes from chat file names, so no saved chat can have this
    // name. The token is random so that a later page load never reuses the id of an earlier one, which would pick up
    // anything that was stored server-side under it.
    const reservedName = `Temporary Chat: ${randomToken()}`;
    current = { avatar, previousChatName: String(previousChatName ?? ''), reservedName };
    return reservedName;
}

/**
 * Ends the state.
 * @returns {TemporaryChatState|null} What was open, or null when nothing was
 */
export function exitTemporaryState() {
    const ended = current;
    current = null;
    return ended;
}

/**
 * Turns the state back on with what `exitTemporaryState` returned, when the step that needed it off failed.
 * @param {TemporaryChatState} ended State that was returned when it ended
 */
export function restoreTemporaryState(ended) {
    current = { ...ended };
}

/**
 * Puts the reserved name back after the character list was refreshed from the server, which resets every chat name.
 * @param {{ avatar?: string, chat?: string }[]} characters Character list, changed in place
 */
export function reassertReservedChatName(characters) {
    if (!current) {
        return;
    }
    const character = characters.find(candidate => candidate?.avatar === current.avatar);
    if (character) {
        character.chat = current.reservedName;
    }
}

/**
 * @param {{ avatar?: string, chat?: string }|undefined} character A character
 * @returns {string} The chat name that belongs on the saved card: the real one while the character's chat is temporary
 */
export function getStoredChatName(character) {
    if (current && character?.avatar === current.avatar) {
        return current.previousChatName;
    }
    return character?.chat ?? '';
}

/**
 * @param {{ is_user?: boolean, is_system?: boolean }[]} chat Messages of the chat
 * @returns {boolean} Whether the user sent a message, as opposed to the chat holding only the greeting
 */
export function hasSentMessage(chat) {
    return chat.some(message => message.is_user === true && message.is_system !== true);
}
