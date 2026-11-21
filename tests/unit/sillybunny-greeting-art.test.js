/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest/jsdom contracts. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { createGreetingArt } = await import('../../public/scripts/sillybunny-home/greeting-art.js');

const nextTask = () => new Promise(resolve => setTimeout(resolve));

const HOST = '<div class="mes" mesid="0"><div class="mes_block"><div class="ch_name">Name</div><div class="mes_text" style="padding-right: 24px">Hello</div></div></div>';

/** What the page measures. jsdom has no layout, so the test says how big everything is. */
const room = { chatWidth: 800, chatHeight: 659, figureWidth: 714 };
let resizeCallbacks;
let pixelRatioListeners;
let controllers;

function setPixelRatio(value) {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });
}

beforeEach(() => {
    Object.assign(room, { chatWidth: 800, chatHeight: 659, figureWidth: 714 });
    resizeCallbacks = [];
    pixelRatioListeners = [];
    controllers = [];
    setPixelRatio(1);
    globalThis.ResizeObserver = class {
        constructor(callback) {
            resizeCallbacks.push(callback);
        }

        observe() {}
        disconnect() {}
    };
    window.matchMedia = query => ({
        media: query,
        matches: false,
        addEventListener: (type, listener) => pixelRatioListeners.push(listener),
        removeEventListener: (type, listener) => pixelRatioListeners.splice(pixelRatioListeners.indexOf(listener), 1),
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get() {
            return this.classList.contains('sbGreetingArt') ? room.figureWidth : 0;
        },
    });
    document.head.innerHTML = '<style>.sbGreetingArt { padding-left: 0px; }</style>';
    document.body.className = '';
    document.body.innerHTML = `<div id="sheld"><div id="chat">${HOST}</div></div>`;
    const chat = document.getElementById('chat');
    Object.defineProperties(chat, {
        offsetWidth: { configurable: true, get: () => room.chatWidth },
        clientHeight: { configurable: true, get: () => room.chatHeight },
    });
});

afterEach(() => {
    for (const controller of controllers) controller.stop();
    delete HTMLElement.prototype.clientWidth;
    delete globalThis.ResizeObserver;
    document.body.innerHTML = '';
});

/** A controller on the page, reading a chat that the test changes through `reading`. */
function setup(overrides = {}) {
    const chatElement = document.getElementById('chat');
    const reading = {
        avatar: 'default_AssistantReisen.png',
        message: { is_user: false, is_system: false },
        messageCount: 1,
        inGroup: false,
        inConversation: false,
        ...overrides,
    };
    const openViewer = jest.fn();
    const controller = createGreetingArt({ chatElement, readChat: () => reading, openViewer, win: window });
    controllers.push(controller);
    controller.start();
    return {
        chatElement,
        reading,
        openViewer,
        controller,
        figures: () => chatElement.querySelectorAll('.sbGreetingArt'),
        image: () => chatElement.querySelector('.sbGreetingArt img'),
        figure: () => chatElement.querySelector('.sbGreetingArt'),
    };
}

describe('the greeting picture on the page', () => {
    test('is one figure between the name and the text, with a button that says what it does and has the size before the file', () => {
        const { figures, figure, image, openViewer } = setup();

        expect(figures()).toHaveLength(1);
        expect(figure().previousElementSibling.className).toBe('ch_name');
        expect(figure().nextElementSibling.className).toBe('mes_text');
        const button = figure().querySelector('button');
        expect(button.getAttribute('aria-label')).toBe('Enlarge Picture');
        expect(button.getAttribute('aria-haspopup')).toBe('dialog');
        expect(image().getAttribute('width')).toBe('768');
        expect(image().getAttribute('height')).toBe('512');
        expect(image().decoding).toBe('async');
        expect(image().alt).toBe('Early one evening, Reisen waves from her low desk among stacks of paperwork, tea and a mortar of herbs, while Tewi\'s ear peeks round the door.');
        expect(image().hasAttribute('data-sb-copy-placeholder')).toBe(false);

        button.click();
        expect(openViewer).toHaveBeenCalledTimes(1);
        expect(openViewer.mock.calls[0][0]).toMatchObject({ assistantId: 'reisen', name: 'Reisen' });
    });

    test('is the same figure however often the chat is read, and never a second one', () => {
        const { controller, figures, figure } = setup();
        const first = figure();

        controller.sync();
        controller.sync();
        controller.chatOpened('chat A');

        expect(figures()).toHaveLength(1);
        expect(figure()).toBe(first);
    });

    test('moves to the message that replaces message 0, and leaves nothing behind', async () => {
        const { chatElement, figures, figure } = setup();
        const first = figure();

        chatElement.innerHTML = HOST;
        await nextTask();

        expect(figures()).toHaveLength(1);
        expect(figure()).not.toBe(first);
        expect(first.isConnected).toBe(false);
    });

    test('is not put on a message that is not message 0, and is taken away when the chat stops calling for it', () => {
        const { controller, reading, figures } = setup();

        reading.avatar = 'default_Seraphina.png';
        controller.sync();
        expect(figures()).toHaveLength(0);

        reading.avatar = 'default_AssistantTewi.png';
        controller.sync();
        expect(figures()).toHaveLength(1);
        expect(figures()[0].dataset.sbGreetingArt).toBe('tewi');

        controller.sync();
        expect(figures()).toHaveLength(1);
    });

    test('is not put on a chat whose first message is a later message of a long chat', () => {
        document.getElementById('chat').innerHTML = HOST.replace('mesid="0"', 'mesid="12"');
        const { figures } = setup();

        expect(figures()).toHaveLength(0);
    });

    test('goes when the app enters Conversation and comes back when it leaves it', async () => {
        const { reading, figures } = setup();
        const shell = document.getElementById('sheld');
        expect(figures()).toHaveLength(1);

        reading.inConversation = true;
        shell.setAttribute('data-sb-conversation-mode', 'on');
        await nextTask();
        expect(figures()).toHaveLength(0);

        reading.inConversation = false;
        shell.removeAttribute('data-sb-conversation-mode');
        await nextTask();
        expect(figures()).toHaveLength(1);
    });

    test('is found on message 0 when something else comes before it in the chat', () => {
        document.getElementById('chat').innerHTML = `<div class="welcomePanel"></div>${HOST}`;
        const { figures } = setup();

        expect(figures()).toHaveLength(1);
    });

    test('is taken off the page by stop, and a chat that is printed afterwards gets none', async () => {
        const { controller, chatElement, figures } = setup();

        controller.stop();
        expect(figures()).toHaveLength(0);

        chatElement.innerHTML = HOST;
        await nextTask();
        expect(figures()).toHaveLength(0);
    });
});

