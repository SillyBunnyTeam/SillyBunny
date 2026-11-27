import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const world = { avatar: 'a.png', groupId: '', personaId: 'p.png', activeChatId: 'main' };
const conversationState = { lastRenderedConversationKey: '' };
const scheduleInterfaceRefresh = jest.fn();

await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ conversationState }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/render-scheduler.js', () => ({ scheduleInterfaceRefresh }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    getCurrentCharAvatar: () => world.avatar,
    getConversationGroupIdForAvatar: () => world.groupId,
    getConversationPersonaId: () => world.personaId,
    getConversationRecord: () => (world.avatar ? { activeChatId: world.activeChatId } : null),
    getActiveConversationChat: () => null,
}));

const {
    beginConversationSwitch,
    getSelectedConversationRenderKey,
    isComposerHeld,
    isConversationSwitching,
    isSelectedConversationOnScreen,
    withConversationSwitch,
} = await import('../public/scripts/sillybunny-conversation/screen-target.js');
const { buildConversationRenderKey } = await import('../public/scripts/sillybunny-conversation/render-key.js');

/** What the timeline writes when it has drawn the conversation that the state selects. */
const draw = () => {
    conversationState.lastRenderedConversationKey = getSelectedConversationRenderKey();
};

beforeEach(() => {
    Object.assign(world, { avatar: 'a.png', groupId: '', personaId: 'p.png', activeChatId: 'main' });
    conversationState.lastRenderedConversationKey = '';
    scheduleInterfaceRefresh.mockClear();
});

describe('the conversation that is on screen', () => {
    test('is the one that the timeline drew last, by persona, character, group and chat', () => {
        draw();

        expect(conversationState.lastRenderedConversationKey).toBe(buildConversationRenderKey('a.png', '', 'main', 'p.png'));
        expect(isSelectedConversationOnScreen()).toBe(true);
    });

    test('is no longer the selected one the moment the selection changes, before anything is drawn', () => {
        draw();

        world.avatar = 'b.png';

        expect(isSelectedConversationOnScreen()).toBe(false);
        draw();
        expect(isSelectedConversationOnScreen()).toBe(true);
    });

    test('changes with the group, the persona and the active chat as well', () => {
        draw();

        for (const change of [{ groupId: 'g1' }, { personaId: 'q.png' }, { activeChatId: 'second' }]) {
            Object.assign(world, { avatar: 'a.png', groupId: '', personaId: 'p.png', activeChatId: 'main' }, change);
            expect(isSelectedConversationOnScreen()).toBe(false);
        }
    });

    test('is the empty key while no character is selected, which is the key that the timeline writes for its empty state', () => {
        world.avatar = null;

        expect(getSelectedConversationRenderKey()).toBe('');
        expect(isSelectedConversationOnScreen()).toBe(true);
    });

    test('is not on screen before anything was drawn for a selected character', () => {
        expect(isSelectedConversationOnScreen()).toBe(false);
    });
});

describe('a switch to another conversation under way', () => {
    test('counts from its start to its end and asks for a draw at both, so that the composer follows', () => {
        expect(isConversationSwitching()).toBe(false);

        const end = beginConversationSwitch();
        expect(isConversationSwitching()).toBe(true);
        expect(scheduleInterfaceRefresh).toHaveBeenCalledTimes(1);

        end();
        expect(isConversationSwitching()).toBe(false);
        expect(scheduleInterfaceRefresh).toHaveBeenCalledTimes(2);
    });

    test('ends once, however often its end is called, so that it cannot end another switch', () => {
        const first = beginConversationSwitch();
        const second = beginConversationSwitch();

        first();
        first();

        expect(isConversationSwitching()).toBe(true);
        second();
        expect(isConversationSwitching()).toBe(false);
    });

    test('withConversationSwitch holds from the call to the end of the work, and gives back what the work gave', async () => {
        let finish;
        const work = new Promise((resolve) => {
            finish = resolve;
        });

        const outcome = withConversationSwitch(() => work);
        expect(isConversationSwitching()).toBe(true);
        finish('opened');

        await expect(outcome).resolves.toBe('opened');
        expect(isConversationSwitching()).toBe(false);
    });

    test('withConversationSwitch ends when the work fails, and passes the failure on', async () => {
        await expect(withConversationSwitch(async () => {
            throw new Error('the conversation could not be made');
        })).rejects.toThrow('the conversation could not be made');

        expect(isConversationSwitching()).toBe(false);
    });

    test('withConversationSwitch holds when the work throws at once, before it returns a promise', async () => {
        await expect(withConversationSwitch(() => {
            throw new Error('at once');
        })).rejects.toThrow('at once');

        expect(isConversationSwitching()).toBe(false);
    });
});

describe('the composer is held', () => {
    test('while a switch is under way, and while what is selected is not what is drawn', () => {
        draw();
        expect(isComposerHeld()).toBe(false);

        const end = beginConversationSwitch();
        expect(isComposerHeld()).toBe(true);
        end();
        expect(isComposerHeld()).toBe(false);

        world.avatar = 'b.png';
        expect(isComposerHeld()).toBe(true);
        draw();
        expect(isComposerHeld()).toBe(false);
    });
});
