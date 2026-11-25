import { describe, expect, jest, test } from '@jest/globals';

const {
    buildComposerMenuSections,
    buildHeaderMenuSections,
    buildMainMenuSections,
    buildNewMenuSections,
    buildRowMenuSections,
} = await import('../public/scripts/sillybunny-conversation/conversation-menus.js');

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
    test('offers New Conversation and New Group and nothing else', () => {
        const actions = { newConversation: jest.fn(), newGroup: jest.fn() };
        const sections = buildNewMenuSections(actions);

        expect(labels(sections)).toEqual([['New Conversation', 'New Group']]);
        find(sections, 'New Conversation').onSelect();
        find(sections, 'New Group').onSelect();
        expect(actions.newConversation).toHaveBeenCalledTimes(1);
        expect(actions.newGroup).toHaveBeenCalledTimes(1);
    });
});

describe('the Main Menu', () => {
    test('holds Mark All as Read first, then Preferences and Help as the last group, and no Close or Quit', () => {
        const actions = { markAllRead: jest.fn(), openPreferences: jest.fn(), openHelp: jest.fn() };
        const sections = buildMainMenuSections(actions);

        expect(labels(sections)).toEqual([['Mark All as Read'], ['Preferences', 'Help']]);
        find(sections, 'Mark All as Read').onSelect();
        find(sections, 'Preferences').onSelect();
        find(sections, 'Help').onSelect();
        expect(actions.markAllRead).toHaveBeenCalledTimes(1);
        expect(actions.openPreferences).toHaveBeenCalledTimes(1);
        expect(actions.openHelp).toHaveBeenCalledTimes(1);
    });

    test('gives every item an icon and disables none', () => {
        const items = buildMainMenuSections({ markAllRead: jest.fn(), openPreferences: jest.fn(), openHelp: jest.fn() }).flatMap(section => section.items);

        expect(items.every(item => typeof item.icon === 'string' && item.icon.startsWith('fa-'))).toBe(true);
        expect(items.some(item => item.disabled)).toBe(false);
    });
});

const makeHeaderActions = () => ({
    openDetails: jest.fn(),
    newChat: jest.fn(),
    addMember: jest.fn(),
    setMuted: jest.fn(),
    selectMessages: jest.fn(),
    deleteChat: jest.fn(),
    deleteConversation: jest.fn(),
});
const headerState = (overrides = {}) => ({ muted: false, hasMessages: true, hasChat: true, ...overrides });

describe('the menu of the conversation header', () => {
    test('offers Details, New Chat and Add Member, then Mute and Select Messages, then the two deletes in a section of their own', () => {
        const sections = buildHeaderMenuSections(headerState(), makeHeaderActions());

        expect(labels(sections)).toEqual([
            ['Details', 'New Chat', 'Add Member'],
            ['Mute', 'Select Messages'],
            ['Delete Chat', 'Delete Conversation'],
        ]);
    });

    test('says Unmute for a muted conversation', () => {
        const sections = buildHeaderMenuSections(headerState({ muted: true }), makeHeaderActions());

        expect(labels(sections)[1]).toEqual(['Unmute', 'Select Messages']);
    });

    test('leaves out Select Messages when there is no message, and Delete Chat when there is no chat, instead of disabling them', () => {
        const sections = buildHeaderMenuSections(headerState({ hasMessages: false, hasChat: false }), makeHeaderActions());
        const items = sections.flatMap(section => section.items);

        expect(labels(sections)).toEqual([['Details', 'New Chat', 'Add Member'], ['Mute'], ['Delete Conversation']]);
        expect(items.some(item => item.disabled)).toBe(false);
    });

    test('has no gear, no Branches and no Edit Schedule, and no item that the Main Menu has', () => {
        const all = buildHeaderMenuSections(headerState(), makeHeaderActions()).flatMap(section => section.items.map(item => item.label));

        expect(all).not.toContain('Conversation Settings');
        expect(all.some(label => /branch/i.test(label))).toBe(false);
        expect(all).not.toContain('Edit Schedule…');
        expect(all).not.toContain('Mark All as Read');
    });

    test('both deletes are danger items, every item has an icon', () => {
        const sections = buildHeaderMenuSections(headerState(), makeHeaderActions());
        const items = sections.flatMap(section => section.items);

        expect(find(sections, 'Delete Chat').danger).toBe(true);
        expect(find(sections, 'Delete Conversation').danger).toBe(true);
        expect(items.filter(item => item.danger)).toHaveLength(2);
        expect(items.every(item => typeof item.icon === 'string' && item.icon.startsWith('fa-'))).toBe(true);
    });

    test('each item runs its action; Mute and Unmute pass the state that they set', () => {
        const actions = makeHeaderActions();
        const sections = buildHeaderMenuSections(headerState(), actions);

        for (const label of ['Details', 'New Chat', 'Add Member', 'Mute', 'Select Messages', 'Delete Chat', 'Delete Conversation']) {
            find(sections, label).onSelect();
        }
        const unmute = buildHeaderMenuSections(headerState({ muted: true }), actions);
        find(unmute, 'Unmute').onSelect();

        expect(actions.openDetails).toHaveBeenCalledTimes(1);
        expect(actions.newChat).toHaveBeenCalledTimes(1);
        expect(actions.addMember).toHaveBeenCalledTimes(1);
        expect(actions.setMuted.mock.calls).toEqual([[true], [false]]);
        expect(actions.selectMessages).toHaveBeenCalledTimes(1);
        expect(actions.deleteChat).toHaveBeenCalledTimes(1);
        expect(actions.deleteConversation).toHaveBeenCalledTimes(1);
    });
});

describe('the "+" menu of the composer', () => {
    test('holds Selfie, Remind, Summarize and Force Reply, and not Attach, which has a button of its own', () => {
        const actions = { selfie: jest.fn(), remind: jest.fn(), summarize: jest.fn(), forceReply: jest.fn() };
        const sections = buildComposerMenuSections({ enabled: true }, actions);

        expect(labels(sections)).toEqual([['Send a Selfie', 'Remind Me', 'Summarize Memory', 'Force a Reply']]);
        for (const item of sections[0].items) {
            item.onSelect();
        }
        expect(actions.selfie).toHaveBeenCalledTimes(1);
        expect(actions.remind).toHaveBeenCalledTimes(1);
        expect(actions.summarize).toHaveBeenCalledTimes(1);
        expect(actions.forceReply).toHaveBeenCalledTimes(1);
    });

    test('disables every item while no conversation is open, and gives each an icon', () => {
        const actions = { selfie: jest.fn(), remind: jest.fn(), summarize: jest.fn(), forceReply: jest.fn() };
        const items = buildComposerMenuSections({ enabled: false }, actions).flatMap(section => section.items);

        expect(items.every(item => item.disabled === true)).toBe(true);
        expect(items.every(item => typeof item.icon === 'string' && item.icon.startsWith('fa-'))).toBe(true);
    });
});
