/**
 * The finalizer of this page (`reply-finalizer.js`) on the conversation data module and the page's own functions, and
 * the hook that runs it for every chat that the data module reads from the server.
 */

import { cleanUpMessage, getRequestHeaders } from '../../script.js';
import { removeReasoningFromString } from '../reasoning.js';
import { conversationData } from './conversation-data-browser.js';
import { buildConversationMessageReplyReference } from './conversation-store.js';
import { createTargetCheck } from './deletion-guards.js';
import { commitCharacterReplyCommands, generateSelfieFromContext, getConversationReplySpeakers } from './generation.js';
import { getCharacterForAvatar } from './media.js';
import { getConversationMemberSettings } from './members.js';
import { afterIncomingMessage } from './message-writer.js';
import { markReminderDelivered } from './reminders.js';
import { createReplyFinalizer } from './reply-finalizer.js';
import { getSettings } from './settings-store.js';

const ACKNOWLEDGE_URL = '/api/resumable-generations/acknowledge';

/**
 * The clean-up that `generateRaw()` (`public/script.js`) applies to a reply when it is not given a JSON schema, with the
 * arguments that `generateConversationReply()` passes it (`trimNames` is true). A reply that came through a connection
 * profile gets none of it, only the removal of its reasoning: `generateConversationRaw()` returns what
 * `extractProfileResponseText()` makes of the response. A test pins the arguments to the ones in `generateRaw()`.
 */
export function cleanUpServerReply(route, text) {
    if (route === 'raw') {
        return cleanUpMessage({
            getMessage: text,
            isImpersonate: false,
            isContinue: false,
            displayIncompleteSentences: true,
            includeUserPromptBias: false,
            trimNames: true,
            trimWrongNames: true,
        });
    }
    return removeReasoningFromString(text);
}

/** Tells the server that this page has seen the outcome of these generations, so that it stops reporting them. */
export function acknowledgeGenerations(ids) {
    if (!ids.length) {
        return;
    }
    fetch(ACKNOWLEDGE_URL, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ ids }), cache: 'no-store' }).catch(() => undefined);
}

const finalizer = createReplyFinalizer({
    data: conversationData,
    page: {
        context(view, reply) {
            // Resolve from the live conversation view so renamed characters or removed group members do not pin a stale anchor.
            const anchorAvatar = view.kind === 'direct'
                ? (view.characters[0] || '')
                : (view.characters.find(avatar => getCharacterForAvatar(avatar)) ?? view.characters[0] ?? reply.anchor ?? '');
            const groupId = view.kind === 'group' ? view.id : '';
            const personaId = view.personaId;
            const hostSettings = getSettings(anchorAvatar, { groupId, personaId });
            return {
                anchorAvatar,
                groupId,
                personaId,
                speakersFor: fallbackSpeaker => (groupId ? getConversationReplySpeakers(anchorAvatar, fallbackSpeaker, groupId, personaId) : []),
                settingsFor(speakerAvatar) {
                    if (groupId) {
                        return getSettings(speakerAvatar, { groupId, personaId });
                    }
                    return speakerAvatar === anchorAvatar ? hostSettings : getConversationMemberSettings(speakerAvatar, hostSettings, { groupId, personaId });
                },
            };
        },
        cleanUpText: cleanUpServerReply,
        buildReference: buildConversationMessageReplyReference,
        afterIncoming: afterIncomingMessage,
        runCommands: commitCharacterReplyCommands,
        makeSelfie: (request, { address, anchorAvatar, groupId, personaId, settings }) => generateSelfieFromContext(request.context, settings, request.speakerAvatar, {
            anchorAvatar,
            role: request.role,
            name: request.speaker.name || '',
            extra: request.extra,
            chatId: address.chatId,
            groupId,
            personaId,
            validateTarget: createTargetCheck(id => conversationData.get(id), address),
            messageId: request.id,
        }),
        acknowledge: acknowledgeGenerations,
        markReminderDelivered: (conversationId, reminderId) => conversationData.patchReminder(conversationId, reminderId, markReminderDelivered(Date.now())),
    },
});

/**
 * Lands the replies that the server wrote into a loaded chat.
 * @param {{ conversationId: string, chatId: string }} address
 * @returns {Promise<import('./reply-finalizer.js').LandedReply[]>}
 */
export const finalizePendingReplies = finalizer.finalize;

/** Whether this page landed the reply of the generation. */
export const wasReplyLanded = finalizer.wasLanded;

let installed = false;

/**
 * Lands the pending replies of every chat that the data module reads from the server, whichever code loaded it: the
 * chat that the page opens, the chat that a prompt needs, a reload after a conflict. Runs once.
 */
export function installReplyFinalizer() {
    if (installed) {
        return;
    }
    installed = true;
    conversationData.onChatRead((address) => {
        finalizer.finalize(address).catch(error => console.warn('Conversation Mode: a reply that the server wrote could not be landed', error));
    });
}
