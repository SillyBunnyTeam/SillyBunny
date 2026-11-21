/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const HOME = '../../public/scripts/sillybunny-home/';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/list-shell.js', () => ({ loadListEditorStyles: jest.fn(() => Promise.resolve()) }));
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/status-page.js', () => ({ createStatusPage: jest.fn(() => ({ element: document.createElement('div') })) }));
const heroStops = [];
jest.unstable_mockModule(`${HOME}art-layout.js`, () => ({
    createArtPanel: jest.fn(() => ({ panel: document.createElement('div') })),
    createHeroArt: jest.fn(() => {
        const stop = jest.fn();
        heroStops.push(stop);
        return { panel: document.createElement('div'), stop };
    }),
}));
jest.unstable_mockModule(`${HOME}assistants-view.js`, () => ({ mountAssistants: jest.fn() }));
jest.unstable_mockModule(`${HOME}getting-started-boot.js`, () => ({}));
jest.unstable_mockModule(`${HOME}welcome-boot.js`, () => ({}));
jest.unstable_mockModule(`${HOME}menu.js`, () => ({ openHomeMenu: jest.fn() }));
jest.unstable_mockModule(`${HOME}windows.js`, () => ({
    openAbout: jest.fn(),
    openAssistantPicker: jest.fn(),
    openBundledExtras: jest.fn(),
    openGettingStarted: jest.fn(),
    openHelp: jest.fn(),
    openKeyboardShortcuts: jest.fn(),
    showWelcome: jest.fn(),
}));

const actualGettingStarted = await import(`${HOME}getting-started.js`);
let subscribers = { active: 0 };
let sharedState;
jest.unstable_mockModule(`${HOME}getting-started.js`, () => ({
    ...actualGettingStarted,
    getSharedGettingStartedState: () => sharedState,
}));
const { mountHome } = await import(`${HOME}mount.js`);

const COMPACT = 'data-sb-footer-compact';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let observers;
let frames;
let fontListeners;
let chat;
let sheld;

class FakeResizeObserver {
    constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observers.push(this);
    }

    observe() {}

    disconnect() {
        this.disconnected = true;
    }
}

function renderPanel() {
    const panel = document.createElement('div');
    panel.className = 'welcomePanel';
    panel.innerHTML = `
        <header class="sbHomeHeader">
            <h1 class="sbHomeTitle">SillyBunny</h1>
            <span class="sbHomeVersion"></span>
            <button class="sbHomeMenuButton"></button>
        </header>
        <div data-sb-home-region="hero"></div>
        <section data-sb-home-region="tiles"></section>
        <div data-sb-home-list="assistants">
            <article class="sbHomeCard"><div class="sbHomeCardFooter"><button></button></div></article>
        </div>`;
    panel.querySelector('.sbHomeCard').getClientRects = () => [{}];
    return panel;
}

function context() {
    return {
        version: 'SillyBunny 2.0.0',
        getDisplayMode: () => 'full',
        setDisplayMode: jest.fn(),
        openRecentChatsSettings: jest.fn(),
        assistants: {
            getCards: () => [],
            actions: {},
            getThumbnailUrl: () => '',
            getPickerEntries: () => [],
            setPointer: jest.fn(),
        },
    };
}

/** Mounts a panel the way Home does: made while it is detached, then put into the chat. */
function mountIntoChat(replacing = null) {
    const panel = renderPanel();
    const home = mountHome(panel, context());
    if (replacing) {
        replacing.replaceWith(panel);
    } else {
        chat.append(panel);
    }
    return { panel, home };
}

const live = () => observers.filter(observer => !observer.disconnected);

beforeEach(() => {
    observers = [];
    frames = [];
    heroStops.length = 0;
    fontListeners = new Map();
    const mine = { active: 0 };
    subscribers = mine;
    const state = actualGettingStarted.createGettingStartedState(['a', 'b']);
    sharedState = Object.create(state);
    sharedState.subscribe = (listener) => {
        mine.active++;
        const stop = state.subscribe(listener);
        return () => {
            mine.active--;
            return stop();
        };
    };
    window.ResizeObserver = FakeResizeObserver;
    window.requestAnimationFrame = (callback) => {
        frames.push(callback);
        return frames.length;
    };
    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: {
            ready: new Promise(() => {}),
            addEventListener: (type, listener) => fontListeners.set(listener, type),
            removeEventListener: (_type, listener) => fontListeners.delete(listener),
        },
    });
    sheld = document.createElement('div');
    sheld.id = 'sheld';
    chat = document.createElement('div');
    chat.id = 'chat';
    sheld.append(chat);
    document.body.append(sheld);
});

