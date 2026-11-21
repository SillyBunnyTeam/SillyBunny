import { characters, chat, this_chid } from '../../script.js';
import { eventSource, event_types } from '../events.js';
import { selected_group } from '../group-chats.js';
import { createGreetingArt } from './greeting-art.js';
import { openGreetingArtViewer } from './greeting-art-viewer.js';

/**
 * Wires the greeting picture into the app. The picture is added to the page and never to the chat, so nothing that
 * builds a prompt or saves a chat can reach it.
 *
 * Printing a chat is covered by the controller's own observer. These events cover what changes the chat without
 * changing the list of messages: a swipe that leaves message 0, or an edit.
 */
const chatElement = document.getElementById('chat');

if (chatElement) {
    const greetingArt = createGreetingArt({
        chatElement,
        openViewer: art => openGreetingArtViewer(art),
        readChat: () => ({
            avatar: characters[this_chid]?.avatar,
            message: chat[0],
            messageCount: chat.length,
            inGroup: Boolean(selected_group),
            inConversation: document.getElementById('sheld')?.getAttribute('data-sb-conversation-mode') === 'on',
        }),
    });

    eventSource.on(event_types.CHAT_CHANGED, chatId => greetingArt.chatOpened(chatId));
    for (const type of [
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_SWIPE_DELETED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_UPDATED,
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.MORE_MESSAGES_LOADED,
    ]) {
        eventSource.on(type, () => greetingArt.sync());
    }
    greetingArt.start();
}
