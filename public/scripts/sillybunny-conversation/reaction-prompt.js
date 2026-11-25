/**
 * What the model is told about the reactions of the chat. A character's own reaction is taken out of its reply, so
 * without this it could not see what it did, and the reactions of the user and of the other members are facts of the chat.
 * The lines are one system message, never a suffix on a message of the transcript: a model copies the shape of the
 * assistant messages that it sees, and a suffix could come back in its own reply.
 */

import { USER_REACTOR, readReactions } from './reaction-model.js';

/** Reactions older than this many messages of the transcript are not worth a line. */
export const REACTION_CONTEXT_MESSAGES = 8;
export const REACTION_CONTEXT_MAX_LINES = 6;
const QUOTE_LENGTH = 48;

function quote(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!flat) {
        return '';
    }
    return flat.length > QUOTE_LENGTH ? `${flat.slice(0, QUOTE_LENGTH).trimEnd()}…` : flat;
}

/**
 * @param {object[]} messages The messages of the transcript that the prompt sends.
 * @param {object} names
 * @param {string} names.speakerName Whose reply is asked for: a reaction to this speaker's message is to "your message".
 * @param {string} names.userName
 * @param {(avatar: string) => string} names.getCharacterName The name on a card, or an empty text.
 * @returns {string} The text of the message, or an empty text when no recent message has a reaction.
 */
export function buildReactionsContext(messages, { speakerName, userName, getCharacterName }) {
    const nameOf = reactor => (reactor === USER_REACTOR
        ? userName
        : getCharacterName(reactor) || reactor.replace(/\.[a-z0-9]+$/i, ''));

    const lines = [];
    for (const message of messages.slice(-REACTION_CONTEXT_MESSAGES)) {
        const byReactor = new Map();
        for (const entry of [...readReactions(message)].sort((left, right) => left.at - right.at)) {
            byReactor.set(entry.by, [...(byReactor.get(entry.by) ?? []), entry.emoji]);
        }
        if (!byReactor.size) {
            continue;
        }
        const target = message.name === speakerName ? 'your message' : `${message.name || 'Speaker'}'s message`;
        const text = quote(message.mes);
        for (const [reactor, emoji] of byReactor) {
            lines.push(`- ${nameOf(reactor)} reacted ${emoji.join(' ')} to ${target}${text ? `: "${text}"` : '.'}`);
        }
    }
    return lines.length ? ['Recent reactions:', ...lines.slice(-REACTION_CONTEXT_MAX_LINES)].join('\n') : '';
}
