/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a dispatcher. */
import { describe, expect, jest, test } from '@jest/globals';
import { createManagedActions } from '../../public/scripts/sillybunny-home/assistant-managed-actions.js';
import { ManagedContentRequestError } from '../../public/scripts/sillybunny-home/managed-content.js';

const REISEN = 'default_AssistantReisen.png';
const RESTORABLE = { name: 'Reisen', offers: { filename: REISEN, restore: true, update: null } };
const UPDATABLE = { name: 'Reisen', offers: { filename: REISEN, restore: false, update: { version: 3 } } };
const NOTHING = { name: 'Reisen', offers: { filename: null, restore: false, update: null } };

/** Resolves when the test lets it, so a second activation can arrive while the first is still running. */
function createGate() {
    let open;
    const promise = new Promise((resolve) => { open = resolve; });
    return { promise, open };
}

function createWorld({ answer = 'update', dismissed = new Map() } = {}) {
    const world = {
        dismissed,
        order: [],
        deps: {
            client: {
                apply: jest.fn(async () => { world.order.push('apply'); return { backup: 'b' }; }),
                restore: jest.fn(async () => { world.order.push('restore'); return { backup: 'b' }; }),
            },
            askUpdate: jest.fn(async () => { world.order.push('ask'); return answer; }),
            getDismissed: jest.fn(() => world.dismissed),
            saveDismissed: jest.fn((next) => { world.order.push('save'); world.dismissed = next; }),
            notifyUpdated: jest.fn(() => { world.order.push('notify'); }),
            afterChange: jest.fn(async () => { world.order.push('after'); }),
            reportFailure: jest.fn(),
        },
    };
    world.actions = createManagedActions(world.deps);
    return world;
}

const changes = ({ deps }) => deps.afterChange.mock.calls.map(([change]) => change);

