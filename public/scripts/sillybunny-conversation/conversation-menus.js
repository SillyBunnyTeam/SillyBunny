/**
 * The sections of the menus of the conversation surfaces (the list, the header and the composer), as `openActionMenu`
 * takes them. Each builder only decides which items there are and what they say; the page gives it the actions, so that
 * tests read the result as it is.
 */

import { getReadToggle } from './conversation-list-model.js';

/**
 * The context menu of a row: right-click, long press, Shift+F10 and the Menu key. An item that does not apply is left out.
 * @param {import('./conversation-list-model.js').ListEntry} entry
 * @param {object} actions Each is called with the entry (`setFavorite` and `setMuted` with the new state after it).
 */
export function buildRowMenuSections(entry, actions) {
    const readToggle = getReadToggle(entry);
    const readItems = readToggle === 'read'
        ? [{ label: 'Mark as Read', icon: 'fa-solid fa-envelope-open', onSelect: () => actions.markRead(entry) }]
        : readToggle === 'unread'
            ? [{ label: 'Mark as Unread', icon: 'fa-solid fa-envelope', onSelect: () => actions.markUnread(entry) }]
            : [];
    return [
        ...(readItems.length ? [{ items: readItems }] : []),
        {
            items: [
                entry.favorite
                    ? { label: 'Remove From Favorites', icon: 'fa-regular fa-star', onSelect: () => actions.setFavorite(entry, false) }
                    : { label: 'Add to Favorites', icon: 'fa-solid fa-star', onSelect: () => actions.setFavorite(entry, true) },
                { label: 'Move to Folder…', icon: 'fa-solid fa-folder', onSelect: () => actions.moveToFolder(entry) },
                entry.muted
                    ? { label: 'Unmute', icon: 'fa-solid fa-bell', onSelect: () => actions.setMuted(entry, false) }
                    : { label: 'Mute', icon: 'fa-solid fa-bell-slash', onSelect: () => actions.setMuted(entry, true) },
            ],
        },
        { items: [{ label: 'Details', icon: 'fa-solid fa-circle-info', onSelect: () => actions.openDetails(entry) }] },
        { items: [{ label: 'Delete', icon: 'fa-solid fa-trash-can', danger: true, onSelect: () => actions.remove(entry) }] },
    ];
}

/**
 * The menu that "Move to Folder" opens: a radio choice of No Folder and each folder of the persona, with the one that holds
 * the row checked, then New Folder. A favourite shows its stored folder, which is where it returns, because the choice
 * changes the folder only.
 * @param {import('./conversation-list-model.js').ListEntry} entry
 * @param {{ id: string, name: string }[]} folders In their stored order.
 * @param {{ setFolder: (folderId: string) => void, newFolder: () => void }} actions `setFolder` gets an empty string for No Folder.
 */
export function buildMoveToFolderSections(entry, folders, { setFolder, newFolder }) {
    return [
        {
            items: [
                { label: 'No Folder', kind: 'radio', checked: !entry.folderId, onSelect: () => setFolder('') },
                ...folders.map(folder => ({ label: folder.name, kind: 'radio', checked: entry.folderId === folder.id, onSelect: () => setFolder(folder.id) })),
            ],
        },
        { items: [{ label: 'New Folder…', icon: 'fa-solid fa-folder-plus', onSelect: newFolder }] },
    ];
}

/**
 * The context menu of the heading of a folder: right-click, long press, Shift+F10 and the Menu key. The folders are ordered
 * in the Folder Manager, so there is no Move Up or Move Down here.
 * @param {{ id: string, name: string }} folder
 * @param {{ rename: Function, colour: Function, remove: Function }} actions Each is called with the folder.
 */
export function buildFolderMenuSections(folder, actions) {
    return [
        {
            items: [
                { label: 'Rename', icon: 'fa-solid fa-pen', onSelect: () => actions.rename(folder) },
                { label: 'Colour', icon: 'fa-solid fa-palette', onSelect: () => actions.colour(folder) },
            ],
        },
        { items: [{ label: 'Delete', icon: 'fa-solid fa-trash-can', danger: true, onSelect: () => actions.remove(folder) }] },
    ];
}

