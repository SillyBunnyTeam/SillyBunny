/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { beginPanelLifetime } from '../../public/scripts/sillybunny-home/panel-lifetime.js';

/** Waits for the callbacks of a MutationObserver. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let chat;

function addPanel() {
    const panel = document.createElement('div');
    panel.className = 'welcomePanel';
    chat.append(panel);
    return panel;
}

beforeEach(() => {
    chat = document.createElement('div');
    chat.id = 'chat';
    document.body.append(chat);
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('the lifetime of a Home panel', () => {
    test('runs every stop once the panel leaves the chat, and watches nothing after that', async () => {
        const panel = addPanel();
        const lifetime = beginPanelLifetime(panel);
        const footers = jest.fn();
        const header = jest.fn();
        lifetime.keep('footers', footers);
        lifetime.keep('header', header);

        panel.remove();
        await settle();

        expect(footers).toHaveBeenCalledTimes(1);
        expect(header).toHaveBeenCalledTimes(1);

        chat.append(panel);
        panel.remove();
        await settle();
        expect(footers).toHaveBeenCalledTimes(1);
    });

    test('ends when the chat is emptied, as opening a chat does', async () => {
        const panel = addPanel();
        const lifetime = beginPanelLifetime(panel);
        const stop = jest.fn();
        lifetime.keep('footers', stop);

        chat.replaceChildren();
        await settle();

        expect(stop).toHaveBeenCalledTimes(1);
    });

    test('keeps a panel that is still in the chat, whatever else the chat gains or loses', async () => {
        const panel = addPanel();
        const lifetime = beginPanelLifetime(panel);
        const stop = jest.fn();
        lifetime.keep('footers', stop);

        const message = document.createElement('div');
        chat.append(message);
        message.remove();
        await settle();

        expect(stop).not.toHaveBeenCalled();
    });

    test('keeps a panel that is moved inside the chat, which removes and adds it in one step', async () => {
        const panel = addPanel();
        addPanel();
        const lifetime = beginPanelLifetime(panel);
        const stop = jest.fn();
        lifetime.keep('footers', stop);

        chat.append(panel);
        await settle();

        expect(stop).not.toHaveBeenCalled();
    });

    test('does not hear the Home state, which turns off while Conversation covers a panel that is still in the chat', async () => {
        const sheld = document.createElement('div');
        sheld.id = 'sheld';
        document.body.append(sheld);
        const panel = addPanel();
        const lifetime = beginPanelLifetime(panel);
        const stop = jest.fn();
        lifetime.keep('footers', stop);

        sheld.setAttribute('data-sb-conversation-mode', 'on');
        document.dispatchEvent(new CustomEvent('sb:home-state-changed', { detail: { active: false } }));
        await settle();

        expect(stop).not.toHaveBeenCalled();

        sheld.removeAttribute('data-sb-conversation-mode');
        document.dispatchEvent(new CustomEvent('sb:home-state-changed', { detail: { active: true } }));
        panel.remove();
        await settle();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    test('ends after Conversation covered the panel, when a chat then empties the chat', async () => {
        const sheld = document.createElement('div');
        sheld.id = 'sheld';
        sheld.setAttribute('data-sb-conversation-mode', 'on');
        document.body.append(sheld);
        const panel = addPanel();
        const lifetime = beginPanelLifetime(panel);
        const stop = jest.fn();
        lifetime.keep('footers', stop);

        chat.replaceChildren();
        await settle();

        expect(stop).toHaveBeenCalledTimes(1);
    });

    test('waits for a panel that is not in the chat yet, and ends when it is removed after it came in', async () => {
        const panel = document.createElement('div');
        const lifetime = beginPanelLifetime(panel);
        const stop = jest.fn();
        lifetime.keep('footers', stop);

        const other = document.createElement('div');
        chat.append(other);
        other.remove();
        await settle();
        expect(stop).not.toHaveBeenCalled();

        chat.append(panel);
        await settle();
        expect(stop).not.toHaveBeenCalled();

        panel.remove();
        await settle();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    test('ends a panel that comes in and goes out before the chat is observed', async () => {
        const panel = document.createElement('div');
        const lifetime = beginPanelLifetime(panel);
        const stop = jest.fn();
        lifetime.keep('footers', stop);

        chat.append(panel);
        panel.remove();
        await settle();

        expect(stop).toHaveBeenCalledTimes(1);
    });
});

describe('replacing a panel', () => {
    test('a new lifetime stops the one before it at once, before the old panel leaves the chat', () => {
        const old = addPanel();
        const stopOld = jest.fn();
        beginPanelLifetime(old).keep('footers', stopOld);

        beginPanelLifetime(document.createElement('div'));

        expect(stopOld).toHaveBeenCalledTimes(1);
        expect(chat.contains(old)).toBe(true);
    });

    test('the old panel is no longer watched, and its removal leaves the new lifetime alone', async () => {
        const old = addPanel();
        const stopOld = jest.fn();
        beginPanelLifetime(old).keep('footers', stopOld);
        const next = document.createElement('div');
        const stopNext = jest.fn();
        beginPanelLifetime(next).keep('footers', stopNext);

        old.replaceWith(next);
        await settle();

        expect(stopOld).toHaveBeenCalledTimes(1);
        expect(stopNext).not.toHaveBeenCalled();

        next.remove();
        await settle();
        expect(stopNext).toHaveBeenCalledTimes(1);
        expect(stopOld).toHaveBeenCalledTimes(1);
    });
});

describe('what a lifetime keeps', () => {
    test('a slot that is kept again stops its earlier stop first, and only that one', async () => {
        const panel = addPanel();
        const lifetime = beginPanelLifetime(panel);
        const first = jest.fn();
        const other = jest.fn();
        const second = jest.fn();
        lifetime.keep('footers', first);
        lifetime.keep('header', other);

        lifetime.keep('footers', second);

        expect(first).toHaveBeenCalledTimes(1);
        expect(other).not.toHaveBeenCalled();
        expect(second).not.toHaveBeenCalled();

        panel.remove();
        await settle();
        expect(second).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledTimes(1);
    });

    test('a lifetime that ended stops each stop once, however the next panel begins', async () => {
        const panel = addPanel();
        const stop = jest.fn();
        beginPanelLifetime(panel).keep('footers', stop);

        panel.remove();
        await settle();
        beginPanelLifetime(document.createElement('div'));

        expect(stop).toHaveBeenCalledTimes(1);
    });

    test('a stop that is kept after the end runs at once, so a late render leaves no observer behind', async () => {
        const panel = addPanel();
        const lifetime = beginPanelLifetime(panel);
        panel.remove();
        await settle();
        const stop = jest.fn();

        lifetime.keep('footers', stop);

        expect(stop).toHaveBeenCalledTimes(1);
    });

    test('a stop that throws does not keep the others from running', async () => {
        const panel = addPanel();
        const lifetime = beginPanelLifetime(panel);
        const after = jest.fn();
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        lifetime.keep('footers', () => { throw new Error('boom'); });
        lifetime.keep('header', after);

        panel.remove();
        await settle();

        expect(after).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    test('works without a chat to watch, and still stops when the next panel begins', () => {
        chat.remove();
        const stop = jest.fn();
        beginPanelLifetime(document.createElement('div')).keep('footers', stop);

        beginPanelLifetime(document.createElement('div'));

        expect(stop).toHaveBeenCalledTimes(1);
    });
});
