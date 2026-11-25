import { describe, expect, jest, test } from '@jest/globals';

const {
    buildMainMenuSections,
    buildNewMenuSections,
    buildRowMenuSections,
} = await import('../public/scripts/sillybunny-conversation/conversation-list-menu.js');

const entry = (overrides = {}) => ({ id: 'conv_1', name: 'Seraphina', favorite: false, muted: false, unread: 0, lastMessageRole: 'character', active: false, ...overrides });

const makeActions = () => ({
    markRead: jest.fn(),
    markUnread: jest.fn(),
    setFavorite: jest.fn(),
    setMuted: jest.fn(),
    openDetails: jest.fn(),
    remove: jest.fn(),
});

const labels = sections => sections.map(section => section.items.map(item => item.label));
const find = (sections, label) => sections.flatMap(section => section.items).find(item => item.label === label);

describe('the menu of a row', () => {
    test('offers Mark as Unread, Add to Favorites and Mute for a read row, then Details, then Delete in a section of its own', () => {
        const sections = buildRowMenuSections(entry(), makeActions());

        expect(labels(sections)).toEqual([
            ['Mark as Unread'],
            ['Add to Favorites', 'Mute'],
            ['Details'],
            ['Delete'],
        ]);
    });

    test('swaps each verb for its opposite when the state is the other one', () => {
        const sections = buildRowMenuSections(entry({ unread: 4, favorite: true, muted: true }), makeActions());

        expect(labels(sections)).toEqual([
            ['Mark as Read'],
            ['Remove From Favorites', 'Unmute'],
            ['Details'],
            ['Delete'],
        ]);
    });

    test('leaves out the read item, and its section, when the row has no message to mark, as the open conversation has none', () => {
        const sections = buildRowMenuSections(entry({ active: true }), makeActions());

        expect(labels(sections)).toEqual([['Add to Favorites', 'Mute'], ['Details'], ['Delete']]);
    });

    test('Delete is a danger item, every item has an icon, and no item is disabled', () => {
        const sections = buildRowMenuSections(entry({ unread: 1 }), makeActions());
        const items = sections.flatMap(section => section.items);

        expect(find(sections, 'Delete').danger).toBe(true);
        expect(items.every(item => typeof item.icon === 'string' && item.icon.startsWith('fa-'))).toBe(true);
        expect(items.some(item => item.disabled)).toBe(false);
    });

    test('each item runs its action with the row\'s entry', () => {
        const actions = makeActions();
        const row = entry({ unread: 2 });
        const sections = buildRowMenuSections(row, actions);

        find(sections, 'Mark as Read').onSelect();
        find(sections, 'Add to Favorites').onSelect();
        find(sections, 'Mute').onSelect();
        find(sections, 'Details').onSelect();
        find(sections, 'Delete').onSelect();

        expect(actions.markRead).toHaveBeenCalledWith(row);
        expect(actions.setFavorite).toHaveBeenCalledWith(row, true);
        expect(actions.setMuted).toHaveBeenCalledWith(row, true);
        expect(actions.openDetails).toHaveBeenCalledWith(row);
        expect(actions.remove).toHaveBeenCalledWith(row);
    });

    test('the opposite verbs run the opposite change', () => {
        const actions = makeActions();
        const row = entry({ favorite: true, muted: true });
        const sections = buildRowMenuSections(row, actions);

        find(sections, 'Mark as Unread').onSelect();
        find(sections, 'Remove From Favorites').onSelect();
        find(sections, 'Unmute').onSelect();

        expect(actions.markUnread).toHaveBeenCalledWith(row);
        expect(actions.setFavorite).toHaveBeenCalledWith(row, false);
        expect(actions.setMuted).toHaveBeenCalledWith(row, false);
    });
});

describe('the New menu', () => {
    test('offers New Conversation and New Group, then Mark All as Read in its own section', () => {
        const actions = { newConversation: jest.fn(), newGroup: jest.fn(), markAllRead: jest.fn() };
        const sections = buildNewMenuSections(actions);

        expect(labels(sections)).toEqual([['New Conversation', 'New Group'], ['Mark All as Read']]);
        find(sections, 'New Conversation').onSelect();
        find(sections, 'New Group').onSelect();
        find(sections, 'Mark All as Read').onSelect();
        expect(actions.newConversation).toHaveBeenCalledTimes(1);
        expect(actions.newGroup).toHaveBeenCalledTimes(1);
        expect(actions.markAllRead).toHaveBeenCalledTimes(1);
    });
});

describe('the Main Menu', () => {
    test('holds Preferences and Help, the standard items of a primary menu, and no Close or Quit', () => {
        const actions = { openPreferences: jest.fn(), openHelp: jest.fn() };
        const sections = buildMainMenuSections(actions);

        expect(labels(sections)).toEqual([['Preferences', 'Help']]);
        find(sections, 'Preferences').onSelect();
        find(sections, 'Help').onSelect();
        expect(actions.openPreferences).toHaveBeenCalledTimes(1);
        expect(actions.openHelp).toHaveBeenCalledTimes(1);
    });
});
