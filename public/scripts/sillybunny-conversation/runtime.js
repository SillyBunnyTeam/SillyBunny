/**
 * What Conversation Mode does without the workspace: the worker that writes the automatic messages, the asides to the
 * roleplay chats, and the replies that the server wrote, with the event stream that tells of them. It loads when the
 * persona has a conversation or the workspace opens (`lazy-parts.js`), so a page of a user who has none never fetches it.
 */

import { chat } from '../../script.js';
import { selected_group } from '../group-chats.js';
import {
    captureGroupAsideRequest,
    captureRoleplayAsideRequest,
    checkGroupChatMention,
    startConversationAutoWorker,
    triggerGroupAside,
    triggerRoleplayAside,
} from './auto-engine.js';
import { GROUP_ASIDE_RANDOM_CHANCE } from './constants.js';
import { getConversationPersonaId, getRoleplayCurrentCharacter, getRoleplayGroupById } from './context.js';
import { getCharacterForGroupChatMessage, getCurrentGroupConversationMembers } from './conversation-list.js';
import { installReplyEvents } from './reply-events-browser.js';
import { installReplyFinalizer } from './reply-finalizer-browser.js';
import { installRoundResume } from './round-resume-browser.js';
import { getSettings } from './settings-store.js';
import { conversationState } from './state.js';
import { setConversationTimeout } from './timers.js';

export { stopConversationAutoWorker } from './auto-engine.js';

/** Lands the replies that the server wrote and follows the event stream. Each part installs itself once. */
export function installConversationReplyStream() {
    installReplyFinalizer();
    installRoundResume();
    installReplyEvents();
}

export function startConversationWorker() {
    if (!conversationState.autoWorkerStarted) {
        startConversationAutoWorker();
    }
}

/** A message of the user in a roleplay group chat can name a member, who then answers in Conversation Mode. */
export function handleRoleplayUserMessage(messageId) {
    if (selected_group) {
        checkGroupChatMention(messageId);
    }
}

/**
 * Occasional private asides keep Conversation Mode feeling connected without forcing a public group-chat reply.
 * @param {number} messageId The index of the message in the roleplay chat.
 */
export function handleRoleplayCharacterMessage(messageId) {
    if (Math.random() >= GROUP_ASIDE_RANDOM_CHANCE) {
        return;
    }

    if (selected_group) {
        const sourceGroupId = String(selected_group || '');
        const roleplayGroup = getRoleplayGroupById(sourceGroupId);
        const members = getCurrentGroupConversationMembers({ group: roleplayGroup, requireRoleplayReactions: true });
        const speaker = getCharacterForGroupChatMessage(chat[messageId]);
        const speakerMember = speaker?.avatar ? members.find(item => item.character?.avatar === speaker.avatar) : null;
        const chosenMember = speakerMember && Math.random() < 0.65
            ? speakerMember
            : members[Math.floor(Math.random() * members.length)];
        if (chosenMember?.character) {
            const reason = speakerMember?.character?.avatar === chosenMember.character.avatar ? 'reaction' : 'random';
            const personaId = getConversationPersonaId();
            const request = captureGroupAsideRequest(chosenMember.character, {
                personaId,
                reason,
                sourceGroup: roleplayGroup,
                sourceGroupId,
                sourceMessageId: messageId,
            });
            if (request) {
                setConversationTimeout(() => void triggerGroupAside(chosenMember.character, request), 2000);
            }
        }
        return;
    }

    const roleplayCharacter = getCharacterForGroupChatMessage(chat[messageId]) || getRoleplayCurrentCharacter();
    const avatar = roleplayCharacter?.avatar || '';
    const personaId = getConversationPersonaId();
    if (!avatar || !getSettings(avatar, { groupId: '', personaId }).roleplay_reactions) {
        return;
    }
    const request = captureRoleplayAsideRequest({ avatar, personaId, sourceMessageId: messageId });
    if (request) {
        setConversationTimeout(() => void triggerRoleplayAside(request), 2000);
    }
}
