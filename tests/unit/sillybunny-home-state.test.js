/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const { initHomeState, isHomeActive } = await import('../../public/scripts/sillybunny-home-state.js');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let chat;
let sheld;
let listener;

function createWelcomePanel() {
    const panel = document.createElement('div');
    panel.className = 'welcomePanel';
    return panel;
}

beforeEach(() => {
    document.body.innerHTML = '<div id="sheld"><div id="chat"></div></div>';
    chat = document.getElementById('chat');
    sheld = document.getElementById('sheld');
    initHomeState({ chat, sheld });
    listener = jest.fn();
    document.addEventListener('sb:home-state-changed', listener);
});

afterEach(async () => {
    document.removeEventListener('sb:home-state-changed', listener);
    chat.replaceChildren();
    sheld.removeAttribute('data-sb-conversation-mode');
    await settle();
});

describe('Home state', () => {
    test('is inactive while #chat has no welcome panel', async () => {
        chat.append(document.createElement('div'));
        await settle();

        expect(isHomeActive()).toBe(false);
        expect(sheld.hasAttribute('data-sb-home')).toBe(false);
        expect(listener).not.toHaveBeenCalled();
    });

    test('becomes active when #chat gets a welcome panel', async () => {
        chat.append(createWelcomePanel());
        await settle();

        expect(isHomeActive()).toBe(true);
        expect(sheld.getAttribute('data-sb-home')).toBe('on');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].detail).toEqual({ active: true });
    });

    test('clears when the welcome panel is removed', async () => {
        const panel = createWelcomePanel();
        chat.append(panel);
        await settle();
        listener.mockClear();

        panel.remove();
        await settle();

        expect(isHomeActive()).toBe(false);
        expect(sheld.hasAttribute('data-sb-home')).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].detail).toEqual({ active: false });
    });

    test('clears while Conversation mode is on and returns when it turns off with the panel still present', async () => {
        chat.append(createWelcomePanel());
        await settle();
        listener.mockClear();

        sheld.setAttribute('data-sb-conversation-mode', 'on');
        await settle();

        expect(isHomeActive()).toBe(false);
        expect(sheld.hasAttribute('data-sb-home')).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].detail).toEqual({ active: false });

        sheld.removeAttribute('data-sb-conversation-mode');
        await settle();

        expect(isHomeActive()).toBe(true);
        expect(sheld.getAttribute('data-sb-home')).toBe('on');
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener.mock.calls[1][0].detail).toEqual({ active: true });
    });

    test('ignores Conversation mode values other than "on"', async () => {
        chat.append(createWelcomePanel());
        sheld.setAttribute('data-sb-conversation-mode', 'off');
        await settle();

        expect(isHomeActive()).toBe(true);
    });

    test('does not count a welcome panel that is not a direct child of #chat', async () => {
        const wrapper = document.createElement('div');
        wrapper.append(createWelcomePanel());
        chat.append(wrapper);
        await settle();

        expect(isHomeActive()).toBe(false);
    });

    test('reports one change for several mutations in the same turn', async () => {
        chat.append(createWelcomePanel(), document.createElement('div'));
        chat.append(document.createElement('div'));
        await settle();

        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('stays active and silent while the welcome panel is replaced', async () => {
        const panel = createWelcomePanel();
        chat.append(panel);
        await settle();
        listener.mockClear();

        panel.replaceWith(createWelcomePanel());
        await settle();

        expect(isHomeActive()).toBe(true);
        expect(sheld.getAttribute('data-sb-home')).toBe('on');
        expect(listener).not.toHaveBeenCalled();
    });

    test('stays silent for mutations that do not change the state', async () => {
        chat.append(createWelcomePanel());
        await settle();
        listener.mockClear();

        chat.append(document.createElement('div'));
        sheld.setAttribute('data-sb-conversation-mode', 'off');
        await settle();

        expect(listener).not.toHaveBeenCalled();
    });

    test('initialising twice does not double the events', async () => {
        initHomeState({ chat, sheld });
        chat.append(createWelcomePanel());
        await settle();

        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('moves to new elements and takes the attribute from the old shell while Home stays active', async () => {
        chat.append(createWelcomePanel());
        await settle();
        listener.mockClear();

        const nextSheld = document.createElement('div');
        const nextChat = document.createElement('div');
        nextChat.append(createWelcomePanel());
        nextSheld.append(nextChat);
        initHomeState({ chat: nextChat, sheld: nextSheld });
        await settle();

        expect(sheld.hasAttribute('data-sb-home')).toBe(false);
        expect(nextSheld.getAttribute('data-sb-home')).toBe('on');
        expect(isHomeActive()).toBe(true);
        expect(listener).not.toHaveBeenCalled();

        chat.append(createWelcomePanel());
        chat.append(document.createElement('div'));
        await settle();
        expect(listener).not.toHaveBeenCalled();

        nextChat.replaceChildren();
        await settle();
        expect(nextSheld.hasAttribute('data-sb-home')).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].detail).toEqual({ active: false });
    });

    test('reports the change when it moves to elements that are not Home', async () => {
        chat.append(createWelcomePanel());
        await settle();
        listener.mockClear();

        const nextSheld = document.createElement('div');
        const nextChat = document.createElement('div');
        nextSheld.append(nextChat);
        initHomeState({ chat: nextChat, sheld: nextSheld });
        await settle();

        expect(sheld.hasAttribute('data-sb-home')).toBe(false);
        expect(nextSheld.hasAttribute('data-sb-home')).toBe(false);
        expect(isHomeActive()).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].detail).toEqual({ active: false });
    });

    test('is inactive when #chat is missing', async () => {
        chat.append(createWelcomePanel());
        await settle();
        listener.mockClear();

        document.body.innerHTML = '<div id="sheld"></div>';
        initHomeState();
        await settle();

        expect(isHomeActive()).toBe(false);
        expect(document.getElementById('sheld').hasAttribute('data-sb-home')).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('works without #sheld, because Conversation mode cannot be on there', async () => {
        document.body.innerHTML = '<div id="chat"></div>';
        initHomeState();
        document.getElementById('chat').append(createWelcomePanel());
        await settle();

        expect(isHomeActive()).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].detail).toEqual({ active: true });
    });

    test('is inactive and silent when neither element exists', async () => {
        document.body.innerHTML = '';
        initHomeState();
        await settle();

        expect(isHomeActive()).toBe(false);
        expect(listener).not.toHaveBeenCalled();
    });

    test('reads the document before it is initialised', async () => {
        jest.resetModules();
        const fresh = await import('../../public/scripts/sillybunny-home-state.js?fresh');
        document.body.innerHTML = '<div id="sheld"><div id="chat"></div></div>';
        document.getElementById('chat').append(createWelcomePanel());

        expect(fresh.isHomeActive()).toBe(true);

        document.getElementById('sheld').setAttribute('data-sb-conversation-mode', 'on');
        expect(fresh.isHomeActive()).toBe(false);
    });

    test('applies the state that already exists when it starts', async () => {
        const freshChat = document.createElement('div');
        freshChat.append(createWelcomePanel());
        const freshSheld = document.createElement('div');
        freshSheld.append(freshChat);

        initHomeState({ chat: freshChat, sheld: freshSheld });

        expect(isHomeActive()).toBe(true);
        expect(freshSheld.getAttribute('data-sb-home')).toBe('on');
        expect(listener).toHaveBeenCalledTimes(1);

        freshChat.replaceChildren();
        await settle();
        expect(isHomeActive()).toBe(false);
    });
});