describe('the size of the greeting picture', () => {
    test('is chosen for the column and the height of the chat at the time that the picture is put there', () => {
        const { image, figure } = setup();

        expect(image().style.width).toBe('690px');
        expect(image().getAttribute('src')).toBe('/img/sillybunny/greeting-reisen@2x.webp');
        expect(figure().dataset.sbScale).toBe('smooth');
    });

    test('follows the right padding of the text, which differs between chat styles', () => {
        const { figure, chatElement } = setup();
        expect(figure().style.paddingRight).toBe('24px');

        chatElement.querySelector('.mes_text').style.paddingRight = '10px';
        document.dispatchEvent(new CustomEvent('sb:chat-style-updated'));

        expect(figure().style.paddingRight).toBe('10px');
    });

    test('does not change when only the height of the chat changes, as it does when a person types', () => {
        const { image } = setup();
        const before = image().style.width;

        room.chatHeight = 300;
        for (const callback of resizeCallbacks) callback();

        expect(image().style.width).toBe(before);
    });

    test('changes when the width of the chat changes, and takes the height it has then', () => {
        const { image } = setup();

        room.chatHeight = 300;
        room.chatWidth = 700;
        room.figureWidth = 614;
        for (const callback of resizeCallbacks) callback();

        expect(image().style.width).toBe('315px');
    });

    test('changes when the pixel ratio changes, and listens again for the next change', () => {
        room.figureWidth = 1424;
        room.chatWidth = 1500;
        room.chatHeight = 1100;
        const { figure, image } = setup();
        expect(figure().dataset.sbScale).toBe('smooth');

        setPixelRatio(2);
        pixelRatioListeners.at(-1)();

        expect(figure().dataset.sbScale).toBe('pixel');
        expect(figure().dataset.sbPixelStep).toBe('3');
        expect(image().getAttribute('src')).toBe('/img/sillybunny/greeting-reisen.webp');
        expect(pixelRatioListeners).toHaveLength(1);
    });

    test('changes on a resize of the window that came with a new pixel ratio, with no media query event', () => {
        room.figureWidth = 1424;
        room.chatWidth = 1500;
        room.chatHeight = 1100;
        const { figure } = setup();

        setPixelRatio(2);
        window.dispatchEvent(new Event('resize'));

        expect(figure().dataset.sbScale).toBe('pixel');
    });

    test('does not change on a resize of the window that came with the same pixel ratio and a new height', () => {
        const { image } = setup();
        const before = image().style.width;

        room.chatHeight = 300;
        window.dispatchEvent(new Event('resize'));

        expect(image().style.width).toBe(before);
    });

    test('changes when Visual Novel mode is switched on or off, which changes the height and not the width', async () => {
        const { image } = setup();

        room.chatHeight = 173;
        document.body.classList.add('waifuMode');
        await nextTask();
        expect(image().style.width).toBe(`${(173 * 0.7 * 768) / 512}px`);

        room.chatHeight = 659;
        document.body.classList.remove('waifuMode');
        await nextTask();
        expect(image().style.width).toBe('690px');
    });

    test('does not change when a class that has nothing to do with the room changes on the body', async () => {
        const { image } = setup();
        room.chatHeight = 173;

        document.body.classList.add('something-else');
        await nextTask();

        expect(image().style.width).toBe('690px');
    });

    test('changes when the chat style changes', () => {
        const { image } = setup();

        room.chatHeight = 400;
        document.dispatchEvent(new CustomEvent('sb:chat-style-updated'));

        expect(image().style.width).toBe(`${(400 * 0.7 * 768) / 512}px`);
    });
});
