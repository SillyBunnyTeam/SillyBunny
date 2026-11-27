/**
 * Media, Files and Pinned: what the open chat of the conversation shares. These pages replace the filter tabs of the
 * timeline. Each draws from the loaded messages of the active chat and redraws when that chat changes. Each page also
 * has selection mode: Media and Files download or remove what is chosen, Pinned unpins it.
 */

import { createLazyImage } from '../../../sillybunny-editor/lazy-image.js';
import { createStatusPage } from '../../../sillybunny-editor/status-page.js';
import { conversationData, getCardName, requireView } from '../access.js';
import { showMessageInTimeline } from '../actions.js';
import { createCharacterAvatar, createAvatar } from '../avatars.js';
import { downloadAttachmentsArchive, removeAttachmentsFromChat } from '../bulk-actions.js';
import { createBatchedList, createBulkSelection } from '../bulk-selection.js';
import { collectSharedItems, formatFileSize, formatWhen, getPageTitle, toSafeAttachmentUrl } from '../details-logic.js';
import { createCollection, createCollectionRow, createMenuItem, createPage, el, icon, redrawKeepingFocus, showUndoToast } from '../page-kit.js';
import { setMessagePin } from '../../pin-model.js';
import { scheduleTimelineRender } from '../../render-scheduler.js';

function describeSender(item) {
    if (item.memberAvatar) {
        return getCardName(item.memberAvatar);
    }
    return item.senderName || (item.senderRole === 'user' ? 'You' : 'Character');
}

/**
 * The shell of the three pages: the loading and error states, the empty state, the list with its Show More row, and
 * selection mode. The page gives the list, how an item draws, and what its actions do.
 * @param {object} options
 * @param {() => HTMLElement} options.createList The element that holds the rows; it stays for as long as the page is open.
 * @param {string} options.rowSelector
 * @param {(item: any) => string} options.keyOf The key of an item's row, which selection mode and Select All use.
 * @param {(item: any, bulk: ReturnType<typeof createBulkSelection>) => HTMLElement} options.renderItem
 * @param {{ icon: string, title: string }} options.empty
 * @param {(itemsOf: (keys: string[]) => any[]) => import('../bulk-selection.js').BulkAction[]} options.actions
 * @param {boolean} [options.gestures] A secondary click or a long press on a row starts selection; for rows that have no menu.
 * @param {(row: HTMLElement) => string} [options.getKey] How a row names its key; the key of the row's own attribute by default.
 * @param {(row: HTMLElement) => string} [options.rowLabel] The accessible name of a row's check; a row that has no name of its own gives it.
 * @param {(row: HTMLElement) => HTMLElement|null} [options.focusTarget]
 */
