import { createConversationChat } from '../../context.js';
import { downloadConversationChat } from '../../conversation-data-browser.js';
import { runConversationAction } from '../../chrome.js';
import { updateLastUserActivity } from '../../conversation-store.js';
import { requireView } from '../access.js';
import { identityOf, openConversation } from '../actions.js';
import { deleteChats, exportChatsArchive } from '../bulk-actions.js';
import { createBatchedList, createBulkSelection } from '../bulk-selection.js';
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

const rowKeyOf = chat => `chat:${chat.id}`;

/**
 * The chats of a conversation: open one, rename it, export it, delete it, or start a new one. The chat that is open is
 * marked. Selection mode exports the chosen chats as one ZIP or deletes them.
 */
export function buildChats({ conversationId, nav }) {
    requireView(conversationId);
    const { page, clamp } = createPage('sb-details-page--chats');
    const list = createCollection('Chats');
    /** The chats in the order that the page lists them, which is also the order that bulk actions work in. */
    let chats = [];

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
    const chatIdsOf = (selected) => {
        const chosen = new Set(selected);
        return chats.filter(chat => chosen.has(rowKeyOf(chat))).map(chat => chat.id);
    };

    const bulk = createBulkSelection({
        getList: () => list,
        rowSelector: '.sb-details-collection-row',
        getKey: row => row.dataset.sbListKey,
        getAllKeys: () => chats.map(rowKeyOf),
        actions: [
            { id: 'export', label: 'Export', icon: 'fa-solid fa-file-export', run: keys => exportChatsArchive(requireView(conversationId), chatIdsOf(keys)) },
            { id: 'delete', label: 'Delete', icon: 'fa-solid fa-trash-can', danger: true, run: keys => deleteChats(conversationId, chatIdsOf(keys)) },
        ],
    });

    const renderChat = (chat) => {
        const view = requireView(conversationId);
        const current = chat.id === view.activeChatId;
        const name = chat.name || 'Chat';
        const built = createCollectionRow({
            key: rowKeyOf(chat),
            label: name,
            subtitle: describeChat(chat),
            preview: chat.preview || null,
            current,
            onActivate: () => void openChat(chat.id),
            end: current ? [createCurrentMark()] : [],
            menu: {
                label: `Actions for ${name}`,
                sections: () => [
                    { items: [
                        createMenuItem('Open', 'folder-open', () => void openChat(chat.id)),
                        createMenuItem('Select', 'check-double', () => bulk.enter(rowKeyOf(chat), built.menuButton)),
                    ] },
                    { items: [
                        createMenuItem('Rename…', 'pencil', () => void run('rename-chat', chat.id)),
                        createMenuItem('Export', 'file-export', () => void exportChat(chat)),
                    ] },
                    { items: [createMenuItem('Delete…', 'trash-can', () => void run('delete-chat', chat.id), true)] },
                ],
            },
        });
        return built.row;
    };
    const batched = createBatchedList({ list, renderRow: renderChat, onDrawn: () => bulk.sync() });

    const draw = () => {
        const view = requireView(conversationId);
        chats = [...view.chats].sort((left, right) => (right.lastMessageAt || right.createdAt || 0) - (left.lastMessageAt || left.createdAt || 0));
        redrawKeepingFocus(list, () => batched.update(chats));
        bulk.setSelectable(chats.length > 0);
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
        list.querySelector(`[data-sb-list-key="${rowKeyOf(created)}"]`)?.focus({ preventScroll: false });
    };

    const action = el('div', 'sb-details-page-action');
    action.append(createPillButton('New Chat', { onClick: () => void newChat() }));
    clamp.append(list, batched.element, action);

    const stop = watchConversation(conversationId, getChatsSignature, { onChange: draw, onGone: () => nav.gone() });
    return {
        title: getPageTitle('chats'),
        content: page,
        canClose: reason => bulk.canClose(reason),
        leaveSelection: () => bulk.exit(),
        onMount(context) {
            bulk.mount(context);
            bulk.setSelectable(chats.length > 0);
        },
        dispose() {
            stop();
            batched.destroy();
            bulk.destroy();
        },
    };
}
