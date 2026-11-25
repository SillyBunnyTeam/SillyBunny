/**
 * The sections of the three menus of the conversation list, as `openActionMenu` takes them. Each builder only decides
 * which items there are and what they say; the page gives it the actions, so that tests read the result as it is.
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
                entry.muted
                    ? { label: 'Unmute', icon: 'fa-solid fa-bell', onSelect: () => actions.setMuted(entry, false) }
                    : { label: 'Mute', icon: 'fa-solid fa-bell-slash', onSelect: () => actions.setMuted(entry, true) },
            ],
        },
        { items: [{ label: 'Details', icon: 'fa-solid fa-circle-info', onSelect: () => actions.openDetails(entry) }] },
        { items: [{ label: 'Delete', icon: 'fa-solid fa-trash-can', danger: true, onSelect: () => actions.remove(entry) }] },
    ];
}

/** The New button's menu. Mark All as Read stays where the list had it until a task moves it. */
export function buildNewMenuSections({ newConversation, newGroup, markAllRead }) {
    return [
        {
            items: [
                { label: 'New Conversation', icon: 'fa-solid fa-user-plus', onSelect: newConversation },
                { label: 'New Group', icon: 'fa-solid fa-user-group', onSelect: newGroup },
            ],
        },
        { items: [{ label: 'Mark All as Read', icon: 'fa-solid fa-check-double', onSelect: markAllRead }] },
    ];
}

/** The primary menu of the list's header bar (HIG Menus): the standard items of an application that has them. */
export function buildMainMenuSections({ openPreferences, openHelp }) {
    return [
        {
            items: [
                { label: 'Preferences', icon: 'fa-solid fa-sliders', onSelect: openPreferences },
                { label: 'Help', icon: 'fa-solid fa-circle-question', onSelect: openHelp },
            ],
        },
    ];
}
