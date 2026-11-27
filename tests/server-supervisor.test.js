import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    RESTART_EXIT_CODE,
    runSupervisor,
    SERVER_PLUGIN_PREPARE_LEASE_MS,
    SERVER_PLUGIN_UPDATE_EXIT_CODE,
    shouldSupervise,
    SUPERVISOR_FORCE_KILL_TIMEOUT_MS,
    SUPERVISOR_RELOAD_EXIT_CODE,
    SUPERVISOR_SHUTDOWN_MESSAGE,
} from '../src/server-supervisor.js';
import {
    SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE,
    SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
    SERVER_STARTUP_READY_MESSAGE,
} from '../src/server-plugin-update-ipc.js';

class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.connected = true;
        this.exitCode = null;
        this.kill = jest.fn();
        this.send = jest.fn((_message, callback) => callback?.());
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

function createPluginUpdateOperations() {
    return {
        validate: jest.fn(),
        apply: jest.fn(payload => ({ ...payload, backupPath: '/backup', logPath: '/update.log' })),
        discard: jest.fn(),
        discardPrepared: jest.fn(),
        finalize: jest.fn(),
        recover: jest.fn(),
        rollback: jest.fn(),
    };
}

function updatePayload() {
    return {
        transactionId: '11111111-1111-4111-8111-111111111111',
        expectedPluginId: 'example-plugin',
        pluginPath: '/plugins/ExamplePlugin',
    };
}

