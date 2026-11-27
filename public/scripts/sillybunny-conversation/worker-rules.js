/**
 * The rules of the automatic worker that need no page: whether a chat is due for a message that its characters start,
 * what kind of message that is, and who sends it. Nothing here reads the page or the clock, so a test can set any state.
 * The worker (`auto-engine.js`) reads the state of the page, asks these functions, and then acts.
 */

import { DEFAULT_MAX_FOLLOWUPS } from './constants.js';

const MINUTE_MS = 60 * 1000;
/** The most automatic messages that one chat gets after the last message of the user, whatever the setting says. */
export const MAX_AUTOMATIC_FOLLOWUPS = 3;
const BUSY_PATIENCE_FACTOR = 3;

/**
 * Messaging first is the one switch of a conversation. Every other kind of automatic message (a check-in, members that
 * talk to each other, a picture that follows one) is behind it.
 * @param {Record<string, any>} settings The settings of the conversation.
 * @returns {{ enabled: boolean, maxFollowups: number }}
 */
export function readMessagingFirstSettings(settings) {
    const requested = Math.floor(Number(settings?.max_followups));
    const maxFollowups = Number.isFinite(requested) ? requested : DEFAULT_MAX_FOLLOWUPS;
    return {
        enabled: settings?.proactive_messaging === true,
        maxFollowups: Math.min(Math.max(maxFollowups, 1), MAX_AUTOMATIC_FOLLOWUPS),
    };
}

/**
 * @typedef {object} AutomaticMessageState
 * @property {number} now
 * @property {number} lastUserActivity When the user last wrote in the chat.
 * @property {number} lastAutoMessageAt When the last automatic message of the chat started; 0 when there is none.
 * @property {number} sentCount Automatic messages sent since the user last wrote.
 * @property {number} maxFollowups
 * @property {number} patienceMinutes The speaker's patience, scaled by its talkativeness.
 * @property {string} lastMessageRole Role of the last message of the chat.
 * @property {string} userStatus
 * @property {string} speakerStatus The status of the character that would send the message.
 * @property {boolean} isGroup
 */

/**
 * Whether the chat is due for an automatic message now, and which kind. Null when it is not due.
 *
 * The first message waits for the user to be quiet for the patience; each one after it waits twice as long as the one
 * before, counted from the last automatic message, until the maximum of unanswered messages is reached. A message of
 * the user that nobody answered (the character was away when it came) is answered at once.
 *
 * `check_in` is a message to the user. In a group, once a check-in has gone unanswered, the next messages are the
 * members talking to each other: the user was asked, so the members carry on among themselves.
 * @param {AutomaticMessageState} state
 * @returns {{ kind: 'check_in'|'member_talk' }|null}
 */
export function planAutomaticMessage({ now, lastUserActivity, lastAutoMessageAt, sentCount, maxFollowups, patienceMinutes, lastMessageRole, userStatus, speakerStatus, isGroup }) {
    if (userStatus === 'offline' || userStatus === 'dnd' || speakerStatus === 'offline') {
        return null;
    }

    const kind = isGroup && sentCount >= 1 ? 'member_talk' : 'check_in';
    if (lastMessageRole === 'user' && sentCount === 0) {
        return { kind };
    }
    if (sentCount >= maxFollowups) {
        return null;
    }

    const waitMinutes = patienceMinutes * (speakerStatus === 'dnd' ? BUSY_PATIENCE_FACTOR : 1);
    const quietSince = sentCount === 0 ? lastUserActivity : lastAutoMessageAt;
    const requiredMinutes = sentCount === 0 ? waitMinutes : waitMinutes * 2 ** sentCount;
    return (now - quietSince) / MINUTE_MS >= requiredMinutes ? { kind } : null;
}

/** The index of the last message that a character wrote; the anchor writes the messages of the role `character`. */
function getLastSpokeIndex(messages, avatar, anchorAvatar) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        const speaker = message?.role === 'character' ? anchorAvatar : message?.role === 'member' ? message?.extra?.member_avatar : '';
        if (speaker === avatar) {
            return index;
        }
    }
    return -1;
}

/**
 * Who sends the next automatic message: the member that spoke least recently, so that a group takes turns. A member that
 * is offline does not start anything, and in a group neither does a member whose talkativeness is 0 (it speaks only
 * when named). In a direct conversation the one character speaks whatever its talkativeness: there the value only
 * scales its patience.
 * @param {{ members: { avatar: string, talkativeness: number, status: string }[], messages: object[], anchorAvatar: string, isGroup: boolean }} state
 * @returns {{ avatar: string, talkativeness: number, status: string }|null}
 */
export function pickAutomaticSpeaker({ members, messages, anchorAvatar, isGroup }) {
    const eligible = members.filter(member => member.status !== 'offline' && (!isGroup || member.talkativeness > 0));
    if (!eligible.length) {
        return null;
    }
    return eligible
        .map((member, order) => ({ member, order, lastSpoke: getLastSpokeIndex(messages, member.avatar, anchorAvatar) }))
        .sort((left, right) => left.lastSpoke - right.lastSpoke || left.order - right.order)[0].member;
}
