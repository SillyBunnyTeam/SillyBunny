/**
 * The round resumer of this page (`round-resume.js`) on the conversation data module and the send queue, and the hook
 * that runs it for every chat that the data module reads from the server, after the replies that the server wrote into
 * that chat are landed as bubbles.
 */

import { enqueueConversationReply } from './send-queue.js';
import { getConversationPersonaId } from './context.js';
import { conversationData } from './conversation-data-browser.js';
import { getCharacterForAvatar } from './media.js';
import { finalizePendingReplies } from './reply-finalizer-browser.js';
import { createRoundResumer } from './round-resume.js';
import { sendQueue } from './state.js';

const resumer = createRoundResumer({
    data: conversationData,
    enqueue: enqueueConversationReply,
    getPersonaId: () => getConversationPersonaId(),
    getAnchor: view => view.characters.find(avatar => getCharacterForAvatar(avatar)) ?? view.characters[0] ?? '',
    hasQueuedReply: (view, chatId) => sendQueue.some(item => item.conversationKey === view.id && item.chatId === chatId),
});

let installed = false;

/**
 * Carries on a cut-off group round for every chat that the data module reads from the server. A round that the
 * server's reply ended in the middle of is found only after that reply is landed, so the hook lands it first.
 * Runs once.
 */
export function installRoundResume() {
    if (installed) {
        return;
    }
    installed = true;
    conversationData.onChatRead((address) => {
        finalizePendingReplies(address)
            .then(() => resumer.resume(address))
            .catch(error => console.warn('Conversation Mode: a group round could not be carried on', error));
    });
}
