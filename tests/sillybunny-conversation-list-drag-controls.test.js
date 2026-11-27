/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const openActionMenu = jest.fn();
const setConversationFavorite = jest.fn(() => true);
const setConversationFolder = jest.fn(() => true);
const setConversationMuted = jest.fn();
const markConversationUnread = jest.fn();
const markConversationRead = jest.fn();
const announceInList = jest.fn();
const highlightMovedRow = jest.fn();
const openFolderMenu = jest.fn();
const openMoveMenu = jest.fn();

await jest.unstable_mockModule('../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu }));
await jest.unstable_mockModule('../public/scripts/sillybunny-editor/list-rows.js', () => ({ bindListKeyboard: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-data-browser.js', () => ({
    conversationData: { get: jest.fn() },
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list-actions.js', () => ({
    markConversationUnread,
    setConversationFavorite,
    setConversationFolder,
    setConversationMuted,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list-view.js', () => ({
    announceInList,
    clearTemporaryOpen: jest.fn(() => false),
    findRow: jest.fn(() => null),
    getRowControl: row => row.querySelector('.sb-conversation-list-item'),
    getTemporaryOpenKeys: jest.fn(() => []),
    highlightMovedRow,
    setTemporaryOpen: jest.fn(() => false),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/conversation-list-folders.js', () => ({
    createListFolderActions: () => ({ openFolderMenu, openMoveMenu }),
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/notifications.js', () => ({
    markConversationRead,
}));

const { bindRowDrag } = await import('../public/scripts/sillybunny-conversation/conversation-list-drag.js');
const { bindConversationListControls } = await import('../public/scripts/sillybunny-conversation/conversation-list-controls.js');

function pointerEvent(type, { pointerType = 'touch', pointerId = 1, isPrimary = true, button = 0, clientX = 20, clientY = 20 } = {}) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        pointerType: { value: pointerType },
        pointerId: { value: pointerId },
        isPrimary: { value: isPrimary },
        button: { value: button },
        clientX: { value: clientX },
        clientY: { value: clientY },
    });
    return event;
}

describe('conversation-list-drag regressions', () => {
    let cleanups;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        document.body.replaceChildren();
        cleanups = [];
    });

    afterEach(() => {
        for (const cleanup of cleanups.reverse()) {
            cleanup();
        }
        jest.useRealTimers();
        jest.restoreAllMocks();
        document.body.replaceChildren();
    });

    function buildList({ canDrag = () => false } = {}) {
        const list = document.createElement('div');
        const section = document.createElement('section');
        section.className = 'sb-conversation-list-section';
        section.dataset.section = 'conversations';
        const heading = document.createElement('button');
        heading.className = 'sb-conversation-list-heading-button';
        const row = document.createElement('div');
        row.className = 'sb-conversation-list-row';
        row.dataset.conversationId = 'conv-1';
        section.append(heading, row);
        list.append(section);
        document.body.append(list);

        const callbacks = {
            onDrop: jest.fn(),
            onMenu: jest.fn(),
            onMenuOnly: jest.fn(),
            onHoldOver: jest.fn(),
            onDragEnd: jest.fn(),
            announce: jest.fn(),
        };
        const unbind = bindRowDrag(list, {
            rowSelector: '.sb-conversation-list-row',
            sectionSelector: '.sb-conversation-list-section',
            canDrag,
            getSectionOfRow: node => node.closest('.sb-conversation-list-section')?.dataset.section ?? '',
            menuOnlySelector: '.sb-conversation-list-heading-button',
            ...callbacks,
        });
        cleanups.push(unbind);
        return { list, section, heading, row, ...callbacks };
    }

    test('touch long-press opens the row menu while searching without enabling drag', () => {
        const { row, onMenu, onMenuOnly, onDrop, announce } = buildList({ canDrag: () => false });

        row.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 25, clientY: 30 }));
        jest.advanceTimersByTime(400);
        expect(row.classList.contains('is-lifted')).toBe(true);

        window.dispatchEvent(pointerEvent('pointerup', { pointerType: 'touch', clientX: 25, clientY: 30 }));
        expect(onMenu).toHaveBeenCalledWith(row, { x: 25, y: 30 });
        expect(onMenuOnly).not.toHaveBeenCalled();
        expect(onDrop).not.toHaveBeenCalled();
        expect(announce).not.toHaveBeenCalled();
    });

    test('moving after touch lift while searching aborts instead of dragging', () => {
        const { list, row, onMenu, onDrop } = buildList({ canDrag: () => false });

        row.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'touch', clientX: 20, clientY: 20 }));
        jest.advanceTimersByTime(400);
        expect(row.classList.contains('is-lifted')).toBe(true);

        window.dispatchEvent(pointerEvent('pointermove', { pointerType: 'touch', clientX: 40, clientY: 20 }));
        expect(row.classList.contains('is-lifted')).toBe(false);
        expect(list.dataset.dragging).toBeUndefined();
        window.dispatchEvent(pointerEvent('pointerup', { pointerType: 'touch', clientX: 40, clientY: 20 }));
        expect(onMenu).not.toHaveBeenCalled();
        expect(onDrop).not.toHaveBeenCalled();
    });

    test('mouse pointerdown while searching does not start a drag or menu gesture', () => {
        const { row, onMenu, onDrop } = buildList({ canDrag: () => false });

        row.dispatchEvent(pointerEvent('pointerdown', { pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 }));
        window.dispatchEvent(pointerEvent('pointermove', { pointerType: 'mouse', clientX: 40, clientY: 10 }));
        window.dispatchEvent(pointerEvent('pointerup', { pointerType: 'mouse', clientX: 40, clientY: 10 }));
        expect(onMenu).not.toHaveBeenCalled();
        expect(onDrop).not.toHaveBeenCalled();
    });

    test('registers non-passive touchmove on the list rather than document', () => {
        const docAddSpy = jest.spyOn(document, 'addEventListener');
        const list = document.createElement('div');
        const listAddSpy = jest.spyOn(list, 'addEventListener');
        const listRemoveSpy = jest.spyOn(list, 'removeEventListener');
        document.body.append(list);

        const unbind = bindRowDrag(list, {
            rowSelector: '.row',
            sectionSelector: '.section',
            canDrag: () => true,
            getSectionOfRow: () => 'conversations',
            onDrop: jest.fn(),
            onMenu: jest.fn(),
            onHoldOver: jest.fn(),
            onDragEnd: jest.fn(),
            announce: jest.fn(),
        });

        expect(docAddSpy).not.toHaveBeenCalledWith('touchmove', expect.any(Function), expect.anything());
        expect(listAddSpy).toHaveBeenCalledWith('touchmove', expect.any(Function), { passive: false });

        unbind();
        expect(listRemoveSpy).toHaveBeenCalledWith('touchmove', expect.any(Function));
    });
});

