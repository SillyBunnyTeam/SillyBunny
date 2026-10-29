/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const openActionMenu = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu }));
const { buildChatMenuSections, buildHomeMenuSections, openChatMenu } = await import('../../public/scripts/sillybunny-home/menu.js');

function allActions() {
    return {
        setDisplayMode: jest.fn(),
        showWelcome: jest.fn(),
        openRecentChatsSettings: jest.fn(),
        showGettingStarted: jest.fn(),
        openKeyboardShortcuts: jest.fn(),
        openHelp: jest.fn(),
        openAbout: jest.fn(),
    };
}

const labelsOf = sections => sections.map(section => section.items.map(item => item.label));

describe('Home main menu', () => {
    test('orders the display modes, the commands and the help items in three sections', () => {
        const sections = buildHomeMenuSections({ displayMode: 'full' }, allActions());

        expect(labelsOf(sections)).toEqual([
            ['Full', 'Compact', 'List Only'],
            ['Show Welcome', 'Recent Chats Settings'],
            ['Keyboard Shortcuts', 'Help', 'About SillyBunny'],
        ]);
        expect(sections[0].title).toBe('Display Mode');
    });

    test.each(['full', 'compact', 'list'])('checks only the %s display mode as a radio item', (displayMode) => {
        const [modes] = buildHomeMenuSections({ displayMode }, allActions());

        expect(modes.items.every(item => item.kind === 'radio')).toBe(true);
        expect(modes.items.filter(item => item.checked)).toHaveLength(1);
        expect(modes.items.find(item => item.checked).label).toBe({ full: 'Full', compact: 'Compact', list: 'List Only' }[displayMode]);
    });

    test('selecting a display mode reports the stored value', () => {
        const actions = allActions();
        const [modes] = buildHomeMenuSections({ displayMode: 'full' }, actions);

        modes.items.find(item => item.label === 'Compact').onSelect();
        modes.items.find(item => item.label === 'List Only').onSelect();

        expect(actions.setDisplayMode.mock.calls.map(([mode]) => mode)).toEqual(['compact', 'list']);
    });

    test('shows Show Getting Started only while Getting Started is hidden', () => {
        const hidden = buildHomeMenuSections({ displayMode: 'full', gettingStartedHidden: true }, allActions());
        const shown = buildHomeMenuSections({ displayMode: 'full', gettingStartedHidden: false }, allActions());
        const unspecified = buildHomeMenuSections({ displayMode: 'full' }, allActions());

        expect(labelsOf(hidden)[1]).toEqual(['Show Welcome', 'Recent Chats Settings', 'Show Getting Started']);
        expect(labelsOf(shown)[1]).not.toContain('Show Getting Started');
        expect(labelsOf(unspecified)[1]).not.toContain('Show Getting Started');
    });

    test('omits every item whose action is not provided', () => {
        const sections = buildHomeMenuSections(
            { displayMode: 'compact', gettingStartedHidden: true },
            { setDisplayMode: jest.fn(), openRecentChatsSettings: jest.fn() },
        );

        expect(labelsOf(sections)).toEqual([
            ['Full', 'Compact', 'List Only'],
            ['Recent Chats Settings'],
        ]);
    });

    test('drops a section that has no items left', () => {
        const sections = buildHomeMenuSections({ displayMode: 'full' }, { setDisplayMode: jest.fn() });

        expect(labelsOf(sections)).toEqual([['Full', 'Compact', 'List Only']]);
    });

    test('gives every command item an explicit icon', () => {
        const sections = buildHomeMenuSections({ displayMode: 'full', gettingStartedHidden: true }, allActions());
        const commands = sections.slice(1).flatMap(section => section.items);

        expect(commands).toHaveLength(6);
        for (const item of commands) {
            expect(item.icon).toMatch(/^fa-solid fa-[a-z-]+$/);
        }
    });

    test('runs the provided action when an item is selected', () => {
        const actions = allActions();
        const sections = buildHomeMenuSections({ displayMode: 'full', gettingStartedHidden: true }, actions);
        const byLabel = Object.fromEntries(sections.flatMap(section => section.items).map(item => [item.label, item]));

        byLabel['Recent Chats Settings'].onSelect();
        byLabel['Show Getting Started'].onSelect();
        byLabel['About SillyBunny'].onSelect();

        expect(actions.openRecentChatsSettings).toHaveBeenCalledTimes(1);
        expect(actions.showGettingStarted).toHaveBeenCalledTimes(1);
        expect(actions.openAbout).toHaveBeenCalledTimes(1);
        expect(actions.openHelp).not.toHaveBeenCalled();
    });
});

describe('Recent Chats row menu', () => {
    const chatActions = () => ({ rename: jest.fn(), remove: jest.fn() });

    test('puts Rename first and Delete last in a section of its own', () => {
        const sections = buildChatMenuSections(chatActions());

        expect(labelsOf(sections)).toEqual([['Rename'], ['Delete']]);
    });

    test('marks Delete as dangerous and gives both items an explicit icon', () => {
        const [renameSection, deleteSection] = buildChatMenuSections(chatActions());

        expect(renameSection.items[0].icon).toBe('fa-solid fa-pen-to-square');
        expect(deleteSection.items[0].icon).toBe('fa-solid fa-trash');
        expect(deleteSection.items[0].danger).toBe(true);
        expect(renameSection.items[0].danger).toBeUndefined();
    });

    test('runs rename and delete from their own items', () => {
        const actions = chatActions();
        const [renameSection, deleteSection] = buildChatMenuSections(actions);

        deleteSection.items[0].onSelect();
        expect(actions.remove).toHaveBeenCalledTimes(1);
        expect(actions.rename).not.toHaveBeenCalled();

        renameSection.items[0].onSelect();
        expect(actions.rename).toHaveBeenCalledTimes(1);
    });

    test('opens the shared action menu named Chat Menu, kept inside the given bounds', () => {
        const trigger = {};
        const bounds = {};

        openChatMenu(trigger, chatActions(), { keyboard: true, bounds });

        expect(openActionMenu).toHaveBeenCalledWith(expect.objectContaining({ trigger, bounds, keyboard: true, title: 'Chat Menu' }));
        expect(openActionMenu.mock.calls.at(-1)[0].sections).toHaveLength(2);
    });
});