/** The New button's menu: the two ways to start a conversation, and New Folder in a group of its own. */
export function buildNewMenuSections({ newConversation, newGroup, newFolder }) {
    return [
        {
            items: [
                { label: 'New Conversation', icon: 'fa-solid fa-user-plus', onSelect: newConversation },
                { label: 'New Group', icon: 'fa-solid fa-user-group', onSelect: newGroup },
            ],
        },
        { items: [{ label: 'New Folder…', icon: 'fa-solid fa-folder-plus', onSelect: newFolder }] },
    ];
}

/**
 * The primary menu of the list's header bar (HIG Menus): what the whole list can do, then the standard items of an
 * application that has them as the last group.
 */
export function buildMainMenuSections({ markAllRead, manageFolders, openPreferences, openHelp }) {
    return [
        {
            items: [
                { label: 'Mark All as Read', icon: 'fa-solid fa-check-double', onSelect: markAllRead },
                { label: 'Manage Folders', icon: 'fa-solid fa-folder', onSelect: manageFolders },
            ],
        },
        {
            items: [
                { label: 'Preferences', icon: 'fa-solid fa-sliders', onSelect: openPreferences },
                { label: 'Help', icon: 'fa-solid fa-circle-question', onSelect: openHelp },
            ],
        },
    ];
}

/**
 * The menu of the conversation header (HIG Menus, a secondary menu for the item that the view shows). An item that does
 * not apply is left out, and the deletes sit last in a section of their own.
 * @param {{ muted: boolean, hasMessages: boolean, hasChat: boolean, hasPinned?: boolean }} state `hasPinned`: the open chat has a pinned message, which is what Pinned Messages lists.
 * @param {object} actions `setMuted` is called with the state that the item sets; the others with no argument.
 */
export function buildHeaderMenuSections({ muted, hasMessages, hasChat, hasPinned = false }, actions) {
    const toggles = [
        muted
            ? { label: 'Unmute', icon: 'fa-solid fa-bell', onSelect: () => actions.setMuted(false) }
            : { label: 'Mute', icon: 'fa-solid fa-bell-slash', onSelect: () => actions.setMuted(true) },
        ...(hasMessages ? [{ label: 'Select Messages', icon: 'fa-solid fa-square-check', onSelect: actions.selectMessages }] : []),
    ];
    return [
        {
            items: [
                { label: 'Details', icon: 'fa-solid fa-circle-info', onSelect: actions.openDetails },
                ...(hasPinned ? [{ label: 'Pinned Messages', icon: 'fa-solid fa-thumbtack', onSelect: actions.openPinned }] : []),
                { label: 'New Chat', icon: 'fa-solid fa-message', onSelect: actions.newChat },
                { label: 'Add Member', icon: 'fa-solid fa-user-plus', onSelect: actions.addMember },
            ],
        },
        { items: toggles },
        {
            items: [
                ...(hasChat ? [{ label: 'Delete Chat', icon: 'fa-solid fa-trash-can', danger: true, onSelect: actions.deleteChat }] : []),
                { label: 'Delete Conversation', icon: 'fa-solid fa-trash-can', danger: true, onSelect: actions.deleteConversation },
            ],
        },
    ];
}

/**
 * The "+" menu of the composer: what the user can add to the conversation besides a message. Attach is a button of its
 * own beside the field, so it is not here. Neither is Emoji, except in a composer too narrow for that button, where the
 * button is not drawn and the menu holds its action.
 * @param {{ enabled: boolean, showEmoji?: boolean }} state Whether a conversation is open, and whether the menu offers Insert Emoji.
 */
export function buildComposerMenuSections({ enabled, showEmoji = false }, { selfie, remind, summarize, forceReply, insertEmoji }) {
    const disabled = !enabled;
    return [
        {
            items: [
                ...(showEmoji ? [{ label: 'Insert Emoji', icon: 'fa-solid fa-face-smile', disabled, onSelect: insertEmoji }] : []),
                { label: 'Send a Selfie', icon: 'fa-solid fa-camera', disabled, onSelect: selfie },
                { label: 'Remind Me', icon: 'fa-solid fa-bell', disabled, onSelect: remind },
                { label: 'Summarize Memory', icon: 'fa-solid fa-book-open', disabled, onSelect: summarize },
                { label: 'Force a Reply', icon: 'fa-solid fa-bolt', disabled, onSelect: forceReply },
            ],
        },
    ];
}
