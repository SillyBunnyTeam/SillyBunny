/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const openActionMenu = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu }));
let lastMode = 'roleplay';
jest.unstable_mockModule('../../public/scripts/sillybunny-chat-mode-memory.js', () => ({ getLastChatMode: () => lastMode }));
const { mountAssistants } = await import('../../public/scripts/sillybunny-home/assistants-view.js');

const AVAILABLE_REISEN = { key: 'assistant-reisen', id: 'reisen', kind: 'bundled', name: 'Reisen', slot: 'AS-REISEN-SUB', art: { name: 'row-reisen', avatar: null }, avatar: 'default_AssistantReisen.png', state: 'available' };
const MISSING_TEWI = { key: 'assistant-tewi', id: 'tewi', kind: 'bundled', name: 'Tewi', slot: 'AS-TEWI-SUB', art: { name: 'row-tewi', avatar: null }, avatar: null, state: 'missing' };
const DELETED_TEWI = { ...MISSING_TEWI, state: 'deleted' };
const POINTER = { key: 'assistant-own', id: 'pointer', kind: 'pointer', name: 'Alice', slot: 'AS-POINTER-SUB', art: { name: 'row-pointer', avatar: 'Alice.png' }, avatar: 'Alice.png', state: 'available' };
const CHOOSE = { key: 'assistant-own', id: 'own', kind: 'choose', name: null, slot: 'AS-CHOOSE-SUB', art: null, avatar: null, state: 'available' };

function createActions() {
    return { newChat: jest.fn(), temporaryChat: jest.fn(), newChatInMode: jest.fn() };
}

function render(cards, { actions = createActions(), openPicker = jest.fn(), removeAssistant = jest.fn() } = {}) {
    document.body.innerHTML = '<div class="welcomePanel"><div data-sb-home-list="assistants"></div></div>';
    const panel = document.querySelector('.welcomePanel');
    const getCards = jest.fn(() => cards);
    mountAssistants(panel, { getCards, actions, getThumbnailUrl: avatar => `/thumb/${avatar}`, openPicker, removeAssistant });
    return { panel, actions, getCards, openPicker, removeAssistant };
}

const cardOf = (panel, key) => panel.querySelector(`[data-sb-home-key="${key}"]`);
const overlay = card => card.querySelector('.sbHomeCardOpen');
const footButtons = card => [...card.querySelectorAll('.sbHomeFootButton')];

beforeEach(() => {
    lastMode = 'roleplay';
    openActionMenu.mockClear();
});

describe('the cards of the Assistants section', () => {
    test('are one for each card the model lists, in its order, and nothing after them', () => {
        const { panel } = render([AVAILABLE_REISEN, MISSING_TEWI, CHOOSE]);

        expect([...panel.querySelectorAll('[data-sb-home-key]')].map(card => card.dataset.sbHomeKey))
            .toEqual(['assistant-reisen', 'assistant-tewi', 'assistant-own']);
    });

    test('say what kind of card each is, for the styles and the specs', () => {
        const pointer = render([AVAILABLE_REISEN, POINTER]).panel;
        const choose = render([AVAILABLE_REISEN, CHOOSE]).panel;

        expect([...pointer.querySelectorAll('[data-sb-home-key]')].map(card => card.dataset.sbAssistantKind)).toEqual(['bundled', 'pointer']);
        expect([...choose.querySelectorAll('[data-sb-home-key]')].map(card => card.dataset.sbAssistantKind)).toEqual(['bundled', 'choose']);
    });

    test('are read from the model each time Home is mounted', () => {
        const { panel, getCards } = render([AVAILABLE_REISEN]);

        mountAssistants(panel, { getCards, actions: createActions(), getThumbnailUrl: String, openPicker: jest.fn(), removeAssistant: jest.fn() });

        expect(getCards).toHaveBeenCalledTimes(2);
    });

    test('keep the names, titles and placeholder subtitles of the cards that Reisen and Tewi had', () => {
        const { panel } = render([AVAILABLE_REISEN]);
        const card = cardOf(panel, 'assistant-reisen');

        expect(card.querySelector('.sbHomeCardName').textContent).toBe('Reisen');
        expect(overlay(card).getAttribute('aria-label')).toBe('New chat with Reisen');
        expect(overlay(card).title).toBe('New Chat With Reisen');
        expect(footButtons(card).map(button => button.getAttribute('aria-label'))).toEqual(['Start new chat with Reisen', 'Temporary Chat with Reisen']);
        expect(card.querySelector('.sbHomeCardSub').dataset.sbCopySlot).toBe('AS-REISEN-SUB');
        expect(card.querySelector('.sbHomeCardSub').dataset.sbCopyPlaceholder).toBe('true');
        expect(card.querySelector('.sbHomeRowMenu').getAttribute('aria-label')).toBe('Assistant Menu');
    });

    test('carry no stub marker, because every control is wired', () => {
        const { panel } = render([AVAILABLE_REISEN, MISSING_TEWI, POINTER, CHOOSE]);

        expect(panel.querySelectorAll('[data-sb-stub]')).toHaveLength(0);
    });
});

