/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the window openers. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { HOME_COPY } from '../helpers/copy-home.js';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));

const openGettingStartedWindow = jest.fn();
const openBundledExtrasWindow = jest.fn();
const openAssistantPickerWindow = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-home/getting-started-window.js', () => ({ openGettingStartedWindow }));
jest.unstable_mockModule('../../public/scripts/sillybunny-home/bundled-extras-window.js', () => ({ openBundledExtrasWindow }));
jest.unstable_mockModule('../../public/scripts/sillybunny-home/assistant-picker.js', () => ({ openAssistantPickerWindow }));
const { focusFirstHomeTile, openAssistantPicker, openBundledExtras, openGettingStarted } = await import('../../public/scripts/sillybunny-home/windows.js');

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function openWindow() {
    let close;
    const closed = new Promise((resolve) => { close = resolve; });
    return { handle: { closed }, close };
}

beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    window.toastr = { error: jest.fn() };
});

afterEach(() => {
    jest.restoreAllMocks();
    openGettingStartedWindow.mockReset();
    openBundledExtrasWindow.mockReset();
    openAssistantPickerWindow.mockReset();
    delete window.toastr;
});

describe('Home window openers', () => {
    test('a second activation while the window is open does nothing, and the window opens again once it closed', async () => {
        const first = openWindow();
        openGettingStartedWindow.mockResolvedValueOnce(first.handle);

        openGettingStarted();
        openGettingStarted();
        await flush();

        expect(openGettingStartedWindow).toHaveBeenCalledTimes(1);

        first.close();
        await flush();
        const second = openWindow();
        openGettingStartedWindow.mockResolvedValueOnce(second.handle);
        openGettingStarted();
        await flush();

        expect(openGettingStartedWindow).toHaveBeenCalledTimes(2);
        second.close();
        await flush();
    });

    test('Bundled Extras opens its window with no options, whatever the activation passed, and once at a time', async () => {
        const first = openWindow();
        openBundledExtrasWindow.mockResolvedValueOnce(first.handle);

        openBundledExtras({ type: 'click' });
        openBundledExtras();
        await flush();

        expect(openBundledExtrasWindow).toHaveBeenCalledTimes(1);
        expect(openBundledExtrasWindow).toHaveBeenCalledWith();
        first.close();
        await flush();
        const second = openWindow();
        openBundledExtrasWindow.mockResolvedValueOnce(second.handle);

        openBundledExtras();
        await flush();

        expect(openBundledExtrasWindow).toHaveBeenCalledTimes(2);
        second.close();
        await flush();
    });

    test('the picker receives what it was asked to use, opens once at a time, and opens again after it closed', async () => {
        const options = { getEntries: jest.fn(), getThumbnailUrl: jest.fn(), choose: jest.fn() };
        const first = openWindow();
        openAssistantPickerWindow.mockResolvedValueOnce(first.handle);

        openAssistantPicker(options);
        openAssistantPicker(options);
        await flush();

        expect(openAssistantPickerWindow).toHaveBeenCalledTimes(1);
        expect(openAssistantPickerWindow).toHaveBeenCalledWith(options);
        first.close();
        await flush();
        const second = openWindow();
        openAssistantPickerWindow.mockResolvedValueOnce(second.handle);
        openAssistantPicker(options);
        await flush();

        expect(openAssistantPickerWindow).toHaveBeenCalledTimes(2);
        second.close();
        await flush();
    });

    test('the picker that fails to load is named in the error, so the log says which window it was', async () => {
        openAssistantPickerWindow.mockRejectedValueOnce(new Error('load failed'));

        openAssistantPicker({});
        await flush();

        expect(console.error).toHaveBeenCalledWith('Could not open the Choose Assistant window.', expect.any(Error));
    });

    test('a window that fails to load logs the error, toasts the error, and can be tried again', async () => {
        openGettingStartedWindow.mockRejectedValueOnce(new Error('load failed'));

        openGettingStarted();
        await flush();

        expect(console.error).toHaveBeenCalledWith('Could not open the Getting Started window.', expect.any(Error));
        expect(window.toastr.error).toHaveBeenCalledWith(HOME_COPY.windowLoadError);
        const retry = openWindow();
        openGettingStartedWindow.mockResolvedValueOnce(retry.handle);
        openGettingStarted();
        await flush();

        expect(openGettingStartedWindow).toHaveBeenCalledTimes(2);
        retry.close();
        await flush();
    });

    describe('the first tile of Home', () => {
        test('takes focus, and a window that closes after it leaves it there', async () => {
            document.body.innerHTML = `<div id="chat"><div class="welcomePanel">
                <button class="sbHomeMenuButton">Menu</button>
                <button class="sbHomeTile" data-sb-home-key="help">Help</button>
                <button class="sbHomeTile" data-sb-home-key="extras">Extras</button>
            </div></div><button id="opener">Opener</button>`;
            const opener = document.getElementById('opener');
            const open = openWindow();
            openGettingStartedWindow.mockResolvedValueOnce(open.handle);
            opener.focus();
            openGettingStarted();
            await flush();
            opener.remove();

            expect(focusFirstHomeTile()).toBe(true);
            open.close();
            await flush();

            expect(document.activeElement).toBe(document.querySelector('[data-sb-home-key="help"]'));
        });

        test('is nothing when Home has no tile', () => {
            document.body.innerHTML = '<div id="chat"></div>';

            expect(focusFirstHomeTile()).toBe(false);
        });
    });

    describe('focus after a Home render replaced the opener', () => {
        function renderPanel() {
            document.body.innerHTML = `<div id="chat"><div class="welcomePanel">
                <button class="sbHomeMenuButton">Menu</button>
                <button class="sbHomeTile" data-sb-home-key="getting-started">Getting Started</button>
                <article class="sbHomeCard" data-sb-home-key="assistant-own"><button class="sbHomeCardOpen">Choose</button></article>
            </div></div>`;
            return document.querySelector('.welcomePanel');
        }

        async function openAndRender(opener, replace) {
            const open = openWindow();
            openGettingStartedWindow.mockResolvedValueOnce(open.handle);
            opener.focus();
            openGettingStarted();
            await flush();
            replace();
            open.close();
            await flush();
        }

        test.each([
            ['a tile', '.sbHomeTile', '.sbHomeTile'],
            ['a card', '.sbHomeCardOpen', '.sbHomeCardOpen'],
        ])('goes to the same %s in the new panel', async (_, openerSelector, expectedSelector) => {
            const first = renderPanel();
            await openAndRender(first.querySelector(openerSelector), renderPanel);

            expect(document.activeElement).toBe(document.querySelector(expectedSelector));
            expect(document.activeElement.isConnected).toBe(true);
        });

        test('goes to the main menu button when the tile is gone from the new panel', async () => {
            const first = renderPanel();
            await openAndRender(first.querySelector('.sbHomeTile'), () => {
                renderPanel().querySelector('.sbHomeTile').remove();
            });

            expect(document.activeElement).toBe(document.querySelector('.sbHomeMenuButton'));
        });

        test('goes to the main menu button when the window came from the menu', async () => {
            const first = renderPanel();
            const menuItem = document.createElement('button');
            document.body.append(menuItem);
            await openAndRender(menuItem, () => {
                menuItem.remove();
                renderPanel();
            });

            expect(first.isConnected).toBe(false);
            expect(document.activeElement).toBe(document.querySelector('.sbHomeMenuButton'));
        });

        test('leaves focus alone while the opener is still in the document', async () => {
            const panel = renderPanel();
            const tile = panel.querySelector('.sbHomeTile');
            const other = panel.querySelector('.sbHomeMenuButton');
            await openAndRender(tile, () => other.focus());

            expect(document.activeElement).toBe(other);
        });

        test('leaves focus alone when the opener is gone but focus is already on a control of Home', async () => {
            const panel = renderPanel();
            const tile = panel.querySelector('.sbHomeTile');
            const help = document.createElement('button');
            panel.append(help);
            await openAndRender(tile, () => {
                tile.remove();
                help.focus();
            });

            expect(document.activeElement).toBe(help);
        });

        test('does nothing when there is no Home panel', async () => {
            document.body.innerHTML = '<button id="elsewhere">Elsewhere</button>';
            const elsewhere = document.getElementById('elsewhere');
            await openAndRender(elsewhere, () => elsewhere.remove());

            expect(document.activeElement).toBe(document.body);
        });
    });
});
