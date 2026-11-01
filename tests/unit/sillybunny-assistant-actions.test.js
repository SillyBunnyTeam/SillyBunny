/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a dispatcher. */
import { describe, expect, jest, test } from '@jest/globals';
import { createAssistantActions } from '../../public/scripts/sillybunny-home/assistant-actions.js';

const AVAILABLE = { key: 'assistant-reisen', id: 'reisen', state: 'available', avatar: 'default_AssistantReisen.png' };

function createWorld({ lastMode = 'roleplay' } = {}) {
    const world = {
        lastMode,
        deps: {
            getLastMode: jest.fn(() => world.lastMode),
            openRoleplayChat: jest.fn(async () => true),
            openTemporaryChat: jest.fn(async () => true),
            openConversationChat: jest.fn(async () => true),
            reportFailure: jest.fn(),
        },
    };
    world.actions = createAssistantActions(world.deps);
    return world;
}

const opened = ({ deps }) => ({
    roleplay: deps.openRoleplayChat.mock.calls.map(([avatar]) => avatar),
    temporary: deps.openTemporaryChat.mock.calls.map(([avatar]) => avatar),
    conversation: deps.openConversationChat.mock.calls.map(([avatar]) => avatar),
});

describe('New Chat', () => {
    test('opens a Roleplay chat with the assistant when Roleplay was the last mode', async () => {
        const world = createWorld({ lastMode: 'roleplay' });

        expect(await world.actions.newChat(AVAILABLE)).toBe(true);

        expect(opened(world)).toEqual({ roleplay: [AVAILABLE.avatar], temporary: [], conversation: [] });
    });

    test('opens a fresh Conversation with the assistant when Conversation was the last mode', async () => {
        const world = createWorld({ lastMode: 'conversation' });

        expect(await world.actions.newChat(AVAILABLE)).toBe(true);

        expect(opened(world)).toEqual({ roleplay: [], temporary: [], conversation: [AVAILABLE.avatar] });
    });

    test('reads the last mode when it is activated, not when the actions are made', async () => {
        const world = createWorld({ lastMode: 'roleplay' });
        world.lastMode = 'conversation';

        await world.actions.newChat(AVAILABLE);

        expect(opened(world).conversation).toEqual([AVAILABLE.avatar]);
    });

    test('treats a mode it does not know as Roleplay', async () => {
        const world = createWorld({ lastMode: 'something-else' });

        await world.actions.newChat(AVAILABLE);

        expect(opened(world).roleplay).toEqual([AVAILABLE.avatar]);
    });
});

describe('Temporary Chat', () => {
    test.each(['roleplay', 'conversation'])('opens a temporary chat whatever the last mode was (%s), because it exists only in Roleplay', async (lastMode) => {
        const world = createWorld({ lastMode });

        expect(await world.actions.temporaryChat(AVAILABLE)).toBe(true);

        expect(opened(world)).toEqual({ roleplay: [], temporary: [AVAILABLE.avatar], conversation: [] });
    });
});

describe('New Chat in the other mode', () => {
    test('opens the chat in the mode that is given, whatever the last mode was', async () => {
        const world = createWorld({ lastMode: 'roleplay' });

        await world.actions.newChatInMode(AVAILABLE, 'conversation');
        await world.actions.newChatInMode(AVAILABLE, 'roleplay');

        expect(opened(world)).toEqual({ roleplay: [AVAILABLE.avatar], temporary: [], conversation: [AVAILABLE.avatar] });
    });

    test('refuses a mode that is neither Roleplay nor Conversation, and opens nothing', async () => {
        const world = createWorld();

        await expect(world.actions.newChatInMode(AVAILABLE, 'group')).rejects.toThrow(TypeError);

        expect(opened(world)).toEqual({ roleplay: [], temporary: [], conversation: [] });
    });
});

describe('a card without a file', () => {
    test.each(['missing', 'deleted'])('opens nothing when its state is %s', async (state) => {
        const world = createWorld();
        const card = { ...AVAILABLE, state, avatar: null };

        expect(await world.actions.newChat(card)).toBe(false);
        expect(await world.actions.temporaryChat(card)).toBe(false);
        expect(await world.actions.newChatInMode(card, 'conversation')).toBe(false);

        expect(opened(world)).toEqual({ roleplay: [], temporary: [], conversation: [] });
        expect(world.deps.reportFailure).not.toHaveBeenCalled();
    });
});

describe('when a chat cannot be opened', () => {
    test('reports the failure once and resolves false when the opening throws', async () => {
        const world = createWorld();
        const error = new Error('no card');
        world.deps.openRoleplayChat.mockRejectedValueOnce(error);
        const log = jest.spyOn(console, 'error').mockImplementation(() => {});

        expect(await world.actions.newChat(AVAILABLE)).toBe(false);

        expect(world.deps.reportFailure).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(expect.any(String), error);
        log.mockRestore();
    });

    test('resolves false without a report when the user declined, as a Cancel on the temporary chat does', async () => {
        const world = createWorld();
        world.deps.openRoleplayChat.mockResolvedValueOnce(false);

        expect(await world.actions.newChat(AVAILABLE)).toBe(false);

        expect(world.deps.reportFailure).not.toHaveBeenCalled();
    });

    test('can open a chat again after one failed', async () => {
        const world = createWorld();
        world.deps.openRoleplayChat.mockRejectedValueOnce(new Error('no card'));
        const log = jest.spyOn(console, 'error').mockImplementation(() => {});

        await world.actions.newChat(AVAILABLE);
        expect(await world.actions.newChat(AVAILABLE)).toBe(true);

        log.mockRestore();
    });
});

describe('a second activation while a chat is opening', () => {
    test('is dropped, so a double click opens one chat', async () => {
        const world = createWorld();
        let finish;
        world.deps.openRoleplayChat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

        const first = world.actions.newChat(AVAILABLE);
        const second = await world.actions.newChat(AVAILABLE);
        const third = await world.actions.temporaryChat(AVAILABLE);
        finish(true);

        expect(second).toBe(false);
        expect(third).toBe(false);
        expect(await first).toBe(true);
        expect(world.deps.openRoleplayChat).toHaveBeenCalledTimes(1);
        expect(world.deps.openTemporaryChat).not.toHaveBeenCalled();
    });
});
