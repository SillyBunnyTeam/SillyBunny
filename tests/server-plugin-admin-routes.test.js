/* eslint-disable playwright/no-duplicate-hooks */
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';

import { SERVER_PLUGIN_PREPARE_LEASE_MS } from '../src/server-supervisor.js';

let server;
let baseUrl;
let configDirectory;
let router;
let scheduleServerPluginUpdate;

beforeAll(async () => {
    configDirectory = fs.mkdtempSync(`${os.tmpdir()}/sillybunny-plugin-admin-`);
    const configPath = `${configDirectory}/config.yaml`;
    fs.writeFileSync(configPath, 'enableServerPlugins: true\n');
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(configPath);
    ({ router, scheduleServerPluginUpdate } = await import('../src/endpoints/server-admin.js'));
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = {
            profile: {
                admin: request.headers['x-test-admin'] === 'true',
            },
        };
        next();
    });
    app.use('/api/server-admin', router);

    await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(configDirectory, { recursive: true, force: true });
});

describe('server plugin admin routes', () => {
    test('requires an administrator for capability discovery', async () => {
        const response = await fetch(`${baseUrl}/api/server-admin/server-plugins/capabilities`);
        expect(response.status).toBe(403);
    });

    test('reports exact-release support but disables it without the built-in supervisor', async () => {
        const response = await fetch(`${baseUrl}/api/server-admin/server-plugins/capabilities`, {
            headers: { 'X-Test-Admin': 'true' },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            apiVersion: 1,
            exactGitRelease: true,
            existingPluginsOnly: true,
            installsDependencies: true,
            safeRestart: false,
            available: false,
            serverPluginsEnabled: true,
        });
        expect(typeof body.serverPluginsEnabled).toBe('boolean');
        expect(typeof body.serverBootId).toBe('string');
    });

    test('requires an administrator before accepting an update request', async () => {
        const response = await fetch(`${baseUrl}/api/server-admin/server-plugins/apply-release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ directoryName: 'ExamplePlugin', targetVersion: '2.0.0' }),
        });

        expect(response.status).toBe(403);
    });

    test('rejects an authorized update when safe supervisor handoff is unavailable', async () => {
        const response = await fetch(`${baseUrl}/api/server-admin/server-plugins/apply-release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Test-Admin': 'true' },
            body: JSON.stringify({ directoryName: 'ExamplePlugin', targetVersion: '2.0.0' }),
        });
        const body = await response.json();

        expect(response.status).toBe(503);
        expect(body.code).toBe('safe_restart_unavailable');
    });

    test('requests update shutdown only after the response finishes', async () => {
        jest.useFakeTimers();
        const response = new EventEmitter();
        response.destroyed = false;
        const prepareHandoff = jest.fn(async () => undefined);
        const requestExit = jest.fn();

        await scheduleServerPluginUpdate(response, {
            transactionId: '11111111-1111-4111-8111-111111111111',
            directoryName: 'ExamplePlugin',
        }, { prepareHandoff, requestExit, restartDelayMs: 1 });

        expect(prepareHandoff).toHaveBeenCalledTimes(1);
        expect(requestExit).not.toHaveBeenCalled();
        response.emit('finish');
        jest.runAllTimers();
        expect(requestExit).toHaveBeenCalledWith(76);
    });

    test('cancels a prepared update when the client disconnects', async () => {
        const response = new EventEmitter();
        response.destroyed = false;
        const cancelHandoff = jest.fn(async () => undefined);

        await scheduleServerPluginUpdate(response, {
            transactionId: '11111111-1111-4111-8111-111111111111',
            directoryName: 'ExamplePlugin',
        }, { prepareHandoff: async () => undefined, cancelHandoff });
        response.emit('close');
        await new Promise(resolve => setImmediate(resolve));

        expect(cancelHandoff).toHaveBeenCalledTimes(1);
    });

    test('does not delete a possibly queued update until an unacknowledged handoff lease expires', async () => {
        jest.useFakeTimers();
        const response = new EventEmitter();
        response.destroyed = false;
        const stagedUpdate = {
            transactionId: '11111111-1111-4111-8111-111111111111',
            directoryName: 'ExamplePlugin',
        };
        const discardStaged = jest.fn();

        await expect(scheduleServerPluginUpdate(response, stagedUpdate, {
            prepareHandoff: async () => { throw new Error('prepare acknowledgement lost'); },
            cancelHandoff: async () => { throw new Error('cancel acknowledgement lost'); },
            discardStaged,
        })).rejects.toThrow('prepare acknowledgement lost');

        expect(discardStaged).not.toHaveBeenCalled();
        jest.advanceTimersByTime(SERVER_PLUGIN_PREPARE_LEASE_MS + 1000);
        expect(discardStaged).toHaveBeenCalledWith(stagedUpdate);
    });

    test('keeps supervisor ownership when a destroyed response cannot confirm cancellation', async () => {
        jest.useFakeTimers();
        const response = new EventEmitter();
        response.destroyed = true;
        const stagedUpdate = {
            transactionId: '11111111-1111-4111-8111-111111111111',
            directoryName: 'ExamplePlugin',
        };
        const discardStaged = jest.fn();
        let thrown;

        try {
            await scheduleServerPluginUpdate(response, stagedUpdate, {
                prepareHandoff: async () => undefined,
                cancelHandoff: async () => { throw new Error('cancel acknowledgement lost'); },
                discardStaged,
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toMatchObject({ serverPluginHandoffManaged: true });
        expect(discardStaged).not.toHaveBeenCalled();
        jest.advanceTimersByTime(SERVER_PLUGIN_PREPARE_LEASE_MS + 1000);
        expect(discardStaged).toHaveBeenCalledWith(stagedUpdate);
    });
});
