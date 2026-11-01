/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the app wiring of the assistant cards. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const characters = [{ avatar: 'first.png' }, { avatar: 'second.png' }];
const doNewChat = jest.fn(async () => {});
const selectCharacterById = jest.fn();
jest.unstable_mockModule('../../public/script.js', () => ({ characters, doNewChat, selectCharacterById }));
const conversationState = { conversationWorkspaceOpen: false };
jest.unstable_mockModule('../../public/scripts/sillybunny-conversation/state.js', () => ({ conversationState }));
const startTemporaryChat = jest.fn(async () => true);
jest.unstable_mockModule('../../public/scripts/sillybunny-temporary-chat.js', () => ({ startTemporaryChat }));
jest.unstable_mockModule('../../public/scripts/sillybunny-chat-mode-memory.js', () => ({ getLastChatMode: () => 'roleplay' }));
const { createAppAssistantActions } = await import('../../public/scripts/sillybunny-home/assistant-chat.js');

const CARD = { state: 'available', avatar: 'second.png' };

describe('the app actions of an assistant card', () => {
    const attr = jest.fn();
    const error = jest.fn(() => ({ find: () => ({ attr }) }));

    beforeEach(() => {
        jest.clearAllMocks();
        conversationState.conversationWorkspaceOpen = false;
        window.toastr = { error };
    });

    afterEach(() => {
        delete window.toastr;
    });

    test('New Chat in Roleplay selects the character, then starts a new chat that keeps the current one', async () => {
        selectCharacterById.mockResolvedValue(true);
        const actions = createAppAssistantActions({ openConversation: jest.fn() });

        expect(await actions.newChat(CARD)).toBe(true);

        expect(selectCharacterById).toHaveBeenCalledWith(1, expect.objectContaining({ switchMenu: false, onAccepted: expect.any(Function) }));
        expect(doNewChat).toHaveBeenCalledWith({ deleteCurrentChat: false });
    });

    test('starts no chat and reports no failure when the selection is declined, as it is while a generation runs', async () => {
        selectCharacterById.mockResolvedValue(false);
        const actions = createAppAssistantActions({ openConversation: jest.fn() });

        expect(await actions.newChat(CARD)).toBe(false);

        expect(doNewChat).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    test('closes the Conversation workspace only once the selection is accepted, and only when it is open', async () => {
        selectCharacterById.mockResolvedValue(true);
        const closed = jest.fn();
        window.addEventListener('sb:close-conversation-workspace', closed);
        const actions = createAppAssistantActions({ openConversation: jest.fn() });
        await actions.newChat(CARD);
        const { onAccepted } = selectCharacterById.mock.calls[0][1];

        onAccepted();
        expect(closed).not.toHaveBeenCalled();
        conversationState.conversationWorkspaceOpen = true;
        onAccepted();
        expect(closed).toHaveBeenCalledTimes(1);
        window.removeEventListener('sb:close-conversation-workspace', closed);
    });

    test('tells the user with the placeholder toast, and starts no chat, when the character has left the library', async () => {
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        const actions = createAppAssistantActions({ openConversation: jest.fn() });

        expect(await actions.newChat({ state: 'available', avatar: 'gone.png' })).toBe(false);

        expect(logged).toHaveBeenCalled();
        logged.mockRestore();

        expect(selectCharacterById).not.toHaveBeenCalled();
        expect(doNewChat).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith('TODO(copy)');
        expect(attr).toHaveBeenCalledWith({ 'data-sb-copy-placeholder': 'true', 'data-sb-copy-slot': 'AS-ACTION-ERROR' });
    });

    test('a Temporary Chat is started for the id of the character', async () => {
        const actions = createAppAssistantActions({ openConversation: jest.fn() });

        await actions.temporaryChat(CARD);

        expect(startTemporaryChat).toHaveBeenCalledWith(1);
    });
});