describe('a card with a file', () => {
    test('is sensitive: the card button, both footer buttons and the menu button are enabled', () => {
        const { panel } = render([AVAILABLE_REISEN]);
        const card = cardOf(panel, 'assistant-reisen');

        expect([...card.querySelectorAll('button')].map(button => button.disabled)).toEqual([false, false, false, false]);
    });

    test('opens a new chat from the card button and from Start New Chat', () => {
        const { panel, actions } = render([AVAILABLE_REISEN]);
        const card = cardOf(panel, 'assistant-reisen');

        overlay(card).click();
        footButtons(card)[0].click();

        expect(actions.newChat).toHaveBeenCalledTimes(2);
        expect(actions.newChat).toHaveBeenCalledWith(AVAILABLE_REISEN);
        expect(actions.temporaryChat).not.toHaveBeenCalled();
    });

    test('opens a temporary chat from Temporary Chat', () => {
        const { panel, actions } = render([AVAILABLE_REISEN]);

        footButtons(cardOf(panel, 'assistant-reisen'))[1].click();

        expect(actions.temporaryChat).toHaveBeenCalledWith(AVAILABLE_REISEN);
        expect(actions.newChat).not.toHaveBeenCalled();
    });

    test('opens the Assistant Menu with an item that starts the chat in the other mode, for this card', () => {
        const { panel, actions } = render([AVAILABLE_REISEN]);
        const menuButton = cardOf(panel, 'assistant-reisen').querySelector('.sbHomeRowMenu');

        menuButton.click();

        expect(openActionMenu).toHaveBeenCalledTimes(1);
        const [item] = openActionMenu.mock.calls[0][0].sections[0].items;
        expect(item.label).toBe('New Chat in Conversation');
        item.onSelect();
        expect(actions.newChatInMode).toHaveBeenCalledWith(AVAILABLE_REISEN, 'conversation');
    });

    test('offers Roleplay in the menu when Conversation was the last mode', () => {
        lastMode = 'conversation';
        const { panel, actions } = render([AVAILABLE_REISEN]);

        cardOf(panel, 'assistant-reisen').querySelector('.sbHomeRowMenu').click();
        openActionMenu.mock.calls[0][0].sections[0].items[0].onSelect();

        expect(actions.newChatInMode).toHaveBeenCalledWith(AVAILABLE_REISEN, 'roleplay');
    });
});