function createSharedPage({ conversationId, nav, className, title, pick, createList, rowSelector, keyOf, renderItem, empty, actions, gestures = false, getKey, rowLabel, focusTarget }) {
    requireView(conversationId);
    const { page, clamp } = createPage(className);
    const body = el('div', 'sb-details-shared');
    clamp.append(body);
    let keys = '';
    let stopped = false;
    let loadToken = 0;
    let loadingChatId = '';
    let currentChatId = '';
    let loadingPage = null;
    let current = [];

    const list = createList();
    const byKey = new Map();
    const bulk = createBulkSelection({
        getList: () => list,
        rowSelector,
        getKey: getKey ?? (row => row.dataset.sbListKey),
        rowLabel,
        getAllKeys: () => current.map(keyOf),
        gestures,
        actions: actions(selected => selected.map(key => byKey.get(key)).filter(Boolean)),
    });
    const batched = createBatchedList({ list, renderRow: item => renderItem(item, bulk), onDrawn: () => bulk.sync(), focusTarget });

    const releaseLoading = () => {
        loadingPage?.release();
        loadingPage = null;
    };

    const address = () => {
        const view = conversationData.get(conversationId);
        return view?.activeChatId ? { conversationId, chatId: view.activeChatId } : null;
    };

    const paint = (items) => {
        current = items;
        byKey.clear();
        for (const item of items) {
            byKey.set(keyOf(item), item);
        }
        bulk.setSelectable(items.length > 0);
        if (!items.length) {
            body.replaceChildren(createStatusPage({ state: 'empty', icon: empty.icon, title: empty.title, compact: true }).element);
            return;
        }
        if (list.parentNode !== body) {
            body.replaceChildren(list, batched.element);
        }
        batched.update(items);
    };

    const render = () => {
        if (stopped) {
            return;
        }
        const where = address();
        if (!where) {
            loadToken += 1;
            loadingChatId = '';
            currentChatId = '';
            keys = '';
            releaseLoading();
            body.replaceChildren();
            current = [];
            bulk.setSelectable(false);
            return;
        }
        const loaded = conversationData.chat(where);
        if (!loaded) {
            if (loadingChatId === where.chatId) {
                return;
            }
            const token = ++loadToken;
            loadingChatId = where.chatId;
            currentChatId = where.chatId;
            keys = '';
            releaseLoading();
            current = [];
            bulk.setSelectable(false);
            loadingPage = createStatusPage({ state: 'loading', title: 'Loading', compact: true });
            body.replaceChildren(loadingPage.element);
            conversationData.loadChat(where).then(() => {
                if (stopped || token !== loadToken) {
                    return;
                }
                loadingChatId = '';
                render();
            }, () => {
                if (stopped || token !== loadToken) {
                    return;
                }
                loadingChatId = '';
                releaseLoading();
                body.replaceChildren(createStatusPage({ state: 'error', title: 'Could Not Load the Chat', compact: true }).element);
            });
            return;
        }
        loadToken += 1;
        loadingChatId = '';
        const items = pick(collectSharedItems(loaded.messages));
        const next = JSON.stringify([where.chatId, items.map(item => [item.key, item.text ?? ''])]);
        if (next === keys && currentChatId === where.chatId) {
            return;
        }
        currentChatId = where.chatId;
        keys = next;
        releaseLoading();
        redrawKeepingFocus(body, () => paint(items));
    };

    render();
    const stop = conversationData.subscribe((event) => {
        if ((event.type === 'chat' && event.address?.conversationId === conversationId) || (event.type === 'list' && (!event.id || event.id === conversationId))) {
            if (!conversationData.get(conversationId)) {
                nav.gone();
                return;
            }
            render();
        }
    });
    return {
        title,
        content: page,
        canClose: reason => bulk.canClose(reason),
        leaveSelection: () => bulk.exit(),
        onMount(context) {
            bulk.mount(context);
            bulk.setSelectable(current.length > 0);
        },
        dispose() {
            stopped = true;
            loadToken += 1;
            releaseLoading();
            stop();
            batched.destroy();
            bulk.destroy();
        },
    };
}

function openInChat(nav, conversationId, item) {
    return async () => {
        const view = conversationData.get(conversationId);
        if (!view) {
            nav.gone();
            return;
        }
        const chatId = view.activeChatId;
        await nav.close();
        await showMessageInTimeline(view, chatId, item.messageId);
    };
}

const SELECT_ITEM = ['Select', 'check-double'];

