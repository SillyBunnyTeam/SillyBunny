import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const PARTS = '../public/scripts/sillybunny-conversation/lazy-parts.js';
const CHROME = '../public/scripts/sillybunny-conversation/chrome.js';
const RUNTIME = '../public/scripts/sillybunny-conversation/runtime.js';
const CONTEXT = '../public/scripts/sillybunny-conversation/context.js';

function createDeferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('createLazyPart', () => {
    let createLazyPart;

    beforeEach(async () => {
        jest.resetModules();
        await jest.unstable_mockModule(CONTEXT, () => ({ getConversationPersonaId: () => 'persona.png' }));
        ({ createLazyPart } = await import(PARTS));
    });

    test('imports the part once, however many calls ask for it', async () => {
        const importPart = jest.fn(async () => ({ name: 'part' }));
        const part = createLazyPart(importPart);

        expect(part.loaded).toBeNull();
        const [first, second] = await Promise.all([part.load(), part.load()]);

        expect(first).toBe(second);
        expect(importPart).toHaveBeenCalledTimes(1);
        expect(part.loaded).toBe(first);
        await part.load();
        expect(importPart).toHaveBeenCalledTimes(1);
    });

    test('forgets a failed import, so that the next call tries again', async () => {
        const importPart = jest.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ name: 'part' });
        const part = createLazyPart(importPart);

        await expect(part.load()).rejects.toThrow('offline');
        expect(part.loaded).toBeNull();
        await expect(part.load()).resolves.toEqual({ name: 'part' });
        expect(importPart).toHaveBeenCalledTimes(2);
    });
});

describe('the functions of the startup that reach the workspace and the runtime', () => {
    let parts;
    let chrome;
    let runtime;
    let chromeLoaded;

    beforeEach(async () => {
        jest.resetModules();
        chromeLoaded = createDeferred();
        chrome = {
            disableConversationModeForCurrentCharacter: jest.fn(),
            getDefaultConversationAvatar: jest.fn(() => 'default.png'),
            openConversationWorkspaceForAvatar: jest.fn(async () => true),
            openConversationWorkspaceFromWelcome: jest.fn(async () => true),
            selectConversation: jest.fn(async () => true),
        };
        runtime = {
            handleRoleplayCharacterMessage: jest.fn(),
            handleRoleplayUserMessage: jest.fn(),
            installConversationReplyStream: jest.fn(),
            startConversationWorker: jest.fn(),
            stopConversationAutoWorker: jest.fn(),
        };
        await jest.unstable_mockModule(CONTEXT, () => ({ getConversationPersonaId: () => 'persona.png' }));
        await jest.unstable_mockModule(CHROME, async () => {
            await chromeLoaded.promise;
            return chrome;
        });
        await jest.unstable_mockModule(RUNTIME, () => runtime);
        parts = await import(PARTS);
    });

    test('load the workspace on the first call and run the function after the runtime has installed the reply stream', async () => {
        const opened = parts.selectConversation('char.png', { chatId: 'main' });
        expect(chrome.selectConversation).not.toHaveBeenCalled();

        chromeLoaded.resolve();

        await expect(opened).resolves.toBe(true);
        expect(runtime.installConversationReplyStream).toHaveBeenCalledTimes(1);
        expect(chrome.selectConversation).toHaveBeenCalledWith('char.png', { chatId: 'main' });
        expect(runtime.installConversationReplyStream.mock.invocationCallOrder[0])
            .toBeLessThan(chrome.selectConversation.mock.invocationCallOrder[0]);
    });

    test('run the function at once when the workspace is loaded', async () => {
        chromeLoaded.resolve();
        await parts.openConversationWorkspaceForAvatar('char.png');
        chrome.openConversationWorkspaceForAvatar.mockClear();

        const opened = parts.openConversationWorkspaceForAvatar('other.png', { showToast: false });

        expect(chrome.openConversationWorkspaceForAvatar).toHaveBeenCalledWith('other.png', { showToast: false });
        await expect(opened).resolves.toBe(true);
    });

    test('end an open that is waiting for the workspace when a close comes in, and load nothing for a close', async () => {
        parts.disableConversationModeForCurrentCharacter({ focusRoleplay: false });
        expect(parts.conversationWorkspace.loaded).toBeNull();

        const opened = parts.selectConversation('char.png');
        parts.disableConversationModeForCurrentCharacter({ focusRoleplay: false });
        chromeLoaded.resolve();

        await expect(opened).resolves.toBe(false);
        expect(chrome.selectConversation).not.toHaveBeenCalled();
        expect(chrome.disableConversationModeForCurrentCharacter).not.toHaveBeenCalled();
    });

    test('close the workspace through its own function once it is loaded', async () => {
        chromeLoaded.resolve();
        await parts.selectConversation('char.png');

        parts.disableConversationModeForCurrentCharacter({ focusRoleplay: false });

        expect(chrome.disableConversationModeForCurrentCharacter).toHaveBeenCalledWith({ focusRoleplay: false });
    });

    test('open for an event with the persona and the chat that it carries, and the default conversation without an avatar', async () => {
        chromeLoaded.resolve();

        await parts.openConversationWorkspaceFromRequest({ avatar: 'char.png', chatId: 'branch', groupId: 'group', personaId: 'captured.png', showToast: false });
        await parts.openConversationWorkspaceFromRequest(null);

        expect(chrome.selectConversation).toHaveBeenNthCalledWith(1, 'char.png', { chatId: 'branch', groupId: 'group', personaId: 'captured.png', showToast: false });
        expect(chrome.selectConversation).toHaveBeenNthCalledWith(2, 'default.png', { chatId: '', groupId: null, personaId: 'persona.png', showToast: true });
    });

    test('load the runtime for the worker, the asides and the reply stream, and stop a worker only when the runtime is loaded', async () => {
        parts.stopConversationWorker();
        expect(runtime.stopConversationAutoWorker).not.toHaveBeenCalled();

        parts.startConversationWorker();
        parts.handleRoleplayUserMessage(3);
        parts.handleRoleplayCharacterMessage(4);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(runtime.installConversationReplyStream).toHaveBeenCalledTimes(1);
        expect(runtime.startConversationWorker).toHaveBeenCalledTimes(1);
        expect(runtime.handleRoleplayUserMessage).toHaveBeenCalledWith(3);
        expect(runtime.handleRoleplayCharacterMessage).toHaveBeenCalledWith(4);

        parts.stopConversationWorker();
        expect(runtime.stopConversationAutoWorker).toHaveBeenCalledTimes(1);
    });
});
