import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    RESTART_EXIT_CODE,
    runSupervisor,
    SUPERVISOR_CRASH_RESTART_DELAY_MS,
    SUPERVISOR_CRASH_RESTART_LIMIT,
    SUPERVISOR_CRASH_WINDOW_MS,
} from '../src/server-supervisor.js';
import { SERVER_STARTUP_READY_MESSAGE } from '../src/server-plugin-update-ipc.js';

const CRASH_CODE = 1;
const TRACKED_EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'exit'];

class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.connected = true;
        this.exitCode = null;
        this.kill = jest.fn();
        this.send = jest.fn((_message, callback) => callback?.());
    }
}

function createPluginUpdateOperations() {
    return {
        validate: jest.fn(),
        apply: jest.fn(),
        discard: jest.fn(),
        discardPrepared: jest.fn(),
        finalize: jest.fn(),
        recover: jest.fn(),
        rollback: jest.fn(),
    };
}

function startSupervisor() {
    const children = [];
    const spawnFn = jest.fn(() => {
        const child = new FakeChild();
        children.push(child);
        return child;
    });
    const exitFn = jest.fn();
    const run = runSupervisor({
        argv: ['node', 'server.js'],
        execArgv: [],
        spawnFn,
        exitFn,
        pluginUpdate: createPluginUpdateOperations(),
    });
    return { children, spawnFn, exitFn, run };
}

function reportStartup(child) {
    child.emit('message', { type: SERVER_STARTUP_READY_MESSAGE, plugins: [] });
}

function exitChild(child, code, signal = null) {
    child.exitCode = code;
    child.emit('exit', code, signal);
}

async function tick() {
    await new Promise(resolve => setImmediate(resolve));
}

function crashDelay(restart) {
    return SUPERVISOR_CRASH_RESTART_DELAY_MS * 2 ** (restart - 1);
}

async function crashAndRestart(children, restart) {
    reportStartup(children.at(-1));
    exitChild(children.at(-1), CRASH_CODE);
    await tick();
    jest.advanceTimersByTime(crashDelay(restart));
    await tick();
}

