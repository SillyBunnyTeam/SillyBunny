import { describe, expect, jest, test } from '@jest/globals';
import { createDeferredModule, createLazyController } from '../public/scripts/deferred-module.js';

describe('on-demand module imports', () => {
    test('imports only on demand and shares the successful module and in-flight request', async () => {
        const module = {};
        const importModule = jest.fn().mockResolvedValue(module);
        const load = createDeferredModule(new URL('https://example.test/panel.js?v=1'), importModule);
        expect(importModule).not.toHaveBeenCalled();
        const first = load();
        expect(load()).toBe(first);
        await expect(first).resolves.toBe(module);
        await expect(load()).resolves.toBe(module);
        expect(importModule).toHaveBeenCalledTimes(1);
        expect(importModule).toHaveBeenCalledWith('https://example.test/panel.js?v=1');
    });

    test('bypasses a failed module URL only on the next explicit request', async () => {
        const module = {};
        const importModule = jest.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(module);
        const load = createDeferredModule(new URL('https://example.test/panel.js?v=1'), importModule);
        const first = load();
        expect(load()).toBe(first);
        await expect(first).rejects.toThrow('offline');
        expect(importModule).toHaveBeenCalledTimes(1);
        await expect(load()).resolves.toBe(module);
        await expect(load()).resolves.toBe(module);
        expect(importModule).toHaveBeenCalledTimes(2);
        expect(importModule).toHaveBeenLastCalledWith('https://example.test/panel.js?v=1&sb-retry=1');
    });

    test('each explicit failed retry uses a new URL', async () => {
        const importModule = jest.fn().mockRejectedValue(new Error('offline'));
        const load = createDeferredModule(new URL('https://example.test/panel.js'), importModule);
        await expect(load()).rejects.toThrow('offline');
        await expect(load()).rejects.toThrow('offline');
        await expect(load()).rejects.toThrow('offline');
        expect(importModule.mock.calls.map(([specifier]) => specifier)).toEqual([
            'https://example.test/panel.js',
            'https://example.test/panel.js?sb-retry=1',
            'https://example.test/panel.js?sb-retry=2',
        ]);
    });
});

describe('lazy controllers', () => {
    const url = new URL('https://example.test/controller.js?v=1');

    test('builds nothing until it is asked, then once, and shares the in-flight request', async () => {
        const module = { make: jest.fn(() => ({ id: 'controller' })) };
        const importModule = jest.fn().mockResolvedValue(module);
        const create = jest.fn(loaded => loaded.make());
        const lazy = createLazyController(url, create, importModule);

        expect(lazy.current).toBeNull();
        expect(importModule).not.toHaveBeenCalled();

        const first = lazy.load();
        expect(lazy.load()).toBe(first);
        const controller = await first;
        expect(controller).toEqual({ id: 'controller' });
        expect(lazy.current).toBe(controller);
        await expect(lazy.load()).resolves.toBe(controller);
        expect(importModule).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledTimes(1);
    });

    test('retries a failed import on a new URL, as the module loader does', async () => {
        const importModule = jest.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ make: () => 'controller' });
        const lazy = createLazyController(url, loaded => loaded.make(), importModule);

        await expect(lazy.load()).rejects.toThrow('offline');
        expect(lazy.current).toBeNull();
        await expect(lazy.load()).resolves.toBe('controller');
        expect(importModule.mock.calls.map(([specifier]) => specifier)).toEqual([
            'https://example.test/controller.js?v=1',
            'https://example.test/controller.js?v=1&sb-retry=1',
        ]);
        expect(lazy.current).toBe('controller');
    });

    test('builds again after the builder threw, from the module that already loaded', async () => {
        const importModule = jest.fn().mockResolvedValue({});
        const create = jest.fn()
            .mockImplementationOnce(() => { throw new Error('bad dependencies'); })
            .mockImplementationOnce(() => 'controller');
        const lazy = createLazyController(url, create, importModule);

        await expect(lazy.load()).rejects.toThrow('bad dependencies');
        expect(lazy.current).toBeNull();
        await expect(lazy.load()).resolves.toBe('controller');
        expect(importModule).toHaveBeenCalledTimes(1);
    });
});
