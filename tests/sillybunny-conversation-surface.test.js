import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const { createSurfaceOpener } = await import('../public/scripts/sillybunny-conversation/conversation-surface.js');

let warn;

beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    warn.mockRestore();
});

describe('opening a surface that another task builds', () => {
    test('calls the exported function with its arguments and says that it opened', async () => {
        const surfaces = { openConversationDetails: jest.fn() };
        const open = createSurfaceOpener(async () => surfaces);

        const opened = await open('openConversationDetails', 'conv_1', { page: 'general' });

        expect(opened).toBe(true);
        expect(surfaces.openConversationDetails).toHaveBeenCalledWith('conv_1', { page: 'general' });
    });

    test('waits for an opener that returns a promise', async () => {
        const order = [];
        const open = createSurfaceOpener(async () => ({
            openConversationPreferences: async () => {
                await Promise.resolve();
                order.push('opened');
            },
        }));

        await open('openConversationPreferences');
        order.push('after');

        expect(order).toEqual(['opened', 'after']);
    });

    test('does nothing, and says so, while the function is not exported yet', async () => {
        const open = createSurfaceOpener(async () => ({}));

        const opened = await open('openConversationDetails', 'conv_1');

        expect(opened).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('openConversationDetails');
    });

    test('looks the export up at each call, so a surface that arrives later opens', async () => {
        const surfaces = {};
        const open = createSurfaceOpener(async () => surfaces);

        expect(await open('openConversationPreferences')).toBe(false);
        surfaces.openConversationPreferences = jest.fn();
        expect(await open('openConversationPreferences')).toBe(true);
    });
});
