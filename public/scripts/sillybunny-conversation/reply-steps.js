/**
 * What a generated reply says, before anything is written: who speaks each line, the text of each bubble, and the
 * commands that the text carried. The live path (`generation.js`) waits and appends from this, and the finalizer of a
 * reply that the server wrote does the same without the waits. Nothing here reads the page, so the two cannot drift
 * apart and a unit test can run it.
 *
 * @typedef {{ avatar: string, name: string }} ReplySpeaker
 * @typedef {object} ReplyGroup One line of the reply as the model wrote it, or one paragraph.
 * @property {ReplySpeaker} speaker The member that the line is given to.
 * @property {string} speakerAvatar
 * @property {string[]} bubbles The text of each bubble, clean. Empty when the line was only commands.
 * @property {{ text: string, selfieRequests: string[], scheduleUpdates: string[], reminders: { delay: string, memo: string }[], reaction: string|null }} commandParts
 * @property {Record<string, any>|null} commandMetadata What `extra.conversation_commands` holds for the first bubble.
 */

import {
    extractCharacterReplyCommandParts,
    getCharacterReplyCommandMetadata,
    hasCharacterReplyCommandSideEffects,
    normalizeConversationOutputText,
    splitChatroomMessages,
} from './generation-utils.js';
import { getSpeakerPrefixMatch, stripSpeakerPrefixText } from './members-utils.js';
import { createRoundMarker, findRoundToResume } from './rounds.js';

/** One message per line, for a member that answers like a chatroom; paragraphs when every line is empty after clean-up. */
export function splitMemberChatroomMessages(text) {
    const messages = String(text || '')
        .split(/\n+/)
        .map(part => normalizeConversationOutputText(part))
        .filter(Boolean);
    return messages.length ? messages : splitChatroomMessages(text).map(part => normalizeConversationOutputText(part)).filter(Boolean);
}

function splitGeneratedReplyMessages(rawText, speakers, { splitEveryLine }) {
    const text = String(rawText || '').trim();
    if (!text) {
        return [];
    }

    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (speakers.length && lines.length > 1 && lines.some(line => getSpeakerPrefixMatch(line, speakers))) {
        return lines.reduce((messages, line) => {
            if (!messages.length || getSpeakerPrefixMatch(line, speakers)) {
                messages.push(line);
            } else {
                messages[messages.length - 1] = `${messages[messages.length - 1]}\n${line}`;
            }
            return messages;
        }, []);
    }

    return splitEveryLine ? splitMemberChatroomMessages(text) : splitChatroomMessages(text);
}

/**
 * The text keeps its double quotes: the commands of the line are read from it next, and `schedule_update` and
 * `selfie` carry `key="value"` arguments. `extractCharacterReplyCommandParts()` normalizes what is left of the text.
 */
function resolveReplySpeaker(messageText, fallbackSpeaker, speakers) {
    const speakerMatch = speakers.length ? getSpeakerPrefixMatch(messageText, speakers) : null;
    const speaker = speakerMatch?.speaker || fallbackSpeaker;
    const text = speakerMatch
        ? speakerMatch.text.trim()
        : stripSpeakerPrefixText(messageText, speaker.name || fallbackSpeaker?.name || 'Character');

    return { speaker, text };
}

/**
 * @param {string} rawText The reply of the model, after the clean-up that its request route applies.
 * @param {object} options
 * @param {ReplySpeaker} options.speaker Who speaks a line that starts with no name.
 * @param {'character'|'member'} [options.mode] A member answers one line at a time.
 * @param {ReplySpeaker[]} [options.speakers] The speakers whose name may start a line. Empty in a direct conversation,
 * where a name at the start of a line is part of the text.
 * @param {Record<string, any>} [options.settings] Which commands the text may carry (`schedule_command_enabled`, `selfie_command_enabled`).
 * @returns {ReplyGroup[]}
 */
export function buildReplySteps(rawText, { speaker, mode = 'character', speakers = [], settings = {} }) {
    return splitGeneratedReplyMessages(rawText, speakers, { splitEveryLine: mode === 'member' }).map((rawMessage) => {
        const resolved = resolveReplySpeaker(rawMessage, speaker, speakers);
        const commandParts = extractCharacterReplyCommandParts(resolved.text, settings);
        return {
            speaker: resolved.speaker,
            speakerAvatar: resolved.speaker.avatar || speaker.avatar,
            bubbles: splitChatroomMessages(commandParts.text).map(part => normalizeConversationOutputText(part)).filter(Boolean),
            commandParts,
            commandMetadata: getCharacterReplyCommandMetadata(commandParts),
        };
    });
}

/**
 * The reactions of a reply: the first that each speaker's lines carry. A line that is only the marker has no bubble and
 * counts. A speaker that answers more than once reacts once.
 * @param {ReplyGroup[]} groups
 * @returns {{ speakerAvatar: string, emoji: string }[]}
 */
export function collectReplyReactions(groups) {
    const reactions = [];
    for (const { speakerAvatar, commandParts } of groups) {
        if (commandParts.reaction && !reactions.some(reaction => reaction.speakerAvatar === speakerAvatar)) {
            reactions.push({ speakerAvatar, emoji: commandParts.reaction });
        }
    }
    return reactions;
}

/**
 * The `extra` keys that each bubble of a message carries, by what asked for the message. The live path of the worker and
 * the finalizer of a message that the server wrote both use this, so that the two cannot give a message different flags.
 * @param {string} origin `reply`, `auto`, `auto_chat` or `reminder`.
 * @param {string} [reminderId] The reminder that a message of the origin `reminder` delivers.
 */
