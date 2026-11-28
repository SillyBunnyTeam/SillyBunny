import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import process from 'node:process';

import { bootServerMainHarness } from './util/server-main-harness.js';

async function loadShutdownModule() {
    jest.resetModules();
    return import('../src/shutdown.js');
}

describe('graceful shutdown', () => {
    let exitSpy;
    let consoleErrorSpy;

    beforeEach(() => {
        jest.useFakeTimers();
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        exitSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        jest.resetModules();
    });

    test('normalizes signal strings before exiting', async () => {
        const { normalizeExitCode } = await loadShutdownModule();

        expect(normalizeExitCode('SIGINT')).toBe(0);
        expect(normalizeExitCode('SIGTERM')).toBe(0);
        expect(normalizeExitCode('130')).toBe(130);
        expect(normalizeExitCode(1)).toBe(1);
    });

    test('passes a numeric exit code to registered shutdown handlers and timeout exits', async () => {
        const { registerGracefulShutdown, requestGracefulExit } = await loadShutdownModule();
        const shutdownFn = jest.fn();

        registerGracefulShutdown(shutdownFn);
        requestGracefulExit('SIGINT');

        expect(shutdownFn).toHaveBeenCalledWith(0);
        expect(exitSpy).not.toHaveBeenCalled();

        jest.runOnlyPendingTimers();

        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('forcing exit with code 0'));
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('uses a numeric exit code when no shutdown handler is registered', async () => {
        const { requestGracefulExit } = await loadShutdownModule();

        requestGracefulExit('SIGTERM');

        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test.each(['SIGINT', 'SIGTERM'])('server-main %s listener exits with numeric 0 instead of the signal name', async (signal) => {
        jest.useRealTimers();
        const harness = await bootServerMainHarness();
        try {
            const listeners = harness.signalHandlers.get(signal) ?? [];
            expect(listeners.length).toBeGreaterThan(0);

            // Node passes the signal name as the first argument when invoking a signal listener.
            const listener = listeners[listeners.length - 1];
            await listener(signal);

            expect(exitSpy).toHaveBeenCalledWith(0);
        } finally {
            harness.cleanup();
        }
    });
});