describe('server supervisor crash restarts', () => {
    const savedListeners = new Map();
    let consoleWarn;
    let consoleError;

    beforeEach(() => {
        for (const event of TRACKED_EVENTS) {
            savedListeners.set(event, process.listeners(event));
            process.removeAllListeners(event);
        }
        jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'] });
        consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        consoleWarn.mockRestore();
        consoleError.mockRestore();
        for (const event of TRACKED_EVENTS) {
            process.removeAllListeners(event);
            for (const listener of savedListeners.get(event) ?? []) {
                process.on(event, listener);
            }
        }
    });

    test('relaunches a server that crashes after startup once the delay has passed', async () => {
        const { children, spawnFn, exitFn, run } = startSupervisor();

        reportStartup(children[0]);
        exitChild(children[0], CRASH_CODE);
        await tick();
        expect(exitFn).not.toHaveBeenCalled();
        expect(consoleWarn).toHaveBeenCalledWith('[SillyBunny] Server crashed (exit code 1). Restarting in 1 s...');

        jest.advanceTimersByTime(SUPERVISOR_CRASH_RESTART_DELAY_MS - 1);
        await tick();
        expect(spawnFn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(1);
        await tick();
        expect(spawnFn).toHaveBeenCalledTimes(2);
        expect(spawnFn.mock.calls[1][2].env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH).toBe('1');

        reportStartup(children[1]);
        exitChild(children[1], 0);
        await run;
        expect(exitFn).toHaveBeenCalledWith(0);
        expect(spawnFn).toHaveBeenCalledTimes(2);
    });

    test('doubles the delay with each crash restart inside the window', async () => {
        const { children, spawnFn, exitFn, run } = startSupervisor();

        for (let restart = 1; restart <= 3; restart++) {
            reportStartup(children.at(-1));
            exitChild(children.at(-1), CRASH_CODE);
            await tick();
            jest.advanceTimersByTime(crashDelay(restart) - 1);
            await tick();
            expect(spawnFn).toHaveBeenCalledTimes(restart);
            jest.advanceTimersByTime(1);
            await tick();
            expect(spawnFn).toHaveBeenCalledTimes(restart + 1);
        }

        expect(consoleWarn.mock.calls.map(([message]) => message)).toEqual([
            '[SillyBunny] Server crashed (exit code 1). Restarting in 1 s...',
            '[SillyBunny] Server crashed (exit code 1). Restarting in 2 s...',
            '[SillyBunny] Server crashed (exit code 1). Restarting in 4 s...',
        ]);
        exitChild(children.at(-1), 0);
        await run;
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('gives up after the restart limit inside the window and passes on the exit code', async () => {
        const { children, spawnFn, exitFn, run } = startSupervisor();

        for (let restart = 1; restart <= SUPERVISOR_CRASH_RESTART_LIMIT; restart++) {
            await crashAndRestart(children, restart);
        }
        expect(spawnFn).toHaveBeenCalledTimes(SUPERVISOR_CRASH_RESTART_LIMIT + 1);
        expect(exitFn).not.toHaveBeenCalled();

        reportStartup(children.at(-1));
        exitChild(children.at(-1), CRASH_CODE);
        await run;

        expect(exitFn).toHaveBeenCalledWith(CRASH_CODE);
        expect(spawnFn).toHaveBeenCalledTimes(SUPERVISOR_CRASH_RESTART_LIMIT + 1);
        expect(consoleError).toHaveBeenCalledWith(
            `[SillyBunny] Server crashed (exit code 1) after ${SUPERVISOR_CRASH_RESTART_LIMIT} restarts within ${SUPERVISOR_CRASH_WINDOW_MS / 60_000} minutes. Not restarting it.`,
        );
    });

    test('counts only the crash restarts inside the window', async () => {
        const { children, spawnFn, exitFn, run } = startSupervisor();
        const crashCount = SUPERVISOR_CRASH_RESTART_LIMIT + 2;
        const spacingMs = Math.ceil(SUPERVISOR_CRASH_WINDOW_MS / (SUPERVISOR_CRASH_RESTART_LIMIT - 1));

        for (let crash = 1; crash <= crashCount; crash++) {
            reportStartup(children.at(-1));
            exitChild(children.at(-1), CRASH_CODE);
            await tick();
            jest.advanceTimersByTime(spacingMs);
            await tick();
            expect(spawnFn).toHaveBeenCalledTimes(crash + 1);
        }

        expect(exitFn).not.toHaveBeenCalled();
        exitChild(children.at(-1), 0);
        await run;
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('relaunches a server that dies from a signal after startup', async () => {
        const { children, spawnFn, exitFn } = startSupervisor();

        reportStartup(children[0]);
        exitChild(children[0], null, 'SIGKILL');
        await tick();
        expect(consoleWarn).toHaveBeenCalledWith('[SillyBunny] Server crashed (signal SIGKILL). Restarting in 1 s...');

        jest.advanceTimersByTime(SUPERVISOR_CRASH_RESTART_DELAY_MS);
        await tick();
        expect(spawnFn).toHaveBeenCalledTimes(2);
        expect(exitFn).not.toHaveBeenCalled();
    });

    test('ends the restart wait at once when a stop is requested', async () => {
        const { children, spawnFn, exitFn, run } = startSupervisor();

        reportStartup(children[0]);
        exitChild(children[0], CRASH_CODE);
        await tick();
        expect(exitFn).not.toHaveBeenCalled();

        process.emit('SIGINT');
        await run;
        expect(exitFn).toHaveBeenCalledWith(CRASH_CODE);
        expect(jest.getTimerCount()).toBe(0);

        jest.advanceTimersByTime(crashDelay(2));
        await tick();
        expect(spawnFn).toHaveBeenCalledTimes(1);
    });

    test('does not count requested restarts against the crash limit', async () => {
        const { children, spawnFn, exitFn, run } = startSupervisor();

        for (let restart = 1; restart < SUPERVISOR_CRASH_RESTART_LIMIT; restart++) {
            await crashAndRestart(children, restart);
        }
        reportStartup(children.at(-1));
        exitChild(children.at(-1), RESTART_EXIT_CODE);
        await tick();
        expect(spawnFn).toHaveBeenCalledTimes(SUPERVISOR_CRASH_RESTART_LIMIT + 1);

        await crashAndRestart(children, SUPERVISOR_CRASH_RESTART_LIMIT);
        expect(spawnFn).toHaveBeenCalledTimes(SUPERVISOR_CRASH_RESTART_LIMIT + 2);
        expect(exitFn).not.toHaveBeenCalled();

        reportStartup(children.at(-1));
        exitChild(children.at(-1), CRASH_CODE);
        await run;
        expect(exitFn).toHaveBeenCalledWith(CRASH_CODE);
    });

    test('passes on a failure before startup of a relaunched server', async () => {
        const { children, spawnFn, exitFn, run } = startSupervisor();

        await crashAndRestart(children, 1);
        expect(spawnFn).toHaveBeenCalledTimes(2);

        exitChild(children[1], CRASH_CODE);
        await run;
        expect(exitFn).toHaveBeenCalledWith(CRASH_CODE);
        expect(spawnFn).toHaveBeenCalledTimes(2);
    });

    test('passes on the exit code of a server that fails before it reports startup', async () => {
        const { children, spawnFn, exitFn, run } = startSupervisor();

        exitChild(children[0], CRASH_CODE);
        await run;

        expect(exitFn).toHaveBeenCalledWith(CRASH_CODE);
        expect(spawnFn).toHaveBeenCalledTimes(1);
        expect(consoleWarn).not.toHaveBeenCalled();
    });

    test('exits with 0 when a started server stops cleanly', async () => {
        const { children, spawnFn, exitFn, run } = startSupervisor();

        reportStartup(children[0]);
        exitChild(children[0], 0);
        await run;

        expect(exitFn).toHaveBeenCalledWith(0);
        expect(spawnFn).toHaveBeenCalledTimes(1);
        expect(consoleWarn).not.toHaveBeenCalled();
    });

    test('relaunches at once on the restart exit code', async () => {
        const { children, spawnFn, exitFn } = startSupervisor();

        reportStartup(children[0]);
        exitChild(children[0], RESTART_EXIT_CODE);
        await tick();

        expect(spawnFn).toHaveBeenCalledTimes(2);
        expect(exitFn).not.toHaveBeenCalled();
        expect(consoleWarn).not.toHaveBeenCalled();
    });

    test('does not relaunch a server that exits non-zero during a requested stop', async () => {
        const { children, spawnFn, exitFn, run } = startSupervisor();

        reportStartup(children[0]);
        process.emit('SIGTERM');
        exitChild(children[0], CRASH_CODE);
        await run;

        expect(exitFn).toHaveBeenCalledWith(CRASH_CODE);
        expect(spawnFn).toHaveBeenCalledTimes(1);
    });
});