describe('conversation-list-controls favorite section expansion', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        document.body.replaceChildren();
    });

    function mountControls({ entries, layout }) {
        const list = document.createElement('div');
        for (const entry of entries) {
            const row = document.createElement('div');
            row.className = 'sb-conversation-list-row';
            row.dataset.conversationId = entry.id;
            const item = document.createElement('button');
            item.className = 'sb-conversation-list-item';
            row.append(item);
            list.append(row);
        }
        document.body.append(list);

        const folders = {
            layout: jest.fn(() => layout),
            setFavoritesExpanded: jest.fn(),
            updateFolder: jest.fn(),
        };
        const render = jest.fn();

        bindConversationListControls(list, {
            getEntries: () => entries,
            runAction: jest.fn(),
            openDetails: jest.fn(),
            render,
            folders,
            getPersonaId: () => 'persona-1',
        });

        return { list, folders, render };
    }

    test('expands a collapsed Favorites section when favoriting a conversation', () => {
        const entry = { id: 'conv-1', name: 'Ada', favorite: false, folderId: '', muted: false, unread: 0, lastMessageRole: 'character', active: false, avatar: 'ada.png', groupId: '' };
        const { list, folders, render } = mountControls({
            entries: [entry],
            layout: { favoritesExpanded: false, folders: [] },
        });

        list.querySelector('.sb-conversation-list-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
        const menuItems = openActionMenu.mock.calls[0][0].sections.flatMap(section => section.items ?? []);
        const favoriteItem = menuItems.find(item => item.label === 'Add to Favorites');
        favoriteItem.onSelect();

        expect(folders.setFavoritesExpanded).toHaveBeenCalledWith('persona-1', true);
        expect(render).toHaveBeenCalledTimes(1);
    });

    test('expands a collapsed destination folder when unfavoriting a conversation that belongs to it', () => {
        const entry = { id: 'conv-2', name: 'Grace', favorite: true, folderId: 'folder-work', muted: false, unread: 0, lastMessageRole: 'character', active: false, avatar: 'grace.png', groupId: '' };
        const { list, folders, render } = mountControls({
            entries: [entry],
            layout: { favoritesExpanded: true, folders: [{ id: 'folder-work', name: 'Work', color: '', expanded: false }] },
        });

        list.querySelector('.sb-conversation-list-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
        const menuItems = openActionMenu.mock.calls[0][0].sections.flatMap(section => section.items ?? []);
        const unfavoriteItem = menuItems.find(item => item.label === 'Remove From Favorites');
        unfavoriteItem.onSelect();

        expect(folders.updateFolder).toHaveBeenCalledWith('persona-1', 'folder-work', { expanded: true });
        expect(render).toHaveBeenCalledTimes(1);
    });
});
