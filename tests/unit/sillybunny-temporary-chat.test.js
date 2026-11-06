/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { TC_COPY } from '../helpers/copy-temporary-chat.js';

const GREETING = { name: 'Seraphina', is_user: false, is_system: false, mes: 'Welcome.' };
const USER_MESSAGE = { name: 'You', is_user: true, is_system: false, mes: 'Hello.' };

const script = {
    characters: [],
    chat: [],
    // The module reads this export once, so Seraphina is always the second character.
    this_chid: '1',
    eventSource: { emit: jest.fn(async () => {}) },
    event_types: { CHAT_CHANGED: 'chat_id_changed' },
    saveChat: jest.fn(async () => true),
    saveSettingsDebounced: jest.fn(),
    selectCharacterById: jest.fn(async () => true),
    setActiveCharacter: jest.fn(),
    updateRemoteChatName: jest.fn(async () => {}),
};
const openAlert = jest.fn();
const conversation = { conversationWorkspaceOpen: false };

await jest.unstable_mockModule('../../public/script.js', () => script);
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({ openAlert }));
await jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({ humanizedDateTime: () => '2026-01-01@00h00m00s000ms' }));
await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({ uuidv4: () => 'fixed-integrity' }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: (strings, ...values) => String.raw({ raw: strings }, ...values) }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-conversation/state.js', () => ({ conversationState: conversation }));

const temporary = await import('../../public/scripts/sillybunny-temporary-chat.js');
const state = await import('../../public/scripts/sillybunny-temporary-chat-state.js');

const originalFetch = globalThis.fetch;
const toastError = jest.fn(() => ({ attr: jest.fn() }));
let seraphina;

/** Answers the alert the way a user would. */
function answerAlertWith(response) {
    openAlert.mockImplementationOnce(async () => response);
}

beforeEach(() => {
    seraphina = { name: 'Seraphina', avatar: 'Seraphina.png', chat: 'Seraphina - 2025' };
    script.characters.splice(0, script.characters.length, { name: 'Other', avatar: 'Other.png', chat: 'Other - 1' }, seraphina);
    script.chat.splice(0, script.chat.length, { ...GREETING });
    conversation.conversationWorkspaceOpen = false;
    globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
    globalThis.toastr = { error: toastError, success: jest.fn(), warning: jest.fn() };
    jest.clearAllMocks();
});

afterEach(() => {
    temporary.endTemporaryChat();
    globalThis.fetch = originalFetch;
});

const banner = () => document.querySelector('#sb-temporary-chat-banner');
const tryUnload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
};

describe('the module interface', () => {
    test('offers start, save, leave and the begin and end hooks, and leaves the flag to the state module', () => {
        expect(Object.keys(temporary).sort()).toEqual([
            'beginTemporaryChat', 'endTemporaryChat', 'leaveTemporaryChat',
            'saveTemporaryChatAsNew', 'showTemporaryChatError', 'startTemporaryChat',
        ]);
    });
});

describe('the error when a temporary chat cannot start', () => {
    test('is one error toast with the approved text, and no argument', () => {
        const error = jest.fn();
        globalThis.toastr = { error };

        temporary.showTemporaryChatError();

        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(TC_COPY.openError);
        delete globalThis.toastr;
    });
});

