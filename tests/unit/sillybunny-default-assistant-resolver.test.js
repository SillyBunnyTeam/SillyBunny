/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a cache. */
import { describe, expect, jest, test } from '@jest/globals';
import { createDefaultAssistantResolver } from '../../public/scripts/sillybunny-home/default-assistant-resolver.js';
import { resolveDefaultAssistant } from '../../public/scripts/sillybunny-home/assistant-registry.js';

const avatars = count => Array.from({ length: count }, (_, index) => ({ avatar: `card-${index}.png` }));

/** A resolver over a list of characters that counts how many of them the check for Reisen's card looks at. */
function createWorld(initial) {
    const world = { list: initial, looked: 0 };
    world.resolver = createDefaultAssistantResolver({
        getCharacters: () => world.list,
        resolve: () => resolveDefaultAssistant({
            hasCard: (assistant) => world.list.some((character) => {
                world.looked++;
                return character.avatar === assistant.defaultAvatar;
            }),
        }),
    });
    return world;
}

describe('the default assistant, resolved for a list of characters', () => {
    test('is resolved once for as many calls as the list is read for, however long the list is', () => {
        const world = createWorld(avatars(5000));

        for (let call = 0; call < 5000; call++) {
            expect(world.resolver.get().id).toBe('guide');
        }

        expect(world.looked).toBe(5000);
    });

    test('is Reisen when her card is in the list, and is not resolved again', () => {
        const world = createWorld([...avatars(3), { avatar: 'default_AssistantReisen.png' }]);

        expect(world.resolver.get().id).toBe('reisen');
        const looked = world.looked;
        expect(world.resolver.get().id).toBe('reisen');

        expect(world.looked).toBe(looked);
    });

    test('is resolved again when the list gains or loses a character', () => {
        const world = createWorld(avatars(2));
        expect(world.resolver.get().id).toBe('guide');

        world.list.push({ avatar: 'default_AssistantReisen.png' });
        expect(world.resolver.get().id).toBe('reisen');

        world.list.pop();
        expect(world.resolver.get().id).toBe('guide');
    });

    test('is resolved again when the list is another array', () => {
        const world = createWorld(avatars(2));
        expect(world.resolver.get().id).toBe('guide');

        world.list = [{ avatar: 'default_AssistantReisen.png' }, { avatar: 'a.png' }];

        expect(world.resolver.get().id).toBe('reisen');
    });

    test('keeps its answer for a list that changed without a change of length, until it is told to forget', () => {
        const world = createWorld([{ avatar: 'a.png' }, { avatar: 'b.png' }]);
        expect(world.resolver.get().id).toBe('guide');

        world.list[1] = { avatar: 'default_AssistantReisen.png' };
        expect(world.resolver.get().id).toBe('guide');

        world.resolver.invalidate();
        expect(world.resolver.get().id).toBe('reisen');
    });

    test('is resolved again after every invalidation, and only then', () => {
        const world = createWorld(avatars(10));
        world.resolver.get();
        world.resolver.invalidate();
        world.resolver.get();
        world.resolver.get();
        world.resolver.invalidate();
        world.resolver.invalidate();
        world.resolver.get();

        expect(world.looked).toBe(30);
    });

    test('reads the list through the getter each time, so a list that is replaced is seen', () => {
        const getCharacters = jest.fn(() => []);
        const resolver = createDefaultAssistantResolver({ getCharacters, resolve: () => resolveDefaultAssistant({ hasCard: () => false }) });

        resolver.get();
        resolver.get();

        expect(getCharacters).toHaveBeenCalledTimes(2);
    });
});
