import { randomUUID } from 'node:crypto';
import process from 'node:process';

export const SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE = 'sillybunny:server-plugin-update:prepare';
export const SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE = 'sillybunny:server-plugin-update:cancel';
export const SERVER_PLUGIN_UPDATE_RESPONSE_MESSAGE = 'sillybunny:server-plugin-update:response';
export const SERVER_STARTUP_READY_MESSAGE = 'sillybunny:server-startup:ready';
export const SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV = 'SILLYBUNNY_SERVER_PLUGIN_UPDATE_API';
export const SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION = '1';

const IPC_TIMEOUT_MS = 90_000;

export function isServerPluginUpdateSupervised({
    env = process.env,
    send = process.send,
} = {}) {
    return env.SILLYBUNNY_SUPERVISED === '1'
        && env[SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV] === SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION
        && typeof send === 'function';
}

async function sendSupervisorRequest(type, payload, {
    processObject = process,
    timeoutMs = IPC_TIMEOUT_MS,
} = {}) {
    if (!isServerPluginUpdateSupervised({ env: processObject.env, send: processObject.send })) {
        throw new Error('A SillyBunny supervisor is required for safe server plugin replacement.');
    }

    const requestId = randomUUID();
    return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            processObject.off('message', onMessage);
            error ? reject(error) : resolve(value);
        };
        const onMessage = message => {
            if (message?.type !== SERVER_PLUGIN_UPDATE_RESPONSE_MESSAGE || message?.requestId !== requestId) {
                return;
            }
            if (message.ok) {
                finish(null, message);
                return;
            }
            const error = new Error(message.error || 'The server plugin update supervisor request failed.');
            error.code = message.code || 'supervisor_request_failed';
            finish(error);
        };
        const timer = setTimeout(() => finish(new Error('Timed out waiting for the SillyBunny supervisor.')), timeoutMs);
        timer.unref?.();
        processObject.on('message', onMessage);

        try {
            processObject.send({ type, requestId, payload }, error => error && finish(error));
        } catch (error) {
            finish(error);
        }
    });
}

export async function prepareServerPluginUpdateHandoff(payload, options) {
    return await sendSupervisorRequest(SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE, payload, options);
}

export async function cancelServerPluginUpdateHandoff(payload, options) {
    return await sendSupervisorRequest(SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE, payload, options);
}

export function notifyServerStartup(plugins, { processObject = process } = {}) {
    if (!isServerPluginUpdateSupervised({ env: processObject.env, send: processObject.send })) {
        return false;
    }

    try {
        processObject.send({
            type: SERVER_STARTUP_READY_MESSAGE,
            plugins: Array.from(plugins ?? [], plugin => ({
                id: String(plugin?.id ?? ''),
                directoryPath: String(plugin?.directoryPath ?? ''),
            })),
        });
        return true;
    } catch {
        return false;
    }
}
