/**
 * Temporary Chat: a chat with a character that is never written to disk.
 *
 * The character stays selected, so its card, lorebook and avatar work as in any chat. Nothing is saved until the user
 * picks Save as New Chat, which writes one normal chat file and lets the chat continue as a normal chat.
 * `sillybunny-temporary-chat-state.js` holds the flag that the narrow write seams in the app ask. Roleplay only.
 */
import {
    characters,
    chat,
    event_types,
    eventSource,
    saveChat,
    saveSettingsDebounced,
    selectCharacterById,
    setActiveCharacter,
    this_chid,
    updateRemoteChatName,
} from '../script.js';
import { t } from './i18n.js';
import { humanizedDateTime } from './RossAscends-mods.js';
import { createBanner } from './sillybunny-editor/banner.js';
import { openAlert } from './sillybunny-editor/dialog.js';
import { conversationState } from './sillybunny-conversation/state.js';
import {
    enterTemporaryState,
    exitTemporaryState,
    getTemporaryChatState,
    hasSentMessage,
    restoreTemporaryState,
} from './sillybunny-temporary-chat-state.js';
import { uuidv4 } from './utils.js';

const COPY_PLACEHOLDER = 'TODO(copy)';
const BANNER_ID = 'sb-temporary-chat-banner';
const BANNER_SLOT = 'TC-BANNER';
const LEAVE_HEAD_SLOT = 'TC-LEAVE-HEAD';
const LEAVE_BODY_SLOT = 'TC-LEAVE-BODY';
const PAGE_MARK = 'sbTemporaryChat';
const STYLE_ID = 'sb-temporary-chat-style';

/**
 * Branches, checkpoints and the conversion to a group write a new chat file made from this one, which a temporary
 * chat does not have. The rule sits in a style element of its own because render-blocking CSS is budgeted.
 */
const FILE_BOUND_ACTIONS_CSS = `html[data-sb-temporary-chat] #chat .mes :is(.mes_create_branch, .mes_create_bookmark, .mes_bookmark),
html[data-sb-temporary-chat] :is(#option_new_bookmark, #option_convert_to_group, .swipe_picker_branch) {
    display: none !important;
}`;

/** @type {ReturnType<typeof createBanner>|null} */
let banner = null;
let isSaving = false;
/** @type {Promise<boolean>|null} The alert that is open, shared by every caller that wants to leave meanwhile. */
let openLeaveAlert = null;
/** @type {{ reservedName: string, contents: string }|null} The chat the user agreed to discard, as it was then. */
let agreedToDiscard = null;

/**
 * @param {Element|null|undefined} element Element that shows copy which is still missing
 * @param {string} slot Names the text that belongs there
 */
function markCopyPlaceholder(element, slot) {
    if (element instanceof HTMLElement) {
        element.dataset.sbCopyPlaceholder = 'true';
        element.dataset.sbCopySlot = slot;
    }
}

/**
 * Shows an error toast whose text is still missing.
 * @param {string} slot Names the text that belongs there
 */
export function showTemporaryChatError(slot) {
    const toast = toastr.error(COPY_PLACEHOLDER);
    toast?.attr?.({ 'data-sb-copy-placeholder': 'true', 'data-sb-copy-slot': slot });
}

function ensureFileBoundActionStyle() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = FILE_BOUND_ACTIONS_CSS;
    document.head.append(style);
}

function warnBeforeUnload(event) {
    if (!hasSentMessage(chat)) {
        return;
    }
    event.preventDefault();
    event.returnValue = '';
}

function showBanner() {
    if (banner) {
        banner.setRevealed(true);
        return;
    }
    banner = createBanner({
        title: COPY_PLACEHOLDER,
        actionLabel: t`Save as New Chat`,
        onActivate: () => void saveTemporaryChatAsNew(),
    });
    banner.element.id = BANNER_ID;
    markCopyPlaceholder(banner.element.firstElementChild, BANNER_SLOT);
    const chatElement = document.getElementById('chat');
    if (chatElement) {
        chatElement.before(banner.element);
    } else {
        document.body.prepend(banner.element);
    }
}

function removeBanner() {
    banner?.destroy();
    banner = null;
}

/**
 * Turns the selected character's chat into a temporary one. The caller has already cleared the previous chat.
 * @param {{ avatar: string, chat?: string }} character The selected character, in `characters`
 */
export function beginTemporaryChat(character) {
    character.chat = enterTemporaryState({ avatar: character.avatar, previousChatName: character.chat });
    agreedToDiscard = null;
    window.addEventListener('beforeunload', warnBeforeUnload);
    ensureFileBoundActionStyle();
    document.documentElement.dataset[PAGE_MARK] = 'true';
    showBanner();
}

/**
 * Ends the temporary chat without saving it: the card gets its real chat name back and the banner goes.
 * Does nothing when no temporary chat is open.
 */
export function endTemporaryChat() {
    const ended = exitTemporaryState();
    if (!ended) {
        return;
    }
    const character = characters.find(candidate => candidate?.avatar === ended.avatar);
    if (character?.chat === ended.reservedName) {
        character.chat = ended.previousChatName;
    }
    agreedToDiscard = null;
    window.removeEventListener('beforeunload', warnBeforeUnload);
    delete document.documentElement.dataset[PAGE_MARK];
    removeBanner();
}