export function buildMedia({ conversationId, nav }) {
    const removeItems = item => removeAttachmentsFromChat(conversationId, [item.key], 'item');
    return createSharedPage({
        conversationId,
        nav,
        className: 'sb-details-page--media',
        title: getPageTitle('media'),
        pick: shared => shared.media,
        empty: { icon: 'image', title: 'No Media' },
        rowSelector: '.sb-details-media-item',
        getKey: row => row.dataset.sbSelectKey,
        rowLabel: row => row.querySelector('.sb-details-media-cell')?.getAttribute('aria-label') ?? '',
        keyOf: item => item.key,
        // A cell is a button and a button cannot hold a check, so the selectable box is the item that holds the cell.
        focusTarget: row => row?.querySelector('.sb-details-media-cell') ?? null,
        // A cell has no menu, so a secondary click or a long press selects it (DESIGN.md, Selection Mode, Entering).
        gestures: true,
        createList() {
            const grid = el('div', 'sb-details-media-grid');
            grid.setAttribute('role', 'list');
            grid.setAttribute('aria-label', 'Media');
            return grid;
        },
        renderItem(item, bulk) {
            const label = `${item.kind === 'video' ? 'Video' : 'Picture'} by ${describeSender(item)}, ${formatWhen(item.createdAt)}`;
            const entry = el('div', 'sb-details-media-item');
            entry.setAttribute('role', 'listitem');
            entry.dataset.sbSelectKey = item.key;
            const cell = el('button', 'sb-details-media-cell');
            cell.type = 'button';
            cell.dataset.sbListKey = item.key;
            cell.title = label;
            cell.setAttribute('aria-label', label);
            if (item.kind === 'image') {
                cell.append(createLazyImage(item.url));
            } else {
                cell.classList.add('sb-details-media-cell--video');
                cell.append(icon('play'));
            }
            cell.addEventListener('click', () => nav.viewPicture({
                title: item.title || label,
                src: item.url,
                kind: item.kind,
                alt: label,
                onRemove: () => removeItems(item),
            }));
            // The check that shows over a cell on hover. A touch screen has the long press and the Select button of the header.
            const check = el('button', 'sb-details-media-check');
            check.type = 'button';
            check.tabIndex = -1;
            check.title = 'Select';
            check.setAttribute('aria-label', `Select ${label}`);
            check.append(icon('check'));
            check.addEventListener('click', () => bulk.enter(item.key, check));
            entry.append(cell, check);
            return entry;
        },
        actions: itemsOf => [
            { id: 'download', label: 'Download', icon: 'fa-solid fa-download', run: keys => downloadAttachmentsArchive(requireView(conversationId), itemsOf(keys), 'Media') },
            { id: 'remove', label: 'Remove From Chat', icon: 'fa-solid fa-trash-can', danger: true, run: keys => removeAttachmentsFromChat(conversationId, itemsOf(keys).map(item => item.key), 'item') },
        ],
    });
}

function downloadFile(item) {
    const safeUrl = toSafeAttachmentUrl(item?.url);
    if (!safeUrl) {
        return false;
    }
    const link = el('a');
    link.href = safeUrl;
    link.download = item.name || '';
    link.rel = 'noopener noreferrer';
    document.body.append(link);
    link.click();
    link.remove();
    return true;
}

export function buildFiles({ conversationId, nav }) {
    return createSharedPage({
        conversationId,
        nav,
        className: 'sb-details-page--files',
        title: getPageTitle('files'),
        pick: shared => shared.files,
        empty: { icon: 'file', title: 'No Files' },
        rowSelector: '.sb-details-collection-row',
        keyOf: item => `file:${item.key}`,
        createList: () => createCollection('Files'),
        renderItem(item, bulk) {
            const glyph = el('span', 'sb-details-file-icon');
            glyph.append(icon(item.kind === 'audio' ? 'file-audio' : 'file-lines'));
            const name = item.name || (item.kind === 'audio' ? 'Audio' : 'File');
            const built = createCollectionRow({
                key: `file:${item.key}`,
                label: name,
                avatar: glyph,
                subtitle: [formatFileSize(item.size), describeSender(item), formatWhen(item.createdAt)].filter(Boolean).join(' · '),
                onActivate: () => downloadFile(item),
                menu: {
                    label: `Actions for ${name}`,
                    sections: () => [
                        { items: [
                            createMenuItem('Download', 'download', () => downloadFile(item)),
                            createMenuItem('Show in Chat', 'arrow-up-right-from-square', openInChat(nav, conversationId, item)),
                            createMenuItem(...SELECT_ITEM, () => bulk.enter(`file:${item.key}`, built.menuButton)),
                        ] },
                        { items: [createMenuItem('Remove From Chat', 'trash-can', () => void removeAttachmentsFromChat(conversationId, [item.key], 'file'), true)] },
                    ],
                },
            });
            return built.row;
        },
        actions: itemsOf => [
            { id: 'download', label: 'Download', icon: 'fa-solid fa-download', run: keys => downloadAttachmentsArchive(requireView(conversationId), itemsOf(keys), 'Files') },
            { id: 'remove', label: 'Remove From Chat', icon: 'fa-solid fa-trash-can', danger: true, run: keys => removeAttachmentsFromChat(conversationId, itemsOf(keys).map(item => item.key), 'file') },
        ],
    });
}

