/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the window openers. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const openGettingStartedWindow = jest.fn();
const openBundledExtrasWindow = jest.fn();
jest.unstable_mockModule('../../public/scripts/sillybunny-home/getting-started-window.js', () => ({ openGettingStartedWindow }));
jest.unstable_mockModule('../../public/scripts/sillybunny-home/bundled-extras-window.js', () => ({ openBundledExtrasWindow }));
const { openBundledExtras, openGettingStarted } = await import('../../public/scripts/sillybunny-home/windows.js');

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function openWindow() {
    let close;
    const closed = new Promise((resolve) => { close = resolve; });
    return { handle: { closed }, close };
}

let toastMessage;

beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    toastMessage = document.createElement('div');
    window.toastr = {
        error: jest.fn(() => ({
            find: () => ({ attr: attributes => Object.entries(attributes).forEach(([name, value]) => toastMessage.setAttribute(name, value)) }),
        })),
    };
});

afterEach(() => {
    jest.restoreAllMocks();
    openGettingStartedWindow.mockReset();
    openBundledExtrasWindow.mockReset();
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

    test('Bundled Extras receives the group it was asked to open at, and none from a plain activation', async () => {
        const first = openWindow();
        openBundledExtrasWindow.mockResolvedValueOnce(first.handle);

        openBundledExtras({ group: 'assistants' });
        await flush();

        expect(openBundledExtrasWindow).toHaveBeenLastCalledWith({ group: 'assistants' });
        first.close();
        await flush();
        const second = openWindow();
        openBundledExtrasWindow.mockResolvedValueOnce(second.handle);

        openBundledExtras();
        await flush();

        expect(openBundledExtrasWindow).toHaveBeenLastCalledWith(undefined);
        second.close();
        await flush();
    });

    test('a window that fails to load logs the error, toasts a marked placeholder, and can be tried again', async () => {
        openGettingStartedWindow.mockRejectedValueOnce(new Error('load failed'));

        openGettingStarted();
        await flush();

        expect(console.error).toHaveBeenCalledWith('Could not open the Getting Started window.', expect.any(Error));
        expect(window.toastr.error).toHaveBeenCalledWith('TODO(copy)');
        expect(toastMessage.dataset.sbCopyPlaceholder).toBe('true');
        expect(toastMessage.dataset.sbCopySlot).toBe('HOME-WINDOW-LOAD-ERROR');
        const retry = openWindow();
        openGettingStartedWindow.mockResolvedValueOnce(retry.handle);
        openGettingStarted();
        await flush();

        expect(openGettingStartedWindow).toHaveBeenCalledTimes(2);
        retry.close();
        await flush();
    });

    describe('focus after a Home render replaced the opener', () => {
        function renderPanel() {
            document.body.innerHTML = `<div id="chat"><div class="welcomePanel">
                <button class="sbHomeMenuButton">Menu</button>
                <button class="sbHomeTile" data-sb-home-key="getting-started">Getting Started</button>
                <article class="sbHomeCard" data-sb-home-key="assistants-more"><button class="sbHomeCardOpen">More</button></article>
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

        test('does nothing when there is no Home panel', async () => {
            document.body.innerHTML = '<button id="elsewhere">Elsewhere</button>';
            const elsewhere = document.getElementById('elsewhere');
            await openAndRender(elsewhere, () => elsewhere.remove());

            expect(document.activeElement).toBe(document.body);
        });
    });
});
