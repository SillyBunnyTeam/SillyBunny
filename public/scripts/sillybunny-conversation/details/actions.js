/**
 * What the pages of the details window do to the rest of the app: open a conversation or a chat, open a character card,
 * show a message in the timeline, add members. Each of them leaves the window to the caller to close.
 */

import { selectCharacterById } from '../../../script.js';
import { flashHighlight } from '../../utils.js';
import { selectConversation } from '../chrome.js';
import { withConversationSwitch } from '../screen-target.js';
import { getConversationGroupAnchor, ensureDirectConversation, getConversationPersonaId, setActiveConversationChat } from '../context.js';
import { getCharacterIndexForAvatar } from '../media.js';
import { addMembersToConversation } from '../pickers.js';
import { closeConversationList } from '../conversation-pages.js';
import { conversationState } from '../state.js';
import { updateConversationSearchQuery } from '../timeline-render.js';

/** The names under which the rest of the mode addresses a conversation: a character, and the group id for a group. */
export function identityOf(view) {
    if (view.kind === 'direct') {
        return { avatar: view.characters[0] ?? '', groupId: '' };
    }
    const anchor = getConversationGroupAnchor({ id: view.id, members: view.characters, disabled_members: [] }, { personaId: view.personaId });
    return { avatar: anchor?.avatar ?? '', groupId: view.id };
}

/** Opens a conversation in the workspace, at one of its chats when one is named. Resolves to whether it opened. */
export async function openConversation(view, { chatId = '' } = {}) {
    const { avatar, groupId } = identityOf(view);
    if (!avatar) {
        return false;
    }
    if (chatId) {
        setActiveConversationChat(avatar, chatId, { groupId, personaId: view.personaId });
    }
    const opened = await selectConversation(avatar, { chatId, groupId, personaId: view.personaId, showToast: false });
    if (opened) {
        closeConversationList();
    }
    return opened;
}

/** The direct conversation with a character, made when there is none yet. */
export async function openDirectConversationWith(avatar, { personaId = getConversationPersonaId() } = {}) {
    // The open conversation stays on screen while the server makes this one, so its composer is held until this one opens.
    return withConversationSwitch(async () => openConversation(await ensureDirectConversation(avatar, { personaId })));
}

async function openCharacterTab(avatar) {
    const index = getCharacterIndexForAvatar(avatar);
    if (index < 0 || await selectCharacterById(index) === false) {
        return false;
    }
    await globalThis.SillyBunnyShell?.openTab?.('characters', 'editor');
    return true;
}

/**
 * Opens the card of a character in the character editor. With a field, it moves focus there once the editor has drawn.
 * @param {string} avatar
 * @param {{ field?: string }} [options] The id of a control of the editor, such as `talkativeness_slider`.
 */
export async function openCharacterEditor(avatar, { field = '' } = {}) {
    if (!await openCharacterTab(avatar)) {
        return false;
    }
    if (field) {
        for (let attempt = 0; attempt < 10; attempt++) {
            const control = document.getElementById(field);
            if (control instanceof HTMLElement && control.getClientRects().length) {
                control.scrollIntoView({ block: 'center' });
                control.focus({ preventScroll: true });
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    return true;
}

/** Shows a message in the timeline of the conversation, with the search cleared, and flashes it. */
export async function showMessageInTimeline(view, chatId, messageId) {
    if (!await openConversation(view, { chatId })) {
        return false;
    }
    updateConversationSearchQuery('');
    for (let attempt = 0; attempt < 20; attempt++) {
        const node = document.querySelector(`#sb_conversation_timeline .sb-conversation-message[data-message-id="${CSS.escape(messageId)}"]`);
        if (node instanceof HTMLElement) {
            node.scrollIntoView({ block: 'center' });
            flashHighlight($(node), 1000);
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

/**
 * Adds characters to a group, or starts a group with them from a direct conversation.
 * @returns {Promise<{ added: boolean, switched: boolean }>} `switched` says that another conversation is open now, which a new group is.
 */
export async function addMembersTo(view, avatars) {
    const { avatar, groupId } = identityOf(view);
    const before = conversationState.conversationSelectedGroupId || '';
    const added = await addMembersToConversation(avatars, { sourceAvatar: avatar, sourceGroupId: groupId });
    return { added, switched: added && (conversationState.conversationSelectedGroupId || '') !== before };
}
