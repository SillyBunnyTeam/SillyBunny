/**
 * Media, Files and Pinned: what the open chat of the conversation shares. These pages replace the filter tabs of the
 * timeline. Each draws from the loaded messages of the active chat and redraws when that chat changes.
 */

import { createLazyImage } from '../../../sillybunny-editor/lazy-image.js';
import { createStatusPage } from '../../../sillybunny-editor/status-page.js';
import { conversationData, getCardName, requireView } from '../access.js';
import { showMessageInTimeline } from '../actions.js';
import { createCharacterAvatar, createAvatar } from '../avatars.js';
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
 * The shell of the three pages. `draw(body, shared)` fills the page from what the chat shares, and runs again when the
 * keys of the items it lists change.
 */
function createSharedPage({ conversationId, nav, className, title, pick, draw }) {
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

    const releaseLoading = () => {
        loadingPage?.release();
        loadingPage = null;
    };

    const address = () => {
        const view = conversationData.get(conversationId);
        return view?.activeChatId ? { conversationId, chatId: view.activeChatId } : null;
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
        const shared = collectSharedItems(loaded.messages);
        const items = pick(shared);
        const next = JSON.stringify([where.chatId, items.map(item => [item.key, item.text ?? ''])]);
        if (next === keys && currentChatId === where.chatId) {
            return;
        }
        currentChatId = where.chatId;
        keys = next;
        releaseLoading();
        redrawKeepingFocus(body, () => draw(body, items, { nav, conversationId }));
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
        dispose() {
            stopped = true;
            loadToken += 1;
            releaseLoading();
            stop();
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

function emptyPage(iconName, title) {
    return createStatusPage({ state: 'empty', icon: iconName, title, compact: true }).element;
}

export function buildMedia({ conversationId, nav }) {
    return createSharedPage({
        conversationId,
        nav,
        className: 'sb-details-page--media',
        title: getPageTitle('media'),
        pick: shared => shared.media,
        draw(body, items) {
            if (!items.length) {
                body.replaceChildren(emptyPage('image', 'No Media'));
                return;
            }
            const grid = el('div', 'sb-details-media-grid');
            grid.setAttribute('role', 'list');
            grid.setAttribute('aria-label', 'Media');
            for (const item of items) {
                const label = `${item.kind === 'video' ? 'Video' : 'Picture'} by ${describeSender(item)}, ${formatWhen(item.createdAt)}`;
                const entry = el('div', 'sb-details-media-item');
                entry.setAttribute('role', 'listitem');
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
                cell.addEventListener('click', () => nav.viewPicture({ title: item.title || label, src: item.url, kind: item.kind, alt: label }));
                entry.append(cell);
                grid.append(entry);
            }
            body.replaceChildren(grid);
        },
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
        draw(body, items) {
            if (!items.length) {
                body.replaceChildren(emptyPage('file', 'No Files'));
                return;
            }
            const list = createCollection('Files');
            for (const item of items) {
                const glyph = el('span', 'sb-details-file-icon');
                glyph.append(icon(item.kind === 'audio' ? 'file-audio' : 'file-lines'));
                const name = item.name || (item.kind === 'audio' ? 'Audio' : 'File');
                list.append(createCollectionRow({
                    key: `file:${item.key}`,
                    label: name,
                    avatar: glyph,
                    subtitle: [formatFileSize(item.size), describeSender(item), formatWhen(item.createdAt)].filter(Boolean).join(' · '),
                    onActivate: () => downloadFile(item),
                    menu: {
                        label: `Actions for ${name}`,
                        sections: () => [{ items: [
                            createMenuItem('Download', 'download', () => downloadFile(item)),
                            createMenuItem('Show in Chat', 'arrow-up-right-from-square', openInChat(nav, conversationId, item)),
                        ] }],
                    },
                }).row);
            }
            body.replaceChildren(list);
        },
    });
}

/**
 * Sets the pin of a message of a loaded chat. The timeline is drawn again when the conversation is open on screen.
 * @param {{ chatId?: string, at?: number }} [options] The chat and the time of the pin, which an undo gives back; not given, it uses the active chat and now.
 * @returns {{ pinned: boolean, at: number }|null} The pin that the message had, or null when the conversation or chat is gone.
 */
function setPinned(conversationId, messageId, pinned, { chatId = '', ...options } = {}) {
    const view = conversationData.get(conversationId);
    if (!view) {
        return null;
    }
    const targetChatId = chatId || view.activeChatId;
    if (!targetChatId) {
        return null;
    }
    const address = { conversationId, chatId: targetChatId };
    if (!conversationData.chat(address)) {
        return null;
    }
    let before = { pinned: false, at: 0 };
    conversationData.commitChat(address, (chat) => {
        before = setMessagePin(chat.messages.find(item => item.id === messageId), pinned, options);
    });
    scheduleTimelineRender();
    return before;
}

export function buildPinned({ conversationId, nav }) {
    return createSharedPage({
        conversationId,
        nav,
        className: 'sb-details-page--pinned',
        title: getPageTitle('pinned'),
        pick: shared => shared.pinned,
        draw(body, items) {
            if (!items.length) {
                body.replaceChildren(emptyPage('thumbtack', 'No Pinned Messages'));
                return;
            }
            const list = createCollection('Pinned Messages');
            for (const item of items) {
                const sender = describeSender(item);
                const picture = item.memberAvatar
                    ? createCharacterAvatar(item.memberAvatar, { size: 36 })
                    : createAvatar({ name: sender, size: 36 });
                list.append(createCollectionRow({
                    key: `pin:${item.key}`,
                    label: sender,
                    avatar: picture,
                    subtitle: formatWhen(item.createdAt),
                    preview: item.text,
                    onActivate: openInChat(nav, conversationId, item),
                    menu: {
                        label: `Pinned Message Actions for ${sender}`,
                        sections: () => [
                            { items: [createMenuItem('Show in Chat', 'arrow-up-right-from-square', openInChat(nav, conversationId, item))] },
                            { items: [createMenuItem('Unpin', 'thumbtack-slash', () => {
                                const chatId = conversationData.get(conversationId)?.activeChatId;
                                if (!chatId) {
                                    return;
                                }
                                const before = setPinned(conversationId, item.messageId, false, { chatId });
                                if (!before) {
                                    return;
                                }
                                showUndoToast('Message unpinned', async () => {
                                    const current = conversationData.get(conversationId);
                                    if (!current || (Array.isArray(current.chats) && !current.chats.some(chat => chat.id === chatId))) {
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
                                    setPinned(conversationId, item.messageId, true, { chatId, at: before.at });
                                });
                            })] },
                        ],
                    },
                }).row);
            }
            body.replaceChildren(list);
        },
    });
}