/**
 * Sets the pin of messages of a loaded chat in one commit. The timeline is drawn again when the conversation is open on screen.
 * @param {string[]} messageIds
 * @param {{ chatId?: string, at?: Map<string, number> }} [options] The chat, and the time of the pin that an undo gives back for each message; not given, the active chat and now.
 * @returns {Map<string, { pinned: boolean, at: number }>|null} What each message had before, or null when the conversation or the chat is gone.
 */
function setPins(conversationId, messageIds, pinned, { chatId = '', at = new Map() } = {}) {
    const view = conversationData.get(conversationId);
    const targetChatId = chatId || view?.activeChatId;
    if (!view || !targetChatId) {
        return null;
    }
    const address = { conversationId, chatId: targetChatId };
    if (!conversationData.chat(address)) {
        return null;
    }
    const before = new Map();
    conversationData.commitChat(address, (chat) => {
        for (const messageId of messageIds) {
            const message = chat.messages.find(item => item.id === messageId);
            if (message) {
                before.set(messageId, setMessagePin(message, pinned, at.has(messageId) ? { at: at.get(messageId) } : {}));
            }
        }
    });
    scheduleTimelineRender();
    return before;
}

/**
 * Unpins messages of the open chat with one Undo for all of them.
 * @returns {boolean} Whether any message was pinned.
 */
function unpinMessages(conversationId, messageIds) {
    const chatId = conversationData.get(conversationId)?.activeChatId;
    if (!chatId) {
        return false;
    }
    const before = setPins(conversationId, messageIds, false, { chatId });
    const wasPinned = before ? [...before].filter(([, state]) => state.pinned) : [];
    if (!wasPinned.length) {
        return false;
    }
    showUndoToast(wasPinned.length === 1 ? 'Message unpinned' : `${wasPinned.length} messages unpinned`, async () => {
        const view = conversationData.get(conversationId);
        if (!view || (Array.isArray(view.chats) && !view.chats.some(chat => chat.id === chatId))) {
            return;
        }
        const address = { conversationId, chatId };
        if (!conversationData.chat(address)) {
            try {
                await conversationData.loadChat(address);
            } catch {
                return;
            }
        }
        setPins(conversationId, wasPinned.map(([messageId]) => messageId), true, { chatId, at: new Map(wasPinned.map(([messageId, state]) => [messageId, state.at])) });
    });
    return true;
}

export function buildPinned({ conversationId, nav }) {
    return createSharedPage({
        conversationId,
        nav,
        className: 'sb-details-page--pinned',
        title: getPageTitle('pinned'),
        pick: shared => shared.pinned,
        empty: { icon: 'thumbtack', title: 'No Pinned Messages' },
        rowSelector: '.sb-details-collection-row',
        keyOf: item => `pin:${item.key}`,
        createList: () => createCollection('Pinned Messages'),
        renderItem(item, bulk) {
            const sender = describeSender(item);
            const picture = item.memberAvatar
                ? createCharacterAvatar(item.memberAvatar, { size: 36 })
                : createAvatar({ name: sender, size: 36 });
            const built = createCollectionRow({
                key: `pin:${item.key}`,
                label: sender,
                avatar: picture,
                subtitle: formatWhen(item.createdAt),
                preview: item.text,
                onActivate: openInChat(nav, conversationId, item),
                menu: {
                    label: `Pinned Message Actions for ${sender}`,
                    sections: () => [
                        { items: [
                            createMenuItem('Show in Chat', 'arrow-up-right-from-square', openInChat(nav, conversationId, item)),
                            createMenuItem(...SELECT_ITEM, () => bulk.enter(`pin:${item.key}`, built.menuButton)),
                        ] },
                        { items: [createMenuItem('Unpin', 'thumbtack-slash', () => void unpinMessages(conversationId, [item.messageId]))] },
                    ],
                },
            });
            return built.row;
        },
        actions: itemsOf => [
            { id: 'unpin', label: 'Unpin', icon: 'fa-solid fa-thumbtack-slash', run: keys => unpinMessages(conversationId, itemsOf(keys).map(item => item.messageId)) },
        ],
    });
}
