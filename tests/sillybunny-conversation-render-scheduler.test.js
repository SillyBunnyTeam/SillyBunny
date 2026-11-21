import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const scheduler = await import('../public/scripts/sillybunny-conversation/render-scheduler.js');

describe('afterConversationRender', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        scheduler.flushConversationRenders();
        jest.useRealTimers();
    });

    test('runs after a flush that has no renderer pending, so a caller never depends on a delay', () => {
        const observer = jest.fn(() => true);

        scheduler.afterConversationRender(observer);
        expect(observer).not.toHaveBeenCalled();
        jest.runOnlyPendingTimers();

        expect(observer).toHaveBeenCalledTimes(1);
    });

    test('runs once the renderers of the same flush have run', () => {
        const order = [];
        scheduler.registerConversationRenderer('interface', () => order.push('interface'));

        scheduler.scheduleInterfaceRefresh();
        scheduler.afterConversationRender(() => {
            order.push('observer');
            return true;
        });
        jest.runOnlyPendingTimers();

        expect(order).toEqual(['interface', 'observer']);
    });

    test('keeps waiting for the next flush while the callback returns false, and stops after it returns true', () => {
        let ready = false;
        const observer = jest.fn(() => ready);

        scheduler.afterConversationRender(observer);
        jest.runOnlyPendingTimers();
        expect(observer).toHaveBeenCalledTimes(1);

        scheduler.flushConversationRenders();
        expect(observer).toHaveBeenCalledTimes(2);

        ready = true;
        scheduler.flushConversationRenders();
        expect(observer).toHaveBeenCalledTimes(3);

        scheduler.flushConversationRenders();
        expect(observer).toHaveBeenCalledTimes(3);
    });

    test('drops a callback that throws and lets the others run', () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const failing = jest.fn(() => {
            throw new Error('boom');
        });
        const healthy = jest.fn(() => true);

        scheduler.afterConversationRender(failing);
        scheduler.afterConversationRender(healthy);
        scheduler.flushConversationRenders();
        scheduler.flushConversationRenders();

        expect(failing).toHaveBeenCalledTimes(1);
        expect(healthy).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });
});
