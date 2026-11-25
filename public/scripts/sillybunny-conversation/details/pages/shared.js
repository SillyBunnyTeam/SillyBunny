/**
 * Media, Files and Pinned: what the open chat of the conversation shares. These pages replace the filter tabs of the
 * timeline. Each draws from the loaded messages of the active chat and redraws when that chat changes.
 */

import { createStatusPage } from '../../../sillybunny-editor/status-page.js';
import { conversationData, getCardName, requireView } from '../access.js';
import { showMessageInTimeline } from '../actions.js';
import { createCharacterAvatar, createAvatar } from '../avatars.js';
import { collectSharedItems, formatFileSize, formatWhen, getPageTitle } from '../details-logic.js';
import { createCollection, createCollectionRow, createMenuItem, createPage, el, icon, redrawKeepingFocus, showUndoToast } from '../page-kit.js';
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

    const address = () => {
        const view = conversationData.get(conversationId);
        return view?.activeChatId ? { conversationId, chatId: view.activeChatId } : null;
    };
    const render = () => {
        if (stopped) {
            return;
        }
        const loaded = conversationData.chat(address());
        if (!loaded) {
            return;
        }
        const shared = collectSharedItems(loaded.messages);
        const items = pick(shared);
        const next = JSON.stringify(items.map(item => [item.key, item.text ?? '']));
        if (next === keys) {
            return;
        }
        keys = next;
        redrawKeepingFocus(body, () => draw(body, items, { nav, conversationId }));
    };

    const loading = createStatusPage({ state: 'loading', title: 'Loading', compact: true });
    body.append(loading.element);
    const where = address();
    if (where && !conversationData.chat(where)) {
        conversationData.loadChat(where).then(render, () => {
            body.replaceChildren(createStatusPage({ state: 'error', title: 'Could Not Load the Chat', compact: true }).element);
        });
    } else {
        render();
    }
    const stop = conversationData.subscribe((event) => {
        if ((event.type === 'chat' && event.address?.conversationId === conversationId) || (event.type === 'list' && (!event.id || event.id === conversationId))) {
            if (!conversationData.get(conversationId)) {
                nav.gone();
                return;
            }
            render();
        }
    });
    return { title, content: page, dispose() { stopped = true; stop(); } };
}

function openInChat(nav, conversationId, item) {
    return async () => {
        const view = requireView(conversationId);
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
                    const image = el('img');
                    image.alt = '';
                    image.src = item.url;
                    image.loading = 'lazy';
                    image.decoding = 'async';
                    cell.append(image);
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
    const link = el('a');
    link.href = item.url;
    link.download = item.name || '';
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
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

/** Sets the pin of a message of the open chat. The timeline is drawn again when the conversation is open on screen. */
function setPinned(conversationId, messageId, pinned) {
    const view = requireView(conversationId);
    const address = { conversationId, chatId: view.activeChatId };
    conversationData.commitChat(address, (chat) => {
        const message = chat.messages.find(item => item.id === messageId);
        if (message) {
            message.extra = { ...message.extra, conversation_pinned: pinned };
        }
    });
    scheduleTimelineRender();
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
                                setPinned(conversationId, item.messageId, false);
                                showUndoToast('Message unpinned', () => setPinned(conversationId, item.messageId, true));
                            })] },
                        ],
                    },
                }).row);
            }
            body.replaceChildren(list);
        },
    });
}