describe('Restore', () => {
    test('puts the bundled file back, then shows the result with a changed file', async () => {
        const world = createWorld();

        expect(await world.actions.restore(RESTORABLE)).toBe(true);

        expect(world.deps.client.restore).toHaveBeenCalledWith(REISEN);
        expect(world.order).toEqual(['restore', 'after']);
        expect(changes(world)).toEqual([{ filename: REISEN, fileChanged: true }]);
    });

    test.each([
        ['a card that offers nothing', NOTHING],
        ['a card that offers only an update', UPDATABLE],
    ])('does nothing for %s', async (_case, card) => {
        const world = createWorld();

        expect(await world.actions.restore(card)).toBe(false);

        expect(world.deps.client.restore).not.toHaveBeenCalled();
        expect(world.deps.afterChange).not.toHaveBeenCalled();
    });

    test('tells the user when the request is refused, shows nothing as changed, and never rejects', async () => {
        const world = createWorld();
        world.deps.client.restore.mockRejectedValueOnce(new ManagedContentRequestError('restore', 500, 'write_failed'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(world.actions.restore(RESTORABLE)).resolves.toBe(false);

        expect(world.deps.reportFailure).toHaveBeenCalledTimes(1);
        expect(world.deps.afterChange).not.toHaveBeenCalled();
        error.mockRestore();
    });

    test('says nothing of its own when it went through, because the card coming back is the answer', async () => {
        const world = createWorld();

        await world.actions.restore(RESTORABLE);

        expect(world.deps.notifyUpdated).not.toHaveBeenCalled();
        expect(world.deps.reportFailure).not.toHaveBeenCalled();
    });

    test('is not reported as failed when the file is back but showing it fails, because the action worked', async () => {
        const world = createWorld();
        world.deps.afterChange.mockRejectedValueOnce(new Error('library'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(world.actions.restore(RESTORABLE)).resolves.toBe(true);

        expect(world.deps.reportFailure).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    test('tells the user when the request cannot be sent at all', async () => {
        const world = createWorld();
        world.deps.client.restore.mockRejectedValueOnce(new TypeError('network'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(world.actions.restore(RESTORABLE)).resolves.toBe(false);

        expect(world.deps.reportFailure).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });
});

describe('Update Available', () => {
    test('asks first, and Update applies the bundled card, which keeps a backup, then shows a changed file', async () => {
        const world = createWorld({ answer: 'update' });

        expect(await world.actions.update(UPDATABLE)).toBe(true);

        expect(world.order).toEqual(['ask', 'apply', 'notify', 'after']);
        expect(world.deps.client.apply).toHaveBeenCalledWith(REISEN);
        expect(changes(world)).toEqual([{ filename: REISEN, fileChanged: true }]);
        expect(world.deps.saveDismissed).not.toHaveBeenCalled();
    });

    test('asks about the card, so the question can use its name', async () => {
        const world = createWorld({ answer: 'cancel' });

        await world.actions.update(UPDATABLE);

        expect(world.deps.askUpdate).toHaveBeenCalledWith(UPDATABLE);
    });

    test('tells the user once, with the card, after the server confirmed the update', async () => {
        const world = createWorld({ answer: 'update' });

        await world.actions.update(UPDATABLE);

        expect(world.deps.notifyUpdated).toHaveBeenCalledTimes(1);
        expect(world.deps.notifyUpdated).toHaveBeenCalledWith(UPDATABLE);
    });

    test('is not reported as failed when the update went through but showing it fails, and the user is still told it worked', async () => {
        const world = createWorld({ answer: 'update' });
        world.deps.afterChange.mockRejectedValueOnce(new Error('library'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(world.actions.update(UPDATABLE)).resolves.toBe(true);

        expect(world.deps.notifyUpdated).toHaveBeenCalledTimes(1);
        expect(world.deps.reportFailure).not.toHaveBeenCalled();
        error.mockRestore();
    });

    test('Keep Mine stores the offered version for the file and changes no file', async () => {
        const world = createWorld({ answer: 'keep', dismissed: new Map([['other.png', 1]]) });

        expect(await world.actions.update(UPDATABLE)).toBe(true);

        expect(world.order).toEqual(['ask', 'save', 'after']);
        expect([...world.dismissed]).toEqual([['other.png', 1], [REISEN, 3]]);
        expect(world.deps.client.apply).not.toHaveBeenCalled();
        expect(world.deps.notifyUpdated).not.toHaveBeenCalled();
        expect(changes(world)).toEqual([{ filename: REISEN, fileChanged: false }]);
    });

    test('Keep Mine does not lower a version that was kept before', async () => {
        const world = createWorld({ answer: 'keep', dismissed: new Map([[REISEN, 5]]) });

        await world.actions.update(UPDATABLE);

        expect(world.dismissed.get(REISEN)).toBe(5);
    });

    test.each(['cancel', null, 'something'])('changes nothing and keeps nothing when the answer is %p, so the question comes back', async (answer) => {
        const world = createWorld({ answer });

        expect(await world.actions.update(UPDATABLE)).toBe(false);

        expect(world.deps.client.apply).not.toHaveBeenCalled();
        expect(world.deps.saveDismissed).not.toHaveBeenCalled();
        expect(world.deps.afterChange).not.toHaveBeenCalled();
        expect(world.deps.reportFailure).not.toHaveBeenCalled();
    });

    test.each([
        ['a card that offers nothing', NOTHING],
        ['a card that offers only Restore', RESTORABLE],
    ])('does not ask for %s', async (_case, card) => {
        const world = createWorld();

        expect(await world.actions.update(card)).toBe(false);

        expect(world.deps.askUpdate).not.toHaveBeenCalled();
    });

    test('tells the user when the update is refused, keeps nothing and shows nothing as changed', async () => {
        const world = createWorld({ answer: 'update' });
        world.deps.client.apply.mockRejectedValueOnce(new ManagedContentRequestError('apply', 500, 'backup_failed'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(world.actions.update(UPDATABLE)).resolves.toBe(false);

        expect(world.deps.reportFailure).toHaveBeenCalledTimes(1);
        expect(world.deps.notifyUpdated).not.toHaveBeenCalled();
        expect(world.deps.saveDismissed).not.toHaveBeenCalled();
        expect(world.deps.afterChange).not.toHaveBeenCalled();
        error.mockRestore();
    });

    test('tells the user when the question cannot be shown, and never rejects', async () => {
        const world = createWorld();
        world.deps.askUpdate.mockRejectedValueOnce(new Error('chunk'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(world.actions.update(UPDATABLE)).resolves.toBe(false);

        expect(world.deps.reportFailure).toHaveBeenCalledTimes(1);
        expect(world.deps.client.apply).not.toHaveBeenCalled();
        error.mockRestore();
    });

    test('tells the user when the account cannot store the kept version, and never rejects', async () => {
        const world = createWorld({ answer: 'keep' });
        world.deps.saveDismissed.mockImplementationOnce(() => { throw new Error('storage'); });
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(world.actions.update(UPDATABLE)).resolves.toBe(false);

        expect(world.deps.reportFailure).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });
});

describe('a request that the server no longer accepts', () => {
    test.each(['apply', 'restore'])('has Home read the status again after a 409 on %s, because the offer cannot succeed any more', async (action) => {
        const world = createWorld({ answer: 'update' });
        world.deps.client[action].mockRejectedValueOnce(new ManagedContentRequestError(action, 409, 'already_current'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await (action === 'apply' ? world.actions.update(UPDATABLE) : world.actions.restore(RESTORABLE));

        expect(world.deps.reportFailure).toHaveBeenCalledTimes(1);
        expect(changes(world)).toEqual([{ filename: REISEN, fileChanged: false }]);
        error.mockRestore();
    });

    test('does not reject when that second render fails too', async () => {
        const world = createWorld();
        world.deps.client.restore.mockRejectedValueOnce(new ManagedContentRequestError('restore', 409, 'not_applicable'));
        world.deps.afterChange.mockRejectedValueOnce(new Error('render'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(world.actions.restore(RESTORABLE)).resolves.toBe(false);

        expect(world.deps.reportFailure).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });

    test('does not read the status again after any other refusal', async () => {
        const world = createWorld();
        world.deps.client.restore.mockRejectedValueOnce(new ManagedContentRequestError('restore', 500, 'write_failed'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await world.actions.restore(RESTORABLE);

        expect(world.deps.afterChange).not.toHaveBeenCalled();
        error.mockRestore();
    });
});

describe('a second activation while one runs', () => {
    test('is dropped for Restore, which is what a double click is', async () => {
        const world = createWorld();
        const gate = createGate();
        world.deps.client.restore.mockImplementationOnce(() => gate.promise);

        const first = world.actions.restore(RESTORABLE);
        const second = await world.actions.restore(RESTORABLE);
        gate.open();
        await first;

        expect(second).toBe(false);
        expect(world.deps.client.restore).toHaveBeenCalledTimes(1);
    });

    test('is dropped while the question of an update is open, for Update and for Restore', async () => {
        const world = createWorld();
        const gate = createGate();
        world.deps.askUpdate.mockImplementationOnce(() => gate.promise);

        const first = world.actions.update(UPDATABLE);
        const again = await world.actions.update(UPDATABLE);
        const restore = await world.actions.restore(RESTORABLE);
        gate.open('cancel');
        await first;

        expect([again, restore]).toEqual([false, false]);
        expect(world.deps.askUpdate).toHaveBeenCalledTimes(1);
        expect(world.deps.client.restore).not.toHaveBeenCalled();
    });

    test('is accepted once the first has finished, also after it failed', async () => {
        const world = createWorld();
        world.deps.client.restore.mockRejectedValueOnce(new TypeError('network'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        await world.actions.restore(RESTORABLE);
        const second = await world.actions.restore(RESTORABLE);

        expect(second).toBe(true);
        expect(world.deps.client.restore).toHaveBeenCalledTimes(2);
        error.mockRestore();
    });

    test('is accepted once the question was answered with Cancel', async () => {
        const world = createWorld({ answer: 'cancel' });

        await world.actions.update(UPDATABLE);
        world.deps.askUpdate.mockResolvedValueOnce('update');

        expect(await world.actions.update(UPDATABLE)).toBe(true);
    });
});
