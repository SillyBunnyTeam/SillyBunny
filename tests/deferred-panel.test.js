import { describe, expect, jest, test } from '@jest/globals';
import { createDeferredPanel } from '../public/scripts/deferred-panel.js';

function controlledLoad() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe('deferred panel lifecycle', () => {
    test('does no loading until the panel is requested', () => {
        const load = jest.fn();
        createDeferredPanel(load);
        expect(load).not.toHaveBeenCalled();
    });

    test('search hydration shares one load without activating the panel', async () => {
        const pending = controlledLoad();
        const onActivate = jest.fn();
        const content = { onActivate };
        const load = jest.fn(() => pending.promise);
        const panel = createDeferredPanel(load);
        const first = panel.ensureReady();
        const second = panel.ensureReady();
        expect(first).toBe(second);
        pending.resolve(content);
        await expect(first).resolves.toBe(content);
        await expect(panel.ensureReady()).resolves.toBe(content);
        expect(load).toHaveBeenCalledTimes(1);
        expect(onActivate).not.toHaveBeenCalled();
    });

    test('duplicate open notifications activate once and reopening reuses the panel', async () => {
        const onActivate = jest.fn();
        const onDeactivate = jest.fn();
        const load = jest.fn(async () => ({ onActivate, onDeactivate }));
        const panel = createDeferredPanel(load);
        await Promise.all([panel.activate(), panel.activate()]);
        expect(onActivate).toHaveBeenCalledTimes(1);
        panel.deactivate();
        panel.deactivate();
        expect(onDeactivate).toHaveBeenCalledTimes(1);
        await panel.activate();
        expect(onActivate).toHaveBeenCalledTimes(2);
        expect(load).toHaveBeenCalledTimes(1);
    });

    test('closing during import prevents a late request or polling loop', async () => {
        const pending = controlledLoad();
        const onActivate = jest.fn();
        const onDeactivate = jest.fn();
        const panel = createDeferredPanel(() => pending.promise);
        const opening = panel.activate();
        panel.deactivate();
        pending.resolve({ onActivate, onDeactivate });
        await opening;
        expect(onActivate).not.toHaveBeenCalled();
        expect(onDeactivate).not.toHaveBeenCalled();
        await panel.activate();
        expect(onActivate).toHaveBeenCalledTimes(1);
    });

    test('failed imports remain retryable without caching a broken panel', async () => {
        const onActivate = jest.fn();
        const load = jest.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ onActivate });
        const panel = createDeferredPanel(load);
        await expect(panel.activate()).rejects.toThrow('offline');
        await panel.activate();
        expect(load).toHaveBeenCalledTimes(2);
        expect(onActivate).toHaveBeenCalledTimes(1);
    });

    test('an activation failure can be retried without rebuilding the panel', async () => {
        const onActivate = jest.fn()
            .mockImplementationOnce(() => { throw new Error('not ready'); })
            .mockImplementation(() => {});
        const load = jest.fn(async () => ({ onActivate }));
        const panel = createDeferredPanel(load);
        await expect(panel.activate()).rejects.toThrow('not ready');
        await panel.activate();
        expect(load).toHaveBeenCalledTimes(1);
        expect(onActivate).toHaveBeenCalledTimes(2);
    });
});