describe.each([['missing', MISSING_TEWI], ['deleted', DELETED_TEWI]])('a card whose file is %s', (_state, card) => {
    test('is insensitive: the card button and both footer buttons are disabled', () => {
        const { panel } = render([card]);
        const element = cardOf(panel, 'assistant-tewi');

        expect(overlay(element).disabled).toBe(true);
        expect(footButtons(element).map(button => button.disabled)).toEqual([true, true]);
    });

    test('has no menu, because D has nothing to put in it', () => {
        const { panel } = render([card]);
        const element = cardOf(panel, 'assistant-tewi');

        expect(element.querySelector('.sbHomeRowMenu')).toBeNull();
        expect(element.querySelectorAll('.sbHomeCardFooter > *')).toHaveLength(2);
    });

    test('keeps its name and its placeholder subtitle, and adds no text', () => {
        const { panel } = render([card]);
        const element = cardOf(panel, 'assistant-tewi');

        expect(element.querySelector('.sbHomeCardName').textContent).toBe('Tewi');
        expect(element.querySelector('.sbHomeCardSub').dataset.sbCopySlot).toBe('AS-TEWI-SUB');
        expect([...element.querySelectorAll('.sbHomeFootLabel')].map(label => label.textContent)).toEqual(['Start New Chat', 'Temporary Chat']);
        expect(element.hasAttribute('title')).toBe(false);
    });

    test('runs nothing when pressed', () => {
        const { panel, actions } = render([card]);
        const element = cardOf(panel, 'assistant-tewi');

        overlay(element).click();
        footButtons(element).forEach(button => button.click());

        expect(actions.newChat).not.toHaveBeenCalled();
        expect(actions.temporaryChat).not.toHaveBeenCalled();
    });

    test('says so to assistive technology through the disabled buttons alone', () => {
        const { panel } = render([card]);
        const element = cardOf(panel, 'assistant-tewi');

        expect(element.querySelector('[data-state], [aria-disabled]')).toBeNull();
    });
});

describe('the art of a card', () => {
    test('is a placeholder box for an assistant that has no picture yet', () => {
        const { panel } = render([AVAILABLE_REISEN]);

        const art = cardOf(panel, 'assistant-reisen').querySelector('.sbHomeCardArt .sbHomeArt');
        expect(art.dataset.sbArtPlaceholder).toBe('row-reisen');
        expect(art.querySelector('img')).toBeNull();
    });

    test('is the thumbnail of the card of the character when the model gives an avatar', () => {
        const { panel } = render([POINTER]);

        const art = cardOf(panel, 'assistant-own').querySelector('.sbHomeCardArt .sbHomeArt');
        expect(art.dataset.sbArtPlaceholder).toBe('row-pointer');
        expect(art.getAttribute('aria-hidden')).toBe('true');
        const image = art.querySelector('img');
        expect(image.getAttribute('src')).toBe('/thumb/Alice.png');
        expect(image.getAttribute('alt')).toBe('');
        expect(image.textContent).toBe('');
        expect(art.textContent).toBe('');
    });
});

describe('the third slot with no character chosen', () => {
    const choose = () => cardOf(render([AVAILABLE_REISEN, MISSING_TEWI, CHOOSE]).panel, 'assistant-own');

    test('is a card to choose from, labelled Choose Assistant, with a placeholder subtitle in its own slot', () => {
        const card = choose();

        expect(card.classList.contains('sbHomeCard--choose')).toBe(true);
        expect(card.querySelector('.sbHomeCardName').textContent).toBe('Choose Assistant');
        expect(card.querySelector('.sbHomeCardSub').dataset.sbCopySlot).toBe('AS-CHOOSE-SUB');
        expect(card.querySelector('.sbHomeCardSub').dataset.sbCopyPlaceholder).toBe('true');
        expect(card.querySelector('.sbHomeCardSub').textContent).toBe('TODO(copy)');
    });

    test('has the user-plus icon, hidden from assistive technology, and no footer, menu or chevron', () => {
        const card = choose();

        expect(card.querySelector('.sbHomeChooseIcon i').className).toBe('fa-solid fa-user-plus');
        expect(card.querySelector('.sbHomeChooseIcon').getAttribute('aria-hidden')).toBe('true');
        expect(card.querySelector('.sbHomeCardFooter')).toBeNull();
        expect(card.querySelector('.sbHomeRowMenu')).toBeNull();
        expect(card.querySelector('.fa-chevron-right')).toBeNull();
    });

    test('has one button, named Choose Assistant, described by the subtitle, that tells it opens a dialog', () => {
        const card = choose();

        expect(card.querySelectorAll('button')).toHaveLength(1);
        expect(overlay(card).getAttribute('aria-label')).toBe('Choose Assistant');
        expect(overlay(card).getAttribute('aria-describedby')).toBe(card.querySelector('.sbHomeCardSub').id);
        expect(overlay(card).getAttribute('aria-haspopup')).toBe('dialog');
    });

    test('opens the picker when it is pressed, with the focus on its own button first', () => {
        const { panel, openPicker, actions } = render([AVAILABLE_REISEN, CHOOSE]);
        const button = overlay(cardOf(panel, 'assistant-own'));
        button.focus = jest.fn();

        button.click();

        expect(button.focus).toHaveBeenCalledTimes(1);
        expect(openPicker).toHaveBeenCalledTimes(1);
        expect(actions.newChat).not.toHaveBeenCalled();
    });
});

