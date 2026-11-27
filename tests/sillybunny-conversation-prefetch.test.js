/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const PARTS = '../public/scripts/sillybunny-conversation/lazy-parts.js';
const CHROME = '../public/scripts/sillybunny-conversation/chrome.js';
const RUNTIME = '../public/scripts/sillybunny-conversation/runtime.js';
const CONTEXT = '../public/scripts/sillybunny-conversation/context.js';

const settleLoad = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the prefetch of the workspace', () => {
    let parts;
    let chrome;
    let runtime;
    let chromeImports;
    let failFirstImport;
    let unbind;

    function control(id, tag = 'button') {
        const element = document.createElement(tag);
        element.id = id;
        element.innerHTML = '<i class="fa-solid fa-masks-theater"></i>';
        document.body.append(element);
        return element;
    }

    function send(type, element) {
        element.dispatchEvent(new Event(type, { bubbles: true }));
    }

    beforeEach(async () => {
        jest.resetModules();
        document.body.replaceChildren();
        chromeImports = 0;
        failFirstImport = false;
        chrome = {
            disableConversationModeForCurrentCharacter: jest.fn(),
            getDefaultConversationAvatar: jest.fn(() => 'default.png'),
            openConversationWorkspaceForAvatar: jest.fn(async () => true),
            openConversationWorkspaceFromWelcome: jest.fn(async () => true),
            selectConversation: jest.fn(async () => true),
        };
        runtime = {
            installConversationReplyStream: jest.fn(),
            startConversationWorker: jest.fn(),
        };
        await jest.unstable_mockModule(CONTEXT, () => ({ getConversationPersonaId: () => 'persona.png' }));
        await jest.unstable_mockModule(CHROME, () => {
            chromeImports += 1;
            if (failFirstImport && chromeImports === 1) {
                throw new Error('offline');
            }
            return chrome;
        });
        await jest.unstable_mockModule(RUNTIME, () => runtime);
        parts = await import(PARTS);
        unbind = parts.bindWorkspacePrefetch(window);
    });

    afterEach(() => unbind());

    test('loads the workspace and the runtime once when the pointer, the focus or a touch reaches the mode toggle, and opens nothing', async () => {
        const toggle = control('sb-mode-toggle');

        send('pointerover', toggle.firstChild);
        send('focusin', toggle);
        send('touchstart', toggle);
        send('pointerover', toggle);
        await settleLoad();

        expect(chromeImports).toBe(1);
        expect(runtime.installConversationReplyStream).toHaveBeenCalledTimes(1);
        expect(parts.conversationWorkspace.loaded).not.toBeNull();
        expect(chrome.selectConversation).not.toHaveBeenCalled();
        expect(chrome.openConversationWorkspaceForAvatar).not.toHaveBeenCalled();
        expect(chrome.disableConversationModeForCurrentCharacter).not.toHaveBeenCalled();
        expect(runtime.startConversationWorker).not.toHaveBeenCalled();
    });

    test('follows the menu of the mode toggle, which is built when it opens', async () => {
        const menu = control('sb-mode-menu', 'div');

        send('pointerover', menu);
        await settleLoad();

        expect(chromeImports).toBe(1);
    });

    test('fetches nothing for the rest of the page, and nothing before the user comes near the toggle', async () => {
        const toggle = control('sb-mode-toggle');
        const elsewhere = control('send_but');

        send('pointerover', elsewhere);
        send('focusin', elsewhere);
        send('touchstart', document.body);
        await settleLoad();

        expect(toggle.isConnected).toBe(true);
        expect(chromeImports).toBe(0);
        expect(parts.conversationWorkspace.loaded).toBeNull();
        expect(runtime.installConversationReplyStream).not.toHaveBeenCalled();
    });

    test('is tried again by the next approach when the workspace could not be fetched', async () => {
        failFirstImport = true;
        const toggle = control('sb-mode-toggle');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        send('pointerover', toggle);
        await settleLoad();
        expect(parts.conversationWorkspace.loaded).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);

        send('pointerover', toggle);
        await settleLoad();
        expect(parts.conversationWorkspace.loaded).not.toBeNull();
        expect(chromeImports).toBe(2);
        warn.mockRestore();
    });

    test('leaves the open that follows to run at once, because the workspace is loaded', async () => {
        send('pointerover', control('sb-mode-toggle'));
        await settleLoad();

        const opened = parts.selectConversation('char.png', { chatId: 'main' });

        expect(chrome.selectConversation).toHaveBeenCalledWith('char.png', { chatId: 'main' });
        await expect(opened).resolves.toBe(true);
        expect(chromeImports).toBe(1);
    });
});
