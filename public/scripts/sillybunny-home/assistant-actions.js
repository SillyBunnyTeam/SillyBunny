/**
 * What the controls of an assistant card do. The chats themselves are opened by `deps`, so this module only decides
 * which one a control opens, and stays a unit that runs without the app.
 *
 * @typedef {'roleplay' | 'conversation'} ChatMode
 *
 * @typedef {object} AssistantActionDeps
 * @property {() => unknown} getLastMode The mode that chats open in. Anything but Conversation counts as Roleplay.
 * @property {(avatar: string) => Promise<boolean>} openRoleplayChat A new chat with the character, in Roleplay.
 * @property {(avatar: string) => Promise<boolean>} openTemporaryChat A temporary chat with the character.
 * @property {(avatar: string) => Promise<boolean>} openConversationChat A fresh Conversation with the character.
 * @property {() => void} reportFailure Tells the user that a chat could not be opened.
 *
 * Each opener resolves false when the user declined, and throws when the chat could not be opened.
 */

/**
 * @param {AssistantActionDeps} deps
 */
export function createAssistantActions({ getLastMode, openRoleplayChat, openTemporaryChat, openConversationChat, reportFailure }) {
    let opening = false;

    /**
     * Runs one opener for a card. A card without a file opens nothing, and so does an activation while another chat is
     * still opening, which is what a double click is.
     * @param {{ state: string, avatar: string | null }} card
     * @param {(avatar: string) => Promise<boolean>} open
     * @returns {Promise<boolean>} Whether the chat opened
     */
    async function openFor(card, open) {
        if (card.state !== 'available' || !card.avatar || opening) {
            return false;
        }
        opening = true;
        try {
            return await open(card.avatar);
        } catch (error) {
            console.error('Could not open a chat with the assistant.', error);
            reportFailure();
            return false;
        } finally {
            opening = false;
        }
    }

    /**
     * @param {ChatMode} mode
     * @returns {(avatar: string) => Promise<boolean>}
     */
    function openerFor(mode) {
        if (mode !== 'roleplay' && mode !== 'conversation') {
            throw new TypeError(`Unknown chat mode: ${String(mode)}`);
        }
        return mode === 'conversation' ? openConversationChat : openRoleplayChat;
    }

    /** @param {{ state: string, avatar: string | null }} card */
    function newChat(card) {
        return openFor(card, openerFor(getLastMode() === 'conversation' ? 'conversation' : 'roleplay'));
    }

    /**
     * A temporary chat exists only in Roleplay, so from Conversation it opens there.
     * @param {{ state: string, avatar: string | null }} card
     */
    function temporaryChat(card) {
        return openFor(card, openTemporaryChat);
    }

    /**
     * @param {{ state: string, avatar: string | null }} card
     * @param {ChatMode} mode
     */
    async function newChatInMode(card, mode) {
        return openFor(card, openerFor(mode));
    }

    return { newChat, temporaryChat, newChatInMode };
}