describe('the third slot with a character chosen', () => {
    test('is laid out like the card of Reisen: the thumbnail, the name, the subtitle slot of the pointer and the same three controls', () => {
        const { panel } = render([AVAILABLE_REISEN, POINTER]);
        const reisen = cardOf(panel, 'assistant-reisen');
        const card = cardOf(panel, 'assistant-own');

        expect(card.classList.contains('sbHomeCard--choose')).toBe(false);
        expect(card.querySelector('.sbHomeCardName').textContent).toBe('Alice');
        expect(card.querySelector('.sbHomeCardSub').dataset.sbCopySlot).toBe('AS-POINTER-SUB');
        expect(card.querySelector('.sbHomeCardArt img').getAttribute('src')).toBe('/thumb/Alice.png');
        expect([...card.querySelectorAll('button')].map(button => button.className)).toEqual([...reisen.querySelectorAll('button')].map(button => button.className));
        expect(footButtons(card).map(button => button.getAttribute('aria-label'))).toEqual(['Start new chat with Alice', 'Temporary Chat with Alice']);
    });

    test('opens a new chat and a temporary chat for the chosen character', () => {
        const { panel, actions } = render([POINTER]);
        const card = cardOf(panel, 'assistant-own');

        overlay(card).click();
        footButtons(card)[1].click();

        expect(actions.newChat).toHaveBeenCalledWith(POINTER);
        expect(actions.temporaryChat).toHaveBeenCalledWith(POINTER);
    });

    test('has a menu with the chat item, Choose Another Assistant and Remove Assistant', () => {
        const { panel } = render([POINTER]);

        cardOf(panel, 'assistant-own').querySelector('.sbHomeRowMenu').click();

        const sections = openActionMenu.mock.calls[0][0].sections;
        expect(sections.map(section => section.items.map(item => item.label))).toEqual([['New Chat in Conversation'], ['Choose Another Assistant\u2026', 'Remove Assistant']]);
    });

    test('opens the picker from Choose Another Assistant, and clears the choice from Remove Assistant', () => {
        const { panel, openPicker, removeAssistant } = render([POINTER]);
        cardOf(panel, 'assistant-own').querySelector('.sbHomeRowMenu').click();
        const [, { items }] = openActionMenu.mock.calls[0][0].sections;

        items[0].onSelect();
        expect(openPicker).toHaveBeenCalledTimes(1);
        expect(removeAssistant).not.toHaveBeenCalled();
        items[1].onSelect();
        expect(removeAssistant).toHaveBeenCalledTimes(1);
    });

    test('puts focus on its menu button before the picker opens, so the window gives it back there', () => {
        const { panel, openPicker } = render([POINTER]);
        const menuButton = cardOf(panel, 'assistant-own').querySelector('.sbHomeRowMenu');
        menuButton.focus = jest.fn(() => expect(openPicker).not.toHaveBeenCalled());
        menuButton.click();

        openActionMenu.mock.calls[0][0].sections[1].items[0].onSelect();

        expect(menuButton.focus).toHaveBeenCalledTimes(1);
        expect(openPicker).toHaveBeenCalledTimes(1);
    });

    test('is the only card whose menu has the two choice items', () => {
        const { panel } = render([AVAILABLE_REISEN, POINTER]);

        cardOf(panel, 'assistant-reisen').querySelector('.sbHomeRowMenu').click();

        expect(openActionMenu.mock.calls[0][0].sections.map(section => section.items.length)).toEqual([1]);
    });
});
