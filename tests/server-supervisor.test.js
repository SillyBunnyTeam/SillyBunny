import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { RESTART_EXIT_CODE, runSupervisor, shouldSupervise } from '../src/server-supervisor.js';

class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.exitCode = null;
        this.kill = jest.fn();
    }
}

function createSpawnPlan(exits) {
    const children = [];
    const spawnFn = jest.fn(() => {
        const child = new FakeChild();
        children.push(child);
        const exit = exits.shift() ?? [0, null];
        if (exit !== 'manual') {
            setImmediate(() => {
                child.exitCode = exit[0];
                child.emit('exit', exit[0], exit[1]);
            });
        }
        return child;
    });

    return { children, spawnFn };
}

const TRACKED_EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'exit'];

describe('server supervisor', () => {
    const savedListeners = new Map();

    beforeEach(() => {
        for (const signal of TRACKED_EVENTS) {
            savedListeners.set(signal, process.listeners(signal));
            process.removeAllListeners(signal);
        }
    });

    afterEach(() => {
        for (const signal of TRACKED_EVENTS) {
            process.removeAllListeners(signal);
            for (const listener of savedListeners.get(signal) ?? []) {
                process.on(signal, listener);
            }
        }
    });

    test('shouldSupervise is true only for unmanaged direct launches', () => {
        expect(shouldSupervise({})).toBe(true);
        expect(shouldSupervise({ SILLYBUNNY_LAUNCHER: '1' })).toBe(false);
        expect(shouldSupervise({ SILLYBUNNY_SUPERVISED: '1' })).toBe(false);
        expect(shouldSupervise({ SILLYBUNNY_LAUNCHER: '', SILLYBUNNY_SUPERVISED: '' })).toBe(true);
    });

    test('marks the child as supervised and forwards runtime flags', async () => {
        const { spawnFn } = createSpawnPlan([[0, null]]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['bun', 'server.js', '--listen'], execArgv: ['--smol'], spawnFn, exitFn });

        expect(spawnFn).toHaveBeenCalledTimes(1);
        const [command, args, options] = spawnFn.mock.calls[0];
        expect(command).toBe('bun');
        expect(args).toEqual(['--smol', 'server.js', '--listen']);
        expect(options.stdio).toBe('inherit');
        expect(options.env.SILLYBUNNY_SUPERVISED).toBe('1');
        expect(options.env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH).toBeUndefined();
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('respawns on the restart exit code and suppresses the browser auto-launch', async () => {
        const { spawnFn } = createSpawnPlan([[RESTART_EXIT_CODE, null], [RESTART_EXIT_CODE, null], [0, null]]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        expect(spawnFn).toHaveBeenCalledTimes(3);
        expect(spawnFn.mock.calls[0][2].env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH).toBeUndefined();
        expect(spawnFn.mock.calls[1][2].env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH).toBe('1');
        expect(spawnFn.mock.calls[2][2].env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH).toBe('1');
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('mirrors a non-restart exit code', async () => {
        const { spawnFn } = createSpawnPlan([[3, null]]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        expect(spawnFn).toHaveBeenCalledTimes(1);
        expect(exitFn).toHaveBeenCalledWith(3);
    });

    test('exits non-zero when the child dies from a signal', async () => {
        const { spawnFn } = createSpawnPlan([[null, 'SIGKILL']]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        expect(exitFn).toHaveBeenCalledWith(1);
    });

    test('forwards termination signals to the child and does not respawn afterwards', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();

        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });
        await new Promise(resolve => setImmediate(resolve));

        process.emit('SIGTERM');
        expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');

        children[0].exitCode = RESTART_EXIT_CODE;
        children[0].emit('exit', RESTART_EXIT_CODE, null);
        await run;

        expect(spawnFn).toHaveBeenCalledTimes(1);
        expect(exitFn).toHaveBeenCalledWith(RESTART_EXIT_CODE);
    });

    // Windows raises these when the console window is closed or Ctrl+Break is
    // pressed, and it does not kill children with their parent.
    test.each(['SIGHUP', 'SIGBREAK'])('forwards %s so the console close does not orphan the server', async (signal) => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();

        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });
        await new Promise(resolve => setImmediate(resolve));

        process.emit(signal);
        expect(children[0].kill).toHaveBeenCalledWith(signal);

        children[0].exitCode = RESTART_EXIT_CODE;
        children[0].emit('exit', RESTART_EXIT_CODE, null);
        await run;

        expect(spawnFn).toHaveBeenCalledTimes(1);
    });

    test('kills a running child when the supervisor itself exits', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();

        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });
        await new Promise(resolve => setImmediate(resolve));

        process.emit('exit', 0);
        expect(children[0].kill).toHaveBeenCalledTimes(1);

        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;
    });

    test('does not kill a child that already exited', async () => {
        const { children, spawnFn } = createSpawnPlan([[0, null]]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        process.emit('exit', 0);

        expect(children[0].kill).not.toHaveBeenCalled();
    });
});