afterEach(() => {
    document.body.replaceChildren();
    delete document.fonts;
});

describe('what mountHome keeps alive for a Home panel', () => {
    test('a mounted panel holds a footer observer, a header observer, two font listeners and a tile subscription', () => {
        mountIntoChat();

        expect(live()).toHaveLength(2);
        expect(fontListeners.size).toBe(2);
        expect(subscribers.active).toBe(1);
    });

    test('all of it stops when the panel leaves the chat, as it does when a chat opens from Home', async () => {
        mountIntoChat();

        chat.replaceChildren();
        await settle();

        expect(live()).toHaveLength(0);
        expect(fontListeners.size).toBe(0);
        expect(subscribers.active).toBe(0);
    });

    test('none of it stops while Conversation covers a panel that is still in the chat, and the labels still follow a resize afterwards', async () => {
        const { panel } = mountIntoChat();
        const card = panel.querySelector('.sbHomeCard');

        sheld.setAttribute('data-sb-conversation-mode', 'on');
        document.dispatchEvent(new CustomEvent('sb:home-state-changed', { detail: { active: false } }));
        await settle();

        expect(live()).toHaveLength(2);
        expect(fontListeners.size).toBe(2);
        expect(subscribers.active).toBe(1);

        sheld.removeAttribute('data-sb-conversation-mode');
        document.dispatchEvent(new CustomEvent('sb:home-state-changed', { detail: { active: true } }));
        await settle();
        frames.splice(0).forEach(callback => callback());
        card.removeAttribute(COMPACT);
        live()[0].callback();
        frames.splice(0).forEach(callback => callback());

        expect(card.hasAttribute(COMPACT)).toBe(true);
        expect(live()).toHaveLength(2);
    });

    test('the Home state turning off with the panel gone, under Conversation, still stops everything', async () => {
        mountIntoChat();
        sheld.setAttribute('data-sb-conversation-mode', 'on');

        chat.replaceChildren();
        await settle();

        expect(live()).toHaveLength(0);
        expect(subscribers.active).toBe(0);
    });

    test('an in-place render stops the observers of the panel it replaces, and leaves one set for the new panel', async () => {
        const first = mountIntoChat();
        const second = mountIntoChat(first.panel);
        await settle();

        expect(live()).toHaveLength(2);
        expect(observers.slice(0, 2).every(observer => observer.disconnected)).toBe(true);
        expect(fontListeners.size).toBe(2);
        expect(subscribers.active).toBe(1);

        second.panel.remove();
        await settle();
        expect(live()).toHaveLength(0);
        expect(subscribers.active).toBe(0);
    });

    test('the hero art is put in its region, and its stop runs when the panel leaves the chat', async () => {
        const { panel } = mountIntoChat();

        expect(panel.querySelector('[data-sb-home-region="hero"]').children).toHaveLength(1);
        expect(heroStops).toHaveLength(1);
        expect(heroStops[0]).not.toHaveBeenCalled();

        chat.replaceChildren();
        await settle();

        expect(heroStops[0]).toHaveBeenCalledTimes(1);
    });

    test('the hero art is kept while Conversation covers the panel, and an in-place render stops the one it replaces', async () => {
        const first = mountIntoChat();
        sheld.setAttribute('data-sb-conversation-mode', 'on');
        document.dispatchEvent(new CustomEvent('sb:home-state-changed', { detail: { active: false } }));
        await settle();
        expect(heroStops[0]).not.toHaveBeenCalled();

        mountIntoChat(first.panel);
        await settle();

        expect(heroStops).toHaveLength(2);
        expect(heroStops[0]).toHaveBeenCalledTimes(1);
        expect(heroStops[1]).not.toHaveBeenCalled();
    });

    test('making the cards again keeps one footer observer, and a render after the panel left starts none that stays', async () => {
        const { panel, home } = mountIntoChat();

        home.remountAssistants();
        expect(live()).toHaveLength(2);
        expect(fontListeners.size).toBe(2);

        panel.remove();
        await settle();
        home.remountAssistants();

        expect(live()).toHaveLength(0);
        expect(fontListeners.size).toBe(0);
    });
});
