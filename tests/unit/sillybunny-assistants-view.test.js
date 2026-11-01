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

const AVAILABLE_REISEN = { key: 'assistant-reisen', id: 'reisen', name: 'Reisen', slot: 'AS-REISEN-SUB', art: { name: 'row-reisen', avatar: null }, avatar: 'default_AssistantReisen.png', state: 'available' };
const MISSING_TEWI = { key: 'assistant-tewi', id: 'tewi', name: 'Tewi', slot: 'AS-TEWI-SUB', art: { name: 'row-tewi', avatar: null }, avatar: null, state: 'missing' };
const DELETED_TEWI = { ...MISSING_TEWI, state: 'deleted' };
const NAHIDA = { key: 'assistant-nahida', id: 'nahida', name: 'Nahida', slot: 'AS-NAHIDA-SUB', art: { name: 'row-nahida', avatar: 'default_AssistantNahida.png' }, avatar: 'default_AssistantNahida.png', state: 'available' };

function createActions() {
    return { newChat: jest.fn(), temporaryChat: jest.fn(), newChatInMode: jest.fn() };
}

function render(cards, { actions = createActions(), openMoreAssistants = jest.fn() } = {}) {
    document.body.innerHTML = '<div class="welcomePanel"><div data-sb-home-list="assistants"></div></div>';
    const panel = document.querySelector('.welcomePanel');
    const getCards = jest.fn(() => cards);
    mountAssistants(panel, { openMoreAssistants, getCards, actions, getThumbnailUrl: avatar => `/thumb/${avatar}` });
    return { panel, actions, getCards, openMoreAssistants };
}

const cardOf = (panel, key) => panel.querySelector(`[data-sb-home-key="${key}"]`);
const overlay = card => card.querySelector('.sbHomeCardOpen');
const footButtons = card => [...card.querySelectorAll('.sbHomeFootButton')];

beforeEach(() => {
    lastMode = 'roleplay';
    openActionMenu.mockClear();
});

describe('the cards of the Assistants section', () => {
    test('are one for each card the model lists, in its order, then More Assistants', () => {
        const { panel } = render([NAHIDA, AVAILABLE_REISEN, MISSING_TEWI]);

        expect([...panel.querySelectorAll('[data-sb-home-key]')].map(card => card.dataset.sbHomeKey))
            .toEqual(['assistant-nahida', 'assistant-reisen', 'assistant-tewi', 'assistants-more']);
    });

    test('are read from the model each time Home is mounted', () => {
        const { panel, getCards } = render([AVAILABLE_REISEN]);

        mountAssistants(panel, { openMoreAssistants: jest.fn(), getCards, actions: createActions(), getThumbnailUrl: String });

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
        const { panel } = render([AVAILABLE_REISEN, MISSING_TEWI, NAHIDA]);

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
        const { panel } = render([NAHIDA]);

        const art = cardOf(panel, 'assistant-nahida').querySelector('.sbHomeCardArt .sbHomeArt');
        expect(art.dataset.sbArtPlaceholder).toBe('row-nahida');
        expect(art.getAttribute('aria-hidden')).toBe('true');
        const image = art.querySelector('img');
        expect(image.getAttribute('src')).toBe('/thumb/default_AssistantNahida.png');
        expect(image.getAttribute('alt')).toBe('');
        expect(image.textContent).toBe('');
        expect(art.textContent).toBe('');
    });
});

describe('More Assistants', () => {
    test('stays the last card, and opens the window', () => {
        const { panel, openMoreAssistants } = render([AVAILABLE_REISEN]);
        const more = panel.querySelector('[data-sb-home-key="assistants-more"]');

        overlay(more).click();

        expect(openMoreAssistants).toHaveBeenCalledTimes(1);
        expect(panel.querySelector('[data-sb-home-list="assistants"]').lastElementChild).toBe(more);
        expect(more.querySelector('.sbHomeCardFooter')).toBeNull();
    });
});
