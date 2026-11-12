import { characters, doNewChat, selectCharacterById } from '../../script.js';
import { t } from '../i18n.js';
import { getLastChatMode } from '../sillybunny-chat-mode-memory.js';
import { conversationState } from '../sillybunny-conversation/state.js';
import { startTemporaryChat } from '../sillybunny-temporary-chat.js';
import { createAssistantActions } from './assistant-actions.js';

export function reportFailure() {
    globalThis.toastr?.error(t`This chat couldn't open. Try again, or reload SillyBunny.`);
}

/** The same event that the Conversation workspace listens to for every other way out of it. */
function closeConversationWorkspace() {
    if (conversationState.conversationWorkspaceOpen) {
        window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
    }
}

function findCharacterId(avatar) {
    const characterId = characters.findIndex(character => character.avatar === avatar);
    if (characterId === -1) {
        throw new Error(`The library has no character with the avatar "${avatar}".`);
    }
    return characterId;
}

/**
 * Selecting another character and starting a new chat both leave a temporary chat through the same seam, which asks
 * first when the chat was written in. Conversation closes only once the selection is accepted, so a Cancel leaves the
 * user where they were.
 * @param {string} avatar
 * @returns {Promise<boolean>}
 */
async function openRoleplayChat(avatar) {
    const selected = await selectCharacterById(findCharacterId(avatar), { switchMenu: false, onAccepted: closeConversationWorkspace });
    if (!selected) {
        return false;
    }
    await doNewChat({ deleteCurrentChat: false });
    return true;
}

/**
 * @param {string} avatar
 * @returns {Promise<boolean>}
 */
function openTemporaryChat(avatar) {
    return startTemporaryChat(findCharacterId(avatar));
}

/**
 * The actions of the assistant cards over the app.
 * @param {object} options
 * @param {(avatar: string, options: { branchId: string, groupId: string, enable: boolean }) => Promise<void>} options.openConversation
 *   Opens a Conversation thread from Home, which hides the panel while the workspace comes up.
 */
export function createAppAssistantActions({ openConversation }) {
    // A new Conversation is a new branch of the thread, which Recent Chats lists once the character has Conversation on.
    async function openConversationChat(avatar) {
        const { createConversationBranchForAvatar, getConversationBranches, getConversationGroupIdForAvatar } = await import('../sillybunny-conversation/context.js');
        const groupId = getConversationGroupIdForAvatar(avatar);
        const branch = createConversationBranchForAvatar(avatar, `Chat ${getConversationBranches(avatar, { groupId }).length + 1}`, { groupId });
        if (!branch) {
            throw new Error(`No Conversation branch could be made for "${avatar}".`);
        }
        await openConversation(avatar, { branchId: branch.id, groupId: groupId || '', enable: true });
        return true;
    }

    return createAssistantActions({
        getLastMode: getLastChatMode,
        openRoleplayChat,
        openTemporaryChat,
        openConversationChat,
        reportFailure,
    });
}
