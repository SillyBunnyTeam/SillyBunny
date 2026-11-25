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
 * @property {{ text: string, selfieRequests: string[], scheduleUpdates: string[], reminders: { delay: string, memo: string }[] }} commandParts
 * @property {Record<string, any>|null} commandMetadata What `extra.conversation_commands` holds for the first bubble.
 */

import {
    extractCharacterReplyCommandParts,
    getCharacterReplyCommandMetadata,
    normalizeConversationOutputText,
    splitChatroomMessages,
} from './generation-utils.js';
import { getSpeakerPrefixMatch, stripSpeakerPrefixText } from './members-utils.js';

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

function resolveReplySpeaker(messageText, fallbackSpeaker, speakers) {
    const speakerMatch = speakers.length ? getSpeakerPrefixMatch(messageText, speakers) : null;
    const speaker = speakerMatch?.speaker || fallbackSpeaker;
    const text = speakerMatch
        ? normalizeConversationOutputText(speakerMatch.text)
        : stripSpeakerPrefixText(messageText, speaker.name || fallbackSpeaker?.name || 'Character', normalizeConversationOutputText);

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
