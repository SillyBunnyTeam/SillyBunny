/**
 * Which conversation the user sees, and whether the view is on its way to another one.
 *
 * The state selects a conversation at once (`conversationSelectedAvatar`), but the screen follows on the next frame, and
 * the ways into a conversation that must ask the server first (a new direct conversation, a new group) change nothing
 * until the server has answered. In both gaps the composer on screen belongs to the old conversation while the state, or
 * the user's intent, is already on the new one. A send then goes to a conversation that is not the one on screen, so the
 * composer is held in both gaps: `isComposerHeld()`.
 */

import { getActiveConversationChat, getConversationGroupIdForAvatar, getConversationPersonaId, getConversationRecord, getCurrentCharAvatar } from './context.js';
import { buildConversationRenderKey } from './render-key.js';
import { scheduleInterfaceRefresh } from './render-scheduler.js';
import { conversationState } from './state.js';

export function getConversationRenderChatId(avatar, groupId, personaId) {
    const store = getConversationRecord(avatar, { groupId, personaId });
    return String(store?.activeChatId || getActiveConversationChat(avatar, { groupId, personaId })?.id || '');
}

/**
 * The key that the timeline writes to `lastRenderedConversationKey` once it has drawn the conversation that the state
 * selects now. The timeline writes the empty key for its empty state, so no selected character is the empty key.
 */
export function getSelectedConversationRenderKey() {
    const avatar = getCurrentCharAvatar();
    if (!avatar) {
        return '';
    }
    const groupId = getConversationGroupIdForAvatar(avatar);
    const personaId = getConversationPersonaId();
    return buildConversationRenderKey(avatar, groupId, getConversationRenderChatId(avatar, groupId, personaId), personaId);
}

/** Whether the timeline has drawn the conversation that is selected now. False from the change of the selection to the next draw. */
export function isSelectedConversationOnScreen() {
    return conversationState.lastRenderedConversationKey === getSelectedConversationRenderKey();
}

let switchesUnderWay = 0;

export function isConversationSwitching() {
    return switchesUnderWay > 0;
}

/**
 * Marks the start of a switch to another conversation, before anything that has to wait for the server. The composer is
 * held until the returned function is called, and a draw is asked for at both ends so that it follows.
 * @returns {() => void} Ends the switch. Calling it again does nothing, so it cannot end another switch.
 */
export function beginConversationSwitch() {
    let ended = false;
    switchesUnderWay++;
    scheduleInterfaceRefresh();
    return () => {
        if (ended) {
            return;
        }
        ended = true;
        switchesUnderWay--;
        scheduleInterfaceRefresh();
    };
}

/**
 * Runs the work that opens another conversation as one switch, and ends the switch when the work ends, whether it
 * succeeded, failed or opened nothing.
 * @template T
 * @param {() => T | Promise<T>} open
 * @returns {Promise<T>}
 */
export async function withConversationSwitch(open) {
    const end = beginConversationSwitch();
    try {
        return await open();
    } finally {
        end();
    }
}

/** Whether a send would go to a conversation other than the one on screen: a switch is under way, or the screen has not caught up with the selection. */
export function isComposerHeld() {
    return isConversationSwitching() || !isSelectedConversationOnScreen();
}