export function getReplyOriginFlags(origin, reminderId = '') {
    switch (origin) {
        case 'auto':
            return { conversation_mode_auto: true, proactive: true };
        case 'auto_chat':
            return { conversation_mode_auto_chat: true };
        case 'reminder':
            return { conversation_mode_reminder: true, reminder_id: reminderId };
        default:
            return { conversation_mode_reply: true };
    }
}

/**
 * The bubbles that a pending reply becomes, built the way the live path writes them: the same roles, names and
 * `extra` keys, one reply card on the first bubble of each speaker, the command metadata on the first bubble of a
 * line. Ids and times come from the pending message (`<id>.<n>`, one millisecond apart), so that two pages that land
 * the same reply build the same bubbles and the data module's merge by id collapses them.
 * @param {{ id: string, created_at: number }} message The pending message.
 * @param {import('./pending-reply.js').PendingReply} reply Its marker.
 * @param {ReplyGroup[]} groups What `buildReplySteps()` made of its text.
 * @param {object} context
 * @param {string} context.anchorAvatar Who the role `character` belongs to; every other speaker is a member.
 * @param {Record<string, any>|null} [context.reference] The reply card for the message that the reply answers.
 * @returns {{ bubbles: object[], selfieRequests: { id: string, speaker: ReplySpeaker, speakerAvatar: string, context: string, role: string, extra: Record<string, any> }[], sideEffects: { speakerAvatar: string, commandParts: ReplyGroup['commandParts'], idPrefix: string }[] }}
 * `sideEffects` are the schedule updates and reminders, which the page runs once after the bubbles are saved;
 * `selfieRequests` are the pictures to make after that. `idPrefix` makes the reminder ids the same on every page.
 */
export function buildPendingBubbles(message, reply, groups, { anchorAvatar, reference = null }) {
    const bubbles = [];
    const selfieRequests = [];
    const sideEffects = [];
    const speakersWithReference = new Set();
    const createdAt = Number(message.created_at) || 0;

    const extraFor = (speakerAvatar) => {
        const extra = {
            ...getReplyOriginFlags(reply.origin, reply.reminder),
            reply_token: reply.token,
        };
        if (speakerAvatar !== anchorAvatar) {
            extra.member_avatar = speakerAvatar;
        }
        if (reference && !speakersWithReference.has(speakerAvatar)) {
            speakersWithReference.add(speakerAvatar);
            extra.conversation_reply_to = { ...reference };
        }
        return extra;
    };

    groups.forEach((group, groupIndex) => {
        const { speaker, speakerAvatar } = group;
        const role = speakerAvatar !== anchorAvatar ? 'member' : 'character';
        group.bubbles.forEach((text, bubbleIndex) => {
            const time = createdAt + bubbles.length;
            const extra = extraFor(speakerAvatar);
            if (bubbleIndex === 0 && group.commandMetadata) {
                extra.conversation_commands = structuredClone(group.commandMetadata);
            }
            bubbles.push({
                id: `${message.id}.${bubbles.length}`,
                role,
                name: speaker.name || 'Character',
                is_user: false,
                is_system: false,
                mes: text,
                send_date: new Date(time).toISOString(),
                created_at: time,
                extra,
            });
        });
        if (group.bubbles.length && hasCharacterReplyCommandSideEffects(group.commandParts)) {
            sideEffects.push({ speakerAvatar, commandParts: group.commandParts, idPrefix: `rem_${message.id}_g${groupIndex}` });
        }
        for (const context of group.commandParts.selfieRequests) {
            selfieRequests.push({ id: `${message.id}.s${selfieRequests.length}`, speaker, speakerAvatar, context, role, extra: extraFor(speakerAvatar) });
        }
    });

    const roundMarker = getPendingReplyRoundMarker(reply);
    if (bubbles.length && roundMarker) {
        bubbles[bubbles.length - 1].extra.conversation_round = roundMarker;
    }

    return { bubbles, selfieRequests, sideEffects };
}

/**
 * The round marker carried by a pending reply when more group members still have to speak.
 * @param {import('./pending-reply.js').PendingReply|null|undefined} reply
 * @returns {{ remaining: string[], started: number, triggers: string[] }|null}
 */
export function getPendingReplyRoundMarker(reply) {
    if (!reply?.round?.length) {
        return null;
    }
    return createRoundMarker({ remaining: reply.round, started: reply.roundStarted, triggers: reply.triggers });
}

/**
 * Finds a cut-off group round from replies that just landed with no bubbles (such as a reaction-only turn),
 * where `buildPendingBubbles()` had no bubble to attach `extra.conversation_round` to.
 * @param {import('./reply-finalizer.js').LandedReply[]} landed
 * @param {Record<string, any>[]} messages Chat messages after pending replies landed.
 * @param {number} now
 * @returns {{ remaining: string[], started: number, triggers: string[] }|null}
 */
export function findLandedRoundToResume(landed, messages, now) {
    const lastLanded = Array.isArray(landed) ? landed.at(-1) : null;
    if (!lastLanded || lastLanded.bubbleIds?.length) {
        return null;
    }
    const { reply } = lastLanded;
    const marker = getPendingReplyRoundMarker(reply);
    if (!marker || !marker.triggers.length) {
        return null;
    }
    // A duplicate pending reply whose bubbles were already in the chat is not a reaction-only turn.
    if (reply.token && messages.some(message => message?.extra?.reply_token === reply.token)) {
        return null;
    }
    // Any message written after the trigger means the conversation moved on past the reaction-only turn.
    const lastMessage = messages.at(-1);
    if (!lastMessage || lastMessage.role !== 'user' || !marker.triggers.includes(lastMessage.id)) {
        return null;
    }
    return findRoundToResume([...messages, { extra: { conversation_round: marker } }], now);
}
