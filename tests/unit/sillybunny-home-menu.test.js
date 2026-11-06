/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const openActionMenu = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu }));
const { buildAssistantMenuSections, buildChatMenuSections, buildHomeMenuSections, getOtherChatMode, openAssistantMenu, openChatMenu } = await import('../../public/scripts/sillybunny-home/menu.js');

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

    test('leaves Show Getting Started out in List Only, where the tile never shows', () => {
        const sections = buildHomeMenuSections({ displayMode: 'list', gettingStartedHidden: true }, allActions());

        expect(labelsOf(sections).flat()).not.toContain('Show Getting Started');
    });

    test.each(['full', 'compact'])('offers Show Getting Started in %s, where the tile shows', (displayMode) => {
        const sections = buildHomeMenuSections({ displayMode, gettingStartedHidden: true }, allActions());

        expect(labelsOf(sections)[1]).toContain('Show Getting Started');
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

    test('aligns the popover to the end of the button, which sits at the end of its row', () => {
        openChatMenu({}, chatActions());

        expect(openActionMenu).toHaveBeenCalledWith(expect.objectContaining({ alignment: 'end' }));
    });
});

describe('Assistant menu', () => {
    const assistantActions = () => ({ newChatInMode: jest.fn() });

    test('offers the mode other than the remembered one', () => {
        expect(getOtherChatMode('roleplay')).toBe('conversation');
        expect(getOtherChatMode('conversation')).toBe('roleplay');
    });

    test('offers a new chat in Conversation after Roleplay was the last mode', () => {
        const sections = buildAssistantMenuSections({ lastMode: 'roleplay', actions: assistantActions() });

        expect(labelsOf(sections)).toEqual([['New Chat in Conversation']]);
    });

    test('offers a new chat in Roleplay after Conversation was the last mode', () => {
        const sections = buildAssistantMenuSections({ lastMode: 'conversation', actions: assistantActions() });

        expect(labelsOf(sections)).toEqual([['New Chat in Roleplay']]);
    });

    test('treats an unknown remembered mode as Roleplay', () => {
        const sections = buildAssistantMenuSections({ lastMode: undefined, actions: assistantActions() });

        expect(labelsOf(sections).flat()).toEqual(['New Chat in Conversation']);
    });

    test('leaves New Chat and Temporary Chat to the card footer', () => {
        const labels = ['roleplay', 'conversation'].flatMap(lastMode => labelsOf(buildAssistantMenuSections({ lastMode, actions: assistantActions() })).flat());

        expect(labels.some(label => /temporary/i.test(label))).toBe(false);
        expect(labels.every(label => label.startsWith('New Chat in '))).toBe(true);
    });

    test.each([
        ['roleplay', 'fa-solid fa-comments sbHomeMenuIconFit'],
        ['conversation', 'fa-solid fa-masks-theater sbHomeMenuIconFit'],
    ])('gives the item after %s an explicit icon that fits the icon box, and no stub marker', (lastMode, icon) => {
        const [section] = buildAssistantMenuSections({ lastMode, actions: assistantActions() });

        expect(section.items[0].icon).toBe(icon);
        expect(section.items[0].data).toBeUndefined();
    });

    test.each(['missing', 'deleted'])('offers nothing for a card whose file is %s, so the card shows no menu', (state) => {
        expect(buildAssistantMenuSections({ lastMode: 'roleplay', actions: assistantActions(), state })).toEqual([]);
    });

    test('offers the item for an available card', () => {
        expect(labelsOf(buildAssistantMenuSections({ lastMode: 'roleplay', actions: assistantActions(), state: 'available' }))).toEqual([['New Chat in Conversation']]);
    });

    test('runs the action with the mode the item opens', () => {
        const actions = assistantActions();

        buildAssistantMenuSections({ lastMode: 'roleplay', actions })[0].items[0].onSelect();
        buildAssistantMenuSections({ lastMode: 'conversation', actions })[0].items[0].onSelect();

        expect(actions.newChatInMode.mock.calls.map(([mode]) => mode)).toEqual(['conversation', 'roleplay']);
    });

    test('offers Choose Another Assistant and Remove Assistant after the chat item, in a section of their own, when the card has the actions', () => {
        const actions = { ...assistantActions(), chooseAnother: jest.fn(), remove: jest.fn() };

        const sections = buildAssistantMenuSections({ lastMode: 'roleplay', actions });

        expect(labelsOf(sections)).toEqual([['New Chat in Conversation'], ['Choose Another Assistant\u2026', 'Remove Assistant']]);
        sections[1].items[0].onSelect();
        expect(actions.chooseAnother).toHaveBeenCalledTimes(1);
        expect(actions.remove).not.toHaveBeenCalled();
        sections[1].items[1].onSelect();
        expect(actions.remove).toHaveBeenCalledTimes(1);
    });

    test('leaves out the item of an action that the card does not have, so Reisen and Tewi keep their one item', () => {
        expect(labelsOf(buildAssistantMenuSections({ lastMode: 'roleplay', actions: assistantActions() }))).toEqual([['New Chat in Conversation']]);
        expect(labelsOf(buildAssistantMenuSections({ lastMode: 'roleplay', actions: { ...assistantActions(), chooseAnother: jest.fn() } }))).toEqual([['New Chat in Conversation'], ['Choose Another Assistant\u2026']]);
    });

    test('gives Remove Assistant no danger look, because it clears the choice and deletes no character', () => {
        const [, section] = buildAssistantMenuSections({ lastMode: 'roleplay', actions: { ...assistantActions(), remove: jest.fn() } });

        expect(section.items[0].danger).toBeUndefined();
    });

    test('offers neither of them for a card whose file is missing', () => {
        const actions = { ...assistantActions(), chooseAnother: jest.fn(), remove: jest.fn() };

        expect(buildAssistantMenuSections({ lastMode: 'roleplay', actions, state: 'missing' })).toEqual([]);
    });

    describe('Restore and Update Available', () => {
        const RESTORE = { filename: 'default_AssistantReisen.png', restore: true, update: null };
        const UPDATE = { filename: 'default_AssistantReisen.png', restore: false, update: { version: 2 } };
        const managedActions = () => ({ ...assistantActions(), update: jest.fn() });

        test.each(['deleted', 'missing'])('has no menu for a %s card, even when the card offers Restore, because Restore is a button of the card', (state) => {
            expect(buildAssistantMenuSections({ lastMode: 'roleplay', actions: managedActions(), state, offers: RESTORE })).toEqual([]);
        });

        test('has no Restore item for an available card, whatever the offer says', () => {
            const labels = labelsOf(buildAssistantMenuSections({ lastMode: 'roleplay', actions: managedActions(), state: 'available', offers: RESTORE })).flat();

            expect(labels).toEqual(['New Chat in Conversation']);
        });

        test('has Update Available after the chat item, in a section of its own, for an available card with an update', () => {
            const actions = managedActions();

            const sections = buildAssistantMenuSections({ lastMode: 'roleplay', actions, state: 'available', offers: UPDATE });

            expect(labelsOf(sections)).toEqual([['New Chat in Conversation'], ['Update Available']]);
            sections[1].items[0].onSelect();
            expect(actions.update).toHaveBeenCalledTimes(1);
        });

        test('puts Update Available before Choose Another Assistant and Remove Assistant', () => {
            const actions = { ...managedActions(), chooseAnother: jest.fn(), remove: jest.fn() };

            const sections = buildAssistantMenuSections({ lastMode: 'roleplay', actions, offers: UPDATE });

            expect(labelsOf(sections)).toEqual([['New Chat in Conversation'], ['Update Available'], ['Choose Another Assistant\u2026', 'Remove Assistant']]);
        });

        test('gives Update Available an explicit icon that fits the icon box', () => {
            const sections = buildAssistantMenuSections({ lastMode: 'roleplay', actions: managedActions(), offers: UPDATE });

            expect(sections[1].items[0].icon).toBe('fa-solid fa-circle-arrow-up sbHomeMenuIconFit');
        });

        test('has no Update Available when the card offers none, although the actions exist', () => {
            const labels = labelsOf(buildAssistantMenuSections({ lastMode: 'roleplay', actions: managedActions(), offers: { filename: null, restore: false, update: null } })).flat();

            expect(labels).toEqual(['New Chat in Conversation']);
        });

        test('has no Update Available when the offer is for a restore only', () => {
            const labels = labelsOf(buildAssistantMenuSections({ lastMode: 'roleplay', actions: managedActions(), offers: RESTORE })).flat();

            expect(labels).toEqual(['New Chat in Conversation']);
        });

        test('has no Update Available item when the actions have no update', () => {
            expect(labelsOf(buildAssistantMenuSections({ lastMode: 'roleplay', actions: assistantActions(), offers: UPDATE }))).toEqual([['New Chat in Conversation']]);
        });

        test('passes the offers on when it opens the menu', () => {
            openActionMenu.mockClear();

            openAssistantMenu({}, { lastMode: 'roleplay', actions: managedActions(), state: 'available', offers: UPDATE });

            expect(labelsOf(openActionMenu.mock.calls[0][0].sections)).toEqual([['New Chat in Conversation'], ['Update Available']]);
        });
    });

    test('opens the shared action menu named Assistant Menu, kept inside the given bounds', () => {
        const trigger = {};
        const bounds = {};

        openAssistantMenu(trigger, { lastMode: 'roleplay', actions: assistantActions() }, { keyboard: true, bounds });

        expect(openActionMenu).toHaveBeenCalledWith(expect.objectContaining({ trigger, bounds, keyboard: true, title: 'Assistant Menu' }));
    });

    test('aligns the popover to the end of the button, which sits at the end of the card footer', () => {
        openAssistantMenu({}, { lastMode: 'roleplay', actions: assistantActions() });

        expect(openActionMenu).toHaveBeenCalledWith(expect.objectContaining({ alignment: 'end' }));
    });
});