describe('starting a temporary chat', () => {
    test('selects the character as a temporary chat without switching the menu, and makes no request itself', async () => {
        await expect(temporary.startTemporaryChat(1)).resolves.toBe(true);

        expect(script.selectCharacterById).toHaveBeenCalledWith(1, expect.objectContaining({ switchMenu: false, temporary: true }));
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('reports a selection that did not happen', async () => {
        script.selectCharacterById.mockResolvedValueOnce(false);

        await expect(temporary.startTemporaryChat(1)).resolves.toBe(false);
    });

    test('closes the Conversation workspace once the selection is accepted, so the chat opens in Roleplay', async () => {
        conversation.conversationWorkspaceOpen = true;
        const closed = jest.fn();
        window.addEventListener('sb:close-conversation-workspace', closed);
        script.selectCharacterById.mockImplementationOnce(async (_id, { onAccepted }) => {
            expect(closed).not.toHaveBeenCalled();
            onAccepted();
            return true;
        });

        await temporary.startTemporaryChat(1);

        expect(closed).toHaveBeenCalledTimes(1);
        window.removeEventListener('sb:close-conversation-workspace', closed);
    });

    test('leaves the Conversation workspace alone when it is not open', async () => {
        const closed = jest.fn();
        window.addEventListener('sb:close-conversation-workspace', closed);
        script.selectCharacterById.mockImplementationOnce(async (_id, { onAccepted }) => {
            onAccepted();
            return true;
        });

        await temporary.startTemporaryChat(1);

        expect(closed).not.toHaveBeenCalled();
        window.removeEventListener('sb:close-conversation-workspace', closed);
    });
});

describe('while a chat is temporary', () => {
    test('the card holds the reserved name, and ending the chat puts the real one back', () => {
        temporary.beginTemporaryChat(seraphina);

        expect(state.isTemporaryChat()).toBe(true);
        expect(seraphina.chat).toBe(state.getTemporaryChatState().reservedName);
        expect(seraphina.chat).not.toBe('Seraphina - 2025');

        temporary.endTemporaryChat();

        expect(state.isTemporaryChat()).toBe(false);
        expect(seraphina.chat).toBe('Seraphina - 2025');
    });

    test('a banner at the top of the chat says it is not saved and offers Save as New Chat', () => {
        const chatElement = document.createElement('div');
        chatElement.id = 'chat';
        document.body.append(chatElement);

        temporary.beginTemporaryChat(seraphina);

        const element = banner();
        expect(element).not.toBeNull();
        expect(element.nextElementSibling).toBe(chatElement);
        const title = element.querySelector('span');
        expect(title.textContent).toBe(TC_COPY.banner);
        expect(title.hasAttribute('data-sb-copy-placeholder')).toBe(false);
        const buttons = element.querySelectorAll('button');
        expect([...buttons].map(button => button.textContent)).toEqual(['Save as New Chat']);

        temporary.endTemporaryChat();

        expect(banner()).toBeNull();
        chatElement.remove();
    });

    test('marks the page while the chat is temporary, so file-bound message actions can hide, and clears the mark when it ends', () => {
        const mark = () => document.documentElement.dataset.sbTemporaryChat;
        expect(mark()).toBeUndefined();

        temporary.beginTemporaryChat(seraphina);
        expect(mark()).toBe('true');

        temporary.endTemporaryChat();
        expect(mark()).toBeUndefined();
    });

    test('hides the actions that need a chat file while the page is marked, from one style element that is added once', () => {
        temporary.beginTemporaryChat(seraphina);
        temporary.endTemporaryChat();
        temporary.beginTemporaryChat(seraphina);

        const styles = document.querySelectorAll('style#sb-temporary-chat-style');
        expect(styles).toHaveLength(1);
        const rules = styles[0].textContent;
        expect(rules).toContain('html[data-sb-temporary-chat]');
        for (const action of ['mes_create_branch', 'mes_create_bookmark', 'mes_bookmark']) {
            expect(rules).toContain(`.${action}`);
        }
        // The options menu: Save checkpoint and Convert to group both write a new chat file.
        for (const entry of ['option_new_bookmark', 'option_convert_to_group']) {
            expect(rules).toContain(`#${entry}`);
        }
        expect(rules).toContain('display: none !important');
    });

    test('closing the tab asks only after the user sent a message', () => {
        temporary.beginTemporaryChat(seraphina);
        expect(tryUnload()).toBe(false);

        script.chat.push({ ...USER_MESSAGE });
        expect(tryUnload()).toBe(true);

        temporary.endTemporaryChat();
        expect(tryUnload()).toBe(false);
    });
});

describe('leaving a temporary chat', () => {
    test('lets the user go without asking when the chat is not temporary', async () => {
        await expect(temporary.leaveTemporaryChat()).resolves.toBe(true);

        expect(openAlert).not.toHaveBeenCalled();
    });

    test('lets the user go without asking when the chat holds only the greeting', async () => {
        temporary.beginTemporaryChat(seraphina);

        await expect(temporary.leaveTemporaryChat()).resolves.toBe(true);

        expect(openAlert).not.toHaveBeenCalled();
        expect(script.saveChat).not.toHaveBeenCalled();
    });

    test('asks with Cancel, Discard and Save as New Chat after the user sent a message, and says what is lost', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        answerAlertWith('cancel');

        await temporary.leaveTemporaryChat();

        const options = openAlert.mock.calls[0][0];
        expect(options.responses.map(({ id, label }) => [id, label])).toEqual([['cancel', 'Cancel'], ['discard', 'Discard'], ['save', 'Save as New Chat']]);
        expect(options.responses.find(({ id }) => id === 'discard').appearance).toBe('destructive');
        expect(options.heading).toBe(TC_COPY.leaveHead);
        expect(options.body).toBe(TC_COPY.leaveBody);
        expect(options.closeResponse).toBe('cancel');
    });

    test('Cancel keeps the user in the chat, still temporary and unsaved', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        answerAlertWith('cancel');

        await expect(temporary.leaveTemporaryChat()).resolves.toBe(false);

        expect(state.isTemporaryChat()).toBe(true);
        expect(script.saveChat).not.toHaveBeenCalled();
    });

    test('Discard lets the user go and writes nothing', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        answerAlertWith('discard');

        await expect(temporary.leaveTemporaryChat()).resolves.toBe(true);

        expect(script.saveChat).not.toHaveBeenCalled();
        expect(script.updateRemoteChatName).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('Save as New Chat saves the chat, then lets the user go', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        answerAlertWith('save');

        await expect(temporary.leaveTemporaryChat()).resolves.toBe(true);

        expect(script.saveChat).toHaveBeenCalledTimes(1);
        expect(state.isTemporaryChat()).toBe(false);
    });

    test('keeps the user in the chat when the save from the alert fails', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        script.saveChat.mockRejectedValueOnce(new Error('offline'));
        answerAlertWith('save');

        await expect(temporary.leaveTemporaryChat()).resolves.toBe(false);

        expect(state.isTemporaryChat()).toBe(true);
    });

    test('two callers that leave at once share one alert, and the second aborts when the first is cancelled', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        let answer;
        openAlert.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));

        const first = temporary.leaveTemporaryChat();
        const second = temporary.leaveTemporaryChat();
        answer('cancel');

        await expect(first).resolves.toBe(false);
        await expect(second).resolves.toBe(false);
        expect(openAlert).toHaveBeenCalledTimes(1);
    });

    test('only the first of two callers that leave at once acts on a Discard, so the second navigation aborts', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        let answer;
        openAlert.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));

        const first = temporary.leaveTemporaryChat();
        const second = temporary.leaveTemporaryChat();
        answer('discard');

        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(false);
        expect(openAlert).toHaveBeenCalledTimes(1);
    });

    test('a second caller waits for the answer before it aborts', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        let answer;
        openAlert.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
        temporary.leaveTemporaryChat();
        const settled = jest.fn();

        temporary.leaveTemporaryChat().then(settled);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(settled).not.toHaveBeenCalled();

        answer('cancel');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(settled).toHaveBeenCalledWith(false);
    });

    test('asks again once the first alert is answered', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        answerAlertWith('cancel');
        await temporary.leaveTemporaryChat();
        answerAlertWith('cancel');

        await temporary.leaveTemporaryChat();

        expect(openAlert).toHaveBeenCalledTimes(2);
    });

    test('does not ask again about a chat the user already agreed to discard, so one trip across the app asks once', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        answerAlertWith('discard');
        await temporary.leaveTemporaryChat();

        await expect(temporary.leaveTemporaryChat()).resolves.toBe(true);

        expect(openAlert).toHaveBeenCalledTimes(1);
    });

    test('asks again when the chat changed after the user agreed to discard it but stayed', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        answerAlertWith('discard');
        await temporary.leaveTemporaryChat();
        script.chat.push({ ...USER_MESSAGE, mes: 'More.' });
        answerAlertWith('cancel');

        await expect(temporary.leaveTemporaryChat()).resolves.toBe(false);

        expect(openAlert).toHaveBeenCalledTimes(2);
    });

    test.each([
        ['a message is edited', () => { script.chat[1].mes = 'Hello, edited.'; }],
        ['a message is edited to text of the same length', () => { script.chat[1].mes = 'Hullo.'; }],
        ['a swipe is chosen', () => { script.chat[1].swipe_id = 1; }],
        ['a message is continued', () => { script.chat[1].mes += ' And on.'; }],
    ])('asks again when %s after the user agreed to discard but stayed', async (_name, change) => {
        script.chat.push({ ...USER_MESSAGE, swipe_id: 0 });
        temporary.beginTemporaryChat(seraphina);
        answerAlertWith('discard');
        await temporary.leaveTemporaryChat();
        change();
        answerAlertWith('cancel');

        await expect(temporary.leaveTemporaryChat()).resolves.toBe(false);

        expect(openAlert).toHaveBeenCalledTimes(2);
    });

    test('forgets the agreement when the chat ends, so the next temporary chat asks', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        answerAlertWith('discard');
        await temporary.leaveTemporaryChat();
        temporary.endTemporaryChat();
        temporary.beginTemporaryChat(seraphina);
        answerAlertWith('cancel');

        await expect(temporary.leaveTemporaryChat()).resolves.toBe(false);
    });
});

