/**
 * The composer is one textarea and one file input for every conversation, so what is typed in one conversation would
 * still be there when another is drawn, and a send would take it along. A draft is moved out of the composer when its
 * conversation is replaced on screen and moved back when that conversation is drawn again, so it stays with the
 * conversation it was typed in. Drafts live in memory only and are lost with the page.
 */

import { getConversationPendingFiles, setConversationPendingFiles } from './attachments.js';
import { CHROME_IDS } from './constants.js';
import { getRenderKeyConversation } from './render-key.js';

/**
 * Drafts of the conversations that are not on screen, by conversation (persona, character and group). `conversationId`
 * is the id of the conversation that the draft was typed in, empty when it had no record yet. A conversation that is
 * made after another one was deleted has the same key and another id, which tells the two apart.
 * @type {Map<string, { text: string, files: File[], conversationId: string }>}
 */
const drafts = new Map();

/** The id of the conversation that the composer belongs to now, empty when that conversation has no record. */
let shownConversationId = '';

function getInput() {
    const input = document.getElementById(CHROME_IDS.input);
    return input instanceof HTMLTextAreaElement ? input : null;
}

function writeText(input, text) {
    if (input.value === text) {
        return;
    }
    input.value = text;
    // The box resizes to what it holds on this event.
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function takeFromComposer(conversation) {
    const input = getInput();
    if (!input) {
        return;
    }

    const text = input.value;
    const files = getConversationPendingFiles();
    // An empty box keeps nothing and so leaves alone what an earlier take kept: the draft of the conversation that is on screen is never in `drafts`.
    if (text.trim() || files.length) {
        drafts.set(conversation, { text, files, conversationId: shownConversationId });
    }
    writeText(input, '');
    if (files.length) {
        setConversationPendingFiles([]);
    }
}

function giveToComposer(conversation, conversationId) {
    const draft = drafts.get(conversation);
    const input = getInput();
    if (!draft || !input) {
        return;
    }

    drafts.delete(conversation);
    // A draft typed before the conversation had a record belongs to it once it has one. Any other draft is its conversation's alone.
    if (draft.conversationId && draft.conversationId !== conversationId) {
        return;
    }
    writeText(input, draft.text);
    if (draft.files.length) {
        setConversationPendingFiles(draft.files);
    }
}

/**
 * Moves the draft of the conversation that was on screen out of the composer, and the draft of the one that is on
 * screen now in. Another chat of the same conversation is not a switch: the box stays as it is, which also keeps the
 * first message of a new conversation, whose chat appears while it is sent.
 * @param {string} drawnBefore The render key that was drawn before, empty when nothing was.
 * @param {string} drawnNow The render key that is drawn now, empty for the empty state.
 * @param {string} [conversationId] The id of the conversation that is drawn now, empty when it has no record.
 */
export function swapComposerDraft(drawnBefore, drawnNow, conversationId = '') {
    const before = getRenderKeyConversation(drawnBefore);
    const now = getRenderKeyConversation(drawnNow);
    if (before === now) {
        // A conversation that loses its record keeps the id that the box belongs to, so that its draft is not taken for the draft of the next one.
        shownConversationId ||= conversationId;
        return;
    }
    if (before) {
        takeFromComposer(before);
    }
    shownConversationId = conversationId;
    if (now) {
        giveToComposer(now, conversationId);
    }
}

/** Moves the draft of the conversation that is on screen out of the composer, for a workspace that closes and so draws nothing. */
export function stashComposerDraft(drawn) {
    const conversation = getRenderKeyConversation(drawn);
    if (conversation) {
        takeFromComposer(conversation);
    }
}

/**
 * Drops the drafts that were kept for a conversation that is deleted. The removal of one chat drops nothing, because a
 * draft is kept per conversation and the conversation stays.
 * @param {{ conversationId: string, chatId?: string }} removed
 */
export function forgetComposerDraftsOf(removed) {
    if (removed.chatId) {
        return;
    }
    for (const [conversation, draft] of [...drafts]) {
        if (draft.conversationId === removed.conversationId) {
            drafts.delete(conversation);
        }
    }
}
