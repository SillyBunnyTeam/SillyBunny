/**
 * The composer is one textarea and one file input for every conversation, so what is typed in one conversation would
 * still be there when another is drawn, and a send would take it along. A draft is moved out of the composer when its
 * conversation is replaced on screen and moved back when that conversation is drawn again, so it stays with the
 * conversation it was typed in. Drafts live in memory only and are lost with the page.
 */

import { getConversationPendingFiles, setConversationPendingFiles } from './attachments.js';
import { CHROME_IDS } from './constants.js';
import { getRenderKeyConversation } from './render-key.js';

/** @type {Map<string, { text: string, files: File[] }>} Drafts of the conversations that are not on screen, by conversation. */
const drafts = new Map();

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
        drafts.set(conversation, { text, files });
    }
    writeText(input, '');
    if (files.length) {
        setConversationPendingFiles([]);
    }
}

function giveToComposer(conversation) {
    const draft = drafts.get(conversation);
    const input = getInput();
    if (!draft || !input) {
        return;
    }

    drafts.delete(conversation);
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
 */
export function swapComposerDraft(drawnBefore, drawnNow) {
    const before = getRenderKeyConversation(drawnBefore);
    const now = getRenderKeyConversation(drawnNow);
    if (before === now) {
        return;
    }
    if (before) {
        takeFromComposer(before);
    }
    if (now) {
        giveToComposer(now);
    }
}

/** Moves the draft of the conversation that is on screen out of the composer, for a workspace that closes and so draws nothing. */
export function stashComposerDraft(drawn) {
    const conversation = getRenderKeyConversation(drawn);
    if (conversation) {
        takeFromComposer(conversation);
    }
}