describe('Save as New Chat', () => {
    test('writes exactly one chat file with the messages and an integrity key, and records it as the character\'s chat', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        let temporaryDuringSave = null;
        script.saveChat.mockImplementationOnce(async () => {
            temporaryDuringSave = state.isTemporaryChat();
            return true;
        });

        await expect(temporary.saveTemporaryChatAsNew()).resolves.toBe(true);

        expect(script.saveChat).toHaveBeenCalledTimes(1);
        expect(script.saveChat).toHaveBeenCalledWith({
            chatName: 'Seraphina - 2026-01-01@00h00m00s000ms',
            withMetadata: { integrity: 'fixed-integrity' },
            throwOnError: true,
        });
        expect(temporaryDuringSave).toBe(false);
        expect(script.updateRemoteChatName).toHaveBeenCalledTimes(1);
        expect(script.updateRemoteChatName).toHaveBeenCalledWith('1', 'Seraphina - 2026-01-01@00h00m00s000ms');
        expect(seraphina.chat).toBe('Seraphina - 2026-01-01@00h00m00s000ms');
    });

    test('ends the temporary state, removes the banner and the tab warning, and keeps the character active for the next start', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);

        await temporary.saveTemporaryChatAsNew();

        expect(state.isTemporaryChat()).toBe(false);
        expect(banner()).toBeNull();
        expect(tryUnload()).toBe(false);
        expect(script.setActiveCharacter).toHaveBeenCalledWith('Seraphina.png');
        expect(script.saveSettingsDebounced).toHaveBeenCalled();
        expect(script.eventSource.emit).toHaveBeenCalledWith('chat_id_changed', 'Seraphina - 2026-01-01@00h00m00s000ms');
    });

    test('a failed save leaves the chat temporary with its reserved name and banner, and adds no error toast of its own', async () => {
        script.chat.push({ ...USER_MESSAGE });
        temporary.beginTemporaryChat(seraphina);
        const reserved = state.getTemporaryChatState().reservedName;
        script.saveChat.mockRejectedValueOnce(new Error('offline'));

        await expect(temporary.saveTemporaryChatAsNew()).resolves.toBe(false);

        expect(state.isTemporaryChat()).toBe(true);
        expect(seraphina.chat).toBe(reserved);
        expect(banner()).not.toBeNull();
        expect(script.updateRemoteChatName).not.toHaveBeenCalled();
        // saveChat reports the failure itself.
        expect(toastError).not.toHaveBeenCalled();
    });

    test('a save that the app declined counts as failed', async () => {
        temporary.beginTemporaryChat(seraphina);
        script.saveChat.mockResolvedValueOnce(false);

        await expect(temporary.saveTemporaryChatAsNew()).resolves.toBe(false);

        expect(state.isTemporaryChat()).toBe(true);
    });

    test('does nothing when no temporary chat is open', async () => {
        await expect(temporary.saveTemporaryChatAsNew()).resolves.toBe(false);

        expect(script.saveChat).not.toHaveBeenCalled();
    });

    test('two clicks write one file', async () => {
        temporary.beginTemporaryChat(seraphina);
        let release;
        script.saveChat.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(true); }));

        const first = temporary.saveTemporaryChatAsNew();
        const second = temporary.saveTemporaryChatAsNew();
        release();

        await expect(second).resolves.toBe(false);
        await expect(first).resolves.toBe(true);
        expect(script.saveChat).toHaveBeenCalledTimes(1);
    });
});