async function tick() {
    await new Promise(resolve => setImmediate(resolve));
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

    // eslint-disable-next-line playwright/no-duplicate-hooks -- this is a Jest suite; the Playwright rule misclassifies the signal tests below
    afterEach(() => {
        jest.useRealTimers();
        for (const signal of TRACKED_EVENTS) {
            process.removeAllListeners(signal);
            for (const listener of savedListeners.get(signal) ?? []) {
                process.on(signal, listener);
            }
        }
    });

    test('shouldSupervise lets launchers wrap one built-in supervisor', () => {
        expect(shouldSupervise({})).toBe(true);
        expect(shouldSupervise({ SILLYBUNNY_LAUNCHER: '1' })).toBe(true);
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
        expect(options.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']);
        expect(options.env.SILLYBUNNY_SUPERVISED).toBe('1');
        expect(options.env[SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV]).toBe(SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION);
        expect(options.env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH).toBeUndefined();
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('recovers interrupted plugin transactions before launching the server', async () => {
        const { spawnFn } = createSpawnPlan([[0, null]]);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();

        await runSupervisor({
            argv: ['node', 'server.js'],
            execArgv: [],
            spawnFn,
            exitFn,
            pluginUpdate,
            pluginsRoot: '/managed/plugins',
        });

        expect(pluginUpdate.recover).toHaveBeenCalledWith('/managed/plugins');
        expect(pluginUpdate.recover.mock.invocationCallOrder[0]).toBeLessThan(spawnFn.mock.invocationCallOrder[0]);
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

    test('applies a queued plugin update after cleanup and finalizes it only after the plugin loads', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual', 'manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: ['--max-old-space-size=2048'], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-1', payload });
        expect(pluginUpdate.validate).toHaveBeenCalledWith(payload);
        expect(children[0].send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'prepare-1', ok: true }), expect.any(Function));

        children[0].exitCode = SERVER_PLUGIN_UPDATE_EXIT_CODE;
        children[0].emit('exit', SERVER_PLUGIN_UPDATE_EXIT_CODE, null);
        await tick();

        expect(pluginUpdate.apply).toHaveBeenCalledWith(payload);
        expect(spawnFn).toHaveBeenCalledTimes(2);
        expect(spawnFn.mock.calls[1][1]).toEqual(['--max-old-space-size=2048', 'server.js']);
        children[1].emit('message', {
            type: SERVER_STARTUP_READY_MESSAGE,
            plugins: [{ id: 'example-plugin', directoryPath: '/plugins/ExamplePlugin' }],
        });
        await tick();
        expect(pluginUpdate.finalize).toHaveBeenCalledWith(expect.objectContaining({ expectedPluginId: 'example-plugin' }));

        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);
        await run;
        expect(pluginUpdate.rollback).not.toHaveBeenCalled();
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('survives an asynchronous IPC response failure', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();
        children[0].send.mockImplementation((_message, callback) => callback(new Error('IPC closed')));

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-closed', payload });
        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;

        expect(pluginUpdate.discardPrepared).toHaveBeenCalledWith(payload);
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('keeps the activated server running when final lock cleanup fails', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual', 'manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        pluginUpdate.finalize.mockImplementation(() => {
            const error = new Error('lock cleanup failed');
            error.serverPluginActivationRecorded = true;
            throw error;
        });
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-cleanup', payload });
        children[0].exitCode = SERVER_PLUGIN_UPDATE_EXIT_CODE;
        children[0].emit('exit', SERVER_PLUGIN_UPDATE_EXIT_CODE, null);
        await tick();
        children[1].emit('message', {
            type: SERVER_STARTUP_READY_MESSAGE,
            plugins: [{ id: 'example-plugin', directoryPath: '/plugins/ExamplePlugin' }],
        });
        await tick();

        expect(exitFn).not.toHaveBeenCalled();
        expect(pluginUpdate.recover).toHaveBeenCalledTimes(2);
        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);
        await run;
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('immediately rolls back when durable activation recording fails', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual', 'manual', 'manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        pluginUpdate.finalize.mockImplementation(() => {
            const error = new Error('journal fsync failed');
            error.serverPluginActivationRecorded = false;
            throw error;
        });
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-journal', payload });
        children[0].exitCode = SERVER_PLUGIN_UPDATE_EXIT_CODE;
        children[0].emit('exit', SERVER_PLUGIN_UPDATE_EXIT_CODE, null);
        await tick();
        children[1].emit('message', {
            type: SERVER_STARTUP_READY_MESSAGE,
            plugins: [{ id: 'example-plugin', directoryPath: '/plugins/ExamplePlugin' }],
        });
        await tick();

        expect(children[1].send).toHaveBeenCalledWith(SUPERVISOR_SHUTDOWN_MESSAGE, expect.any(Function));
        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);
        await tick();

        expect(pluginUpdate.rollback).toHaveBeenCalledWith(
            expect.objectContaining({ expectedPluginId: 'example-plugin' }),
            expect.stringContaining('durably'),
        );
        expect(spawnFn).toHaveBeenCalledTimes(3);
        children[2].exitCode = 0;
        children[2].emit('exit', 0, null);
        await run;
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('stops the updated child, rolls back, and starts the previous plugin when activation fails', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual', 'manual', 'manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-2', payload });
        children[0].exitCode = SERVER_PLUGIN_UPDATE_EXIT_CODE;
        children[0].emit('exit', SERVER_PLUGIN_UPDATE_EXIT_CODE, null);
        await tick();

        children[1].emit('message', {
            type: SERVER_STARTUP_READY_MESSAGE,
            plugins: [{ id: 'example-plugin', directoryPath: '/plugins/DifferentPlugin' }],
        });
        await tick();
        expect(children[1].send).toHaveBeenCalledWith(SUPERVISOR_SHUTDOWN_MESSAGE, expect.any(Function));
        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);
        await tick();

        expect(pluginUpdate.rollback).toHaveBeenCalledWith(expect.objectContaining({ expectedPluginId: 'example-plugin' }), expect.stringContaining('did not load'));
        expect(spawnFn).toHaveBeenCalledTimes(3);
        children[2].exitCode = 0;
        children[2].emit('exit', 0, null);
        await run;
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('rolls back without respawning when the supervisor is stopped during activation', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual', 'manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-stop', payload });
        children[0].exitCode = SERVER_PLUGIN_UPDATE_EXIT_CODE;
        children[0].emit('exit', SERVER_PLUGIN_UPDATE_EXIT_CODE, null);
        await tick();
        process.emit('SIGTERM');
        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);

        await run;
        expect(pluginUpdate.rollback).toHaveBeenCalled();
        expect(spawnFn).toHaveBeenCalledTimes(2);
        expect(exitFn).toHaveBeenCalledWith(0);
    });

    test('discards a queued update when the request is cancelled before shutdown', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });
        await tick();

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-3', payload });
        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE, requestId: 'cancel-3', payload });
        expect(pluginUpdate.discardPrepared).toHaveBeenCalledWith(payload);
        expect(children[0].send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'cancel-3', ok: true }), expect.any(Function));

        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;
        expect(pluginUpdate.apply).not.toHaveBeenCalled();
    });

    test('treats repeated PREPARE messages for one transaction as idempotent', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-a', payload });
        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-b', payload });
        expect(pluginUpdate.validate).toHaveBeenCalledTimes(1);
        expect(children[0].send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'prepare-a', ok: true }), expect.any(Function));
        expect(children[0].send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'prepare-b', ok: true }), expect.any(Function));

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE, requestId: 'cancel', payload });
        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;
    });

    test('discards a prepared update when its handoff lease expires', async () => {
        jest.useFakeTimers();
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const pluginUpdate = createPluginUpdateOperations();
        const payload = updatePayload();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn, pluginUpdate });

        children[0].emit('message', { type: SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, requestId: 'prepare-lease', payload });
        jest.advanceTimersByTime(SERVER_PLUGIN_PREPARE_LEASE_MS);
        expect(pluginUpdate.discardPrepared).toHaveBeenCalledWith(payload);

        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;
    });

    test('exits to the outer launcher when host code requires a fresh supervisor', async () => {
        const { spawnFn } = createSpawnPlan([[SUPERVISOR_RELOAD_EXIT_CODE, null]]);
        const exitFn = jest.fn();

        await runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        expect(spawnFn).toHaveBeenCalledTimes(1);
        expect(exitFn).toHaveBeenCalledWith(RESTART_EXIT_CODE);
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

    test('requests graceful child shutdown over IPC and does not respawn afterwards', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();

        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });
        await new Promise(resolve => setImmediate(resolve));

        process.emit('SIGTERM');
        expect(children[0].send).toHaveBeenCalledWith(SUPERVISOR_SHUTDOWN_MESSAGE, expect.any(Function));
        expect(children[0].kill).not.toHaveBeenCalled();

        children[0].exitCode = RESTART_EXIT_CODE;
        children[0].emit('exit', RESTART_EXIT_CODE, null);
        await run;

        expect(spawnFn).toHaveBeenCalledTimes(1);
        expect(exitFn).toHaveBeenCalledWith(RESTART_EXIT_CODE);
    });

    // Windows raises these when the console window is closed or Ctrl+Break is
    // pressed, and it does not kill children with their parent.
    for (const signal of ['SIGHUP', 'SIGBREAK']) {
        test(`requests graceful shutdown on ${signal} so the console close does not orphan the server`, async () => {
            const { children, spawnFn } = createSpawnPlan(['manual']);
            const exitFn = jest.fn();

            const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });
            await new Promise(resolve => setImmediate(resolve));

            process.emit(signal);
            expect(children[0].send).toHaveBeenCalledWith(SUPERVISOR_SHUTDOWN_MESSAGE, expect.any(Function));
            expect(children[0].kill).not.toHaveBeenCalled();

            children[0].exitCode = RESTART_EXIT_CODE;
            children[0].emit('exit', RESTART_EXIT_CODE, null);
            await run;

            expect(spawnFn).toHaveBeenCalledTimes(1);
        });
    }

    test('force-kills the child only when the IPC shutdown request fails', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const run = runSupervisor({ argv: ['bun', 'server.js'], execArgv: [], spawnFn, exitFn });
        await new Promise(resolve => setImmediate(resolve));
        children[0].send.mockImplementation((_message, callback) => callback(new Error('IPC closed')));

        process.emit('SIGHUP');

        expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
        children[0].exitCode = 0;
        children[0].emit('exit', 0, null);
        await run;
    });

    test('force-kills the child when graceful shutdown exceeds the timeout', async () => {
        jest.useFakeTimers();
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();
        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });

        process.emit('SIGTERM');
        expect(children[0].kill).not.toHaveBeenCalled();

        jest.advanceTimersByTime(SUPERVISOR_FORCE_KILL_TIMEOUT_MS);
        expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');

        children[0].exitCode = null;
        children[0].emit('exit', null, 'SIGKILL');
        await run;
    });

    test('kills a running child when the supervisor itself exits', async () => {
        const { children, spawnFn } = createSpawnPlan(['manual']);
        const exitFn = jest.fn();

        const run = runSupervisor({ argv: ['node', 'server.js'], execArgv: [], spawnFn, exitFn });
        await new Promise(resolve => setImmediate(resolve));

        process.emit('exit', 0);
        expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');

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
