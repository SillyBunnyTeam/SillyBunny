import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const SERVER_MAIN_SOURCE = new URL('../src/server-main.js', import.meta.url);

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

    test('does not wire process signals directly to the exit function', () => {
        const source = readFileSync(SERVER_MAIN_SOURCE, 'utf8');

        expect(source).toContain("process.on('SIGINT', () => exitProcess(0));");
        expect(source).toContain("process.on('SIGTERM', () => exitProcess(0));");
        expect(source).not.toContain("process.on('SIGINT', exitProcess);");
        expect(source).not.toContain("process.on('SIGTERM', exitProcess);");
    });
});
