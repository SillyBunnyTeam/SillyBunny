import { createConversationChat } from '../../context.js';
import { downloadConversationChat } from '../../conversation-data-browser.js';
import { runConversationAction } from '../../chrome.js';
import { updateLastUserActivity } from '../../conversation-store.js';
import { requireView } from '../access.js';
import { identityOf, openConversation } from '../actions.js';
import { formatWhen, getChatsSignature, getPageTitle } from '../details-logic.js';
import { createCollection, createCollectionRow, createMenuItem, createPage, createPillButton, el, icon, redrawKeepingFocus, watchConversation } from '../page-kit.js';

function describeChat(chat) {
    const count = chat.messageCount ?? 0;
    const when = formatWhen(chat.lastMessageAt || chat.createdAt);
    return [`${count} ${count === 1 ? 'message' : 'messages'}`, when].filter(Boolean).join(' · ');
}

function createCurrentMark() {
    const mark = el('span', 'sb-details-current-mark');
    mark.append(icon('check'), el('span', 'sr-only', 'Current Chat'));
    return mark;
}

/** The chats of a conversation: open one, rename it, export it, delete it, or start a new one. The chat that is open is marked. */
export function buildChats({ conversationId, nav }) {
    requireView(conversationId);
    const { page, clamp } = createPage('sb-details-page--chats');
    const list = createCollection('Chats');

    const openChat = async (chatId) => {
        if (await openConversation(requireView(conversationId), { chatId })) {
            await nav.close();
        }
    };
    const run = (action, chatId) => {
        const { avatar, groupId } = identityOf(requireView(conversationId));
        return runConversationAction(action, { avatar, groupId, chatId });
    };
    const exportChat = async (chat) => {
        try {
            await downloadConversationChat({ conversationId, chatId: chat.id });
        } catch (error) {
            console.error('Conversation Mode: the chat could not be exported', error);
            globalThis.toastr?.error?.('The chat could not be exported');
        }
    };

    const draw = () => {
        const view = requireView(conversationId);
        const chats = [...view.chats].sort((left, right) => (right.lastMessageAt || right.createdAt || 0) - (left.lastMessageAt || left.createdAt || 0));
        redrawKeepingFocus(list, () => {
            list.replaceChildren(...chats.map((chat) => {
                const current = chat.id === view.activeChatId;
                const name = chat.name || 'Chat';
                return createCollectionRow({
                    key: `chat:${chat.id}`,
                    label: name,
                    subtitle: describeChat(chat),
                    preview: chat.preview || null,
                    current,
                    onActivate: () => void openChat(chat.id),
                    end: current ? [createCurrentMark()] : [],
                    menu: {
                        label: `Actions for ${name}`,
                        sections: () => [
                            { items: [createMenuItem('Open', 'folder-open', () => void openChat(chat.id))] },
                            { items: [
                                createMenuItem('Rename…', 'pencil', () => void run('rename-chat', chat.id)),
                                createMenuItem('Export', 'file-export', () => void exportChat(chat)),
                            ] },
                            { items: [createMenuItem('Delete…', 'trash-can', () => void run('delete-chat', chat.id), true)] },
                        ],
                    },
                }).row;
            }));
        });
    };
    draw();

    const newChat = async () => {
        const view = requireView(conversationId);
        const { avatar, groupId } = identityOf(view);
        const created = createConversationChat(avatar, `Chat ${view.chats.length + 1}`, { groupId, personaId: view.personaId });
        if (!created) {
            return;
        }
        updateLastUserActivity(avatar, { groupId, personaId: view.personaId });
        await openConversation(view, { chatId: created.id });
        draw();
        list.querySelector(`[data-sb-list-key="chat:${created.id}"]`)?.focus({ preventScroll: false });
    };

    const action = el('div', 'sb-details-page-action');
    action.append(createPillButton('New Chat', { onClick: () => void newChat() }));
    clamp.append(list, action);

    const stop = watchConversation(conversationId, getChatsSignature, { onChange: draw, onGone: () => nav.close() });
    return { title: getPageTitle('chats'), content: page, dispose: stop };
}