function closeConversationWorkspace() {
    if (conversationState.conversationWorkspaceOpen) {
        window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
    }
}

/**
 * Starts a temporary chat with a character. A chat that is open is left first, and asks about it when the user
 * wrote in it. From Conversation the chat opens in Roleplay.
 * @param {number|string} characterId Index in `characters`
 * @returns {Promise<boolean>} Whether the temporary chat opened
 */
export async function startTemporaryChat(characterId) {
    return selectCharacterById(characterId, {
        switchMenu: false,
        temporary: true,
        onAccepted: closeConversationWorkspace,
    });
}

/**
 * Saves the temporary chat as a new chat of its character, and lets the chat continue as a normal chat.
 * The chat stops being temporary before it saves, because the save refuses a temporary chat; a failed save turns it back.
 * @returns {Promise<boolean>} Whether the chat was saved
 */
export async function saveTemporaryChatAsNew() {
    const snapshot = getTemporaryChatState();
    const character = characters[this_chid];
    if (!snapshot || isSaving || character?.avatar !== snapshot.avatar) {
        return false;
    }

    isSaving = true;
    try {
        return await saveCurrentTemporaryChat(snapshot, character);
    } finally {
        isSaving = false;
    }
}

/**
 * @param {import('./sillybunny-temporary-chat-state.js').TemporaryChatState} snapshot The temporary state
 * @param {{ name: string, avatar: string, chat?: string }} character The character in `characters`
 * @returns {Promise<boolean>} Whether the chat was saved
 */
async function saveCurrentTemporaryChat(snapshot, character) {
    const chatName = `${character.name} - ${humanizedDateTime()}`;
    const ended = exitTemporaryState();
    character.chat = chatName;
    try {
        const saved = await saveChat({ chatName, withMetadata: { integrity: uuidv4() }, throwOnError: true });
        if (!saved) {
            throw new Error('The chat was not saved.');
        }
    } catch (error) {
        // saveChat has already told the user that the chat could not be saved.
        console.error('Could not save the temporary chat as a new chat.', error);
        character.chat = snapshot.reservedName;
        restoreTemporaryState(ended);
        return false;
    }

    agreedToDiscard = null;
    window.removeEventListener('beforeunload', warnBeforeUnload);
    delete document.documentElement.dataset[PAGE_MARK];
    removeBanner();
    try {
        await updateRemoteChatName(this_chid, chatName);
    } catch (error) {
        console.error('The new chat was saved but could not be recorded as the last chat of the character.', error);
    }
    const chatNameField = document.getElementById('selected_chat_pole');
    if (chatNameField instanceof HTMLInputElement) {
        chatNameField.value = chatName;
    }
    setActiveCharacter(character.avatar);
    saveSettingsDebounced();
    await eventSource.emit(event_types.CHAT_CHANGED, chatName);
    return true;
}

/**
 * @returns {string} Everything the user would lose with the chat: each message and the swipe it shows
 */
function describeChatContents() {
    return JSON.stringify(chat.map(message => [message.mes, message.swipe_id ?? 0]));
}

/**
 * Asks what to do with a temporary chat that the user is about to leave. A chat with only the greeting closes silently.
 * Discard only agrees to leave: the chat ends when the app clears it for the next one. The agreement holds for as long
 * as the chat is unchanged, so a trip that asks twice on its way (a command, then the chat switch) asks once.
 * A caller that arrives while the alert is open waits for the answer and then aborts, so only the first acts on it.
 * @returns {Promise<boolean>} Whether the user may leave
 */
export async function leaveTemporaryChat() {
    const reservedName = getTemporaryChatState()?.reservedName;
    if (!reservedName || !hasSentMessage(chat)) {
        return true;
    }
    if (agreedToDiscard?.reservedName === reservedName && agreedToDiscard.contents === describeChatContents()) {
        return true;
    }
    if (openLeaveAlert) {
        await openLeaveAlert.catch(() => {});
        return false;
    }

    openLeaveAlert = askToLeave(reservedName).finally(() => {
        openLeaveAlert = null;
    });
    return openLeaveAlert;
}

/**
 * @param {string} reservedName Reserved chat name of the chat the alert is about
 * @returns {Promise<boolean>} Whether the user may leave
 */
async function askToLeave(reservedName) {
    const answer = openAlert({
        heading: COPY_PLACEHOLDER,
        body: COPY_PLACEHOLDER,
        responses: [
            { id: 'cancel', label: t`Cancel` },
            { id: 'discard', label: t`Discard`, appearance: 'destructive' },
            { id: 'save', label: t`Save as New Chat`, appearance: 'suggested' },
        ],
        closeResponse: 'cancel',
    });
    const alerts = document.querySelectorAll('[role="alertdialog"]');
    const alert = alerts[alerts.length - 1];
    markCopyPlaceholder(alert?.querySelector('.sb-dialog__heading'), LEAVE_HEAD_SLOT);
    markCopyPlaceholder(alert?.querySelector('.sb-dialog__message'), LEAVE_BODY_SLOT);

    const response = await answer;
    if (response === 'save') {
        return saveTemporaryChatAsNew();
    }
    if (response === 'discard') {
        agreedToDiscard = { reservedName, contents: describeChatContents() };
        return true;
    }
    return false;
}
