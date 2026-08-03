import { EventEmitter } from 'node:events';

import { describe, expect, jest, test } from '@jest/globals';

import {
    cancelServerPluginUpdateHandoff,
    isServerPluginUpdateSupervised,
    notifyServerStartup,
    prepareServerPluginUpdateHandoff,
    SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE,
    SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE,
    SERVER_PLUGIN_UPDATE_RESPONSE_MESSAGE,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
    SERVER_STARTUP_READY_MESSAGE,
} from '../src/server-plugin-update-ipc.js';

class FakeProcess extends EventEmitter {
    constructor() {
        super();
        this.env = {
            SILLYBUNNY_SUPERVISED: '1',
            [SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV]: SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
        };
        this.send = jest.fn((message, callback) => {
            callback?.();
            if (message.type === SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE || message.type === SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE) {
                setImmediate(() => this.emit('message', {
                    type: SERVER_PLUGIN_UPDATE_RESPONSE_MESSAGE,
                    requestId: message.requestId,
                    ok: true,
                }));
            }
        });
    }
}

describe('server plugin update IPC', () => {
    test('requires a supervised IPC child', () => {
        expect(isServerPluginUpdateSupervised({ env: {}, send: () => { } })).toBe(false);
        expect(isServerPluginUpdateSupervised({ env: { SILLYBUNNY_SUPERVISED: '1' }, send: null })).toBe(false);
        expect(isServerPluginUpdateSupervised({ env: { SILLYBUNNY_SUPERVISED: '1' }, send: () => { } })).toBe(false);
        expect(isServerPluginUpdateSupervised({
            env: {
                SILLYBUNNY_SUPERVISED: '1',
                [SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV]: SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
            },
            send: () => { },
        })).toBe(true);
    });

    test('prepares and cancels a transaction only after supervisor acknowledgement', async () => {
        const processObject = new FakeProcess();
        const payload = { transactionId: 'transaction' };

        await expect(prepareServerPluginUpdateHandoff(payload, { processObject })).resolves.toMatchObject({ ok: true });
        await expect(cancelServerPluginUpdateHandoff(payload, { processObject })).resolves.toMatchObject({ ok: true });
        expect(processObject.send.mock.calls.map(call => call[0].type)).toEqual([
            SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE,
            SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE,
        ]);
    });

    test('reports loaded plugin IDs and canonical directories after the server starts listening', () => {
        const processObject = new FakeProcess();
        const plugins = [
            { id: 'one', directoryPath: '/plugins/One' },
            { id: 'two', directoryPath: '/plugins/Two' },
        ];

        expect(notifyServerStartup(plugins, { processObject })).toBe(true);
        expect(processObject.send).toHaveBeenCalledWith({
            type: SERVER_STARTUP_READY_MESSAGE,
            plugins,
        });
    });
});
