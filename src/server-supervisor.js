import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';

import {
    applyServerPluginRelease,
    discardPreparedServerPluginRelease,
    discardQueuedServerPluginRelease,
    finalizeServerPluginRelease,
    recoverInterruptedServerPluginUpdates,
    rollbackServerPluginRelease,
    validateServerPluginUpdatePayload,
} from './server-plugin-update-helper.js';
import {
    SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE,
    SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE,
    SERVER_PLUGIN_UPDATE_RESPONSE_MESSAGE,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV,
    SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
    SERVER_STARTUP_READY_MESSAGE,
} from './server-plugin-update-ipc.js';
import { serverDirectory } from './server-directory.js';

export const RESTART_EXIT_CODE = 75;
export const SERVER_PLUGIN_UPDATE_EXIT_CODE = 76;
export const SUPERVISOR_RELOAD_EXIT_CODE = 77;
export const SUPERVISED_ENV = 'SILLYBUNNY_SUPERVISED';
export const LAUNCHER_ENV = 'SILLYBUNNY_LAUNCHER';
export const SUPERVISOR_SHUTDOWN_MESSAGE = 'sillybunny:shutdown';
export const SUPERVISOR_FORCE_KILL_TIMEOUT_MS = 5000;
export const SERVER_PLUGIN_ACTIVATION_TIMEOUT_MS = 150_000;
export const SERVER_PLUGIN_PREPARE_LEASE_MS = 2 * 60_000;

function createTimeout(ms, value) {
    let timer;
    const promise = new Promise(resolve => {
        timer = setTimeout(() => resolve(value), ms);
        timer.unref?.();
    });
    return { promise, cancel: () => clearTimeout(timer) };
}

async function stopChildForRollback(child, exitPromise) {
    if (child.exitCode !== null) {
        return;
    }

    try {
        if (typeof child.send === 'function' && child.connected !== false) {
            child.send(SUPERVISOR_SHUTDOWN_MESSAGE, () => { });
        } else {
            child.kill('SIGKILL');
        }
    } catch {
        child.kill('SIGKILL');
    }

    const gracefulTimeout = createTimeout(SUPERVISOR_FORCE_KILL_TIMEOUT_MS, null);
    const gracefulExit = await Promise.race([exitPromise, gracefulTimeout.promise]);
    gracefulTimeout.cancel();
    if (gracefulExit) {
        return;
    }

    child.kill('SIGKILL');
    const forceTimeout = createTimeout(SUPERVISOR_FORCE_KILL_TIMEOUT_MS, null);
    const forcedExit = await Promise.race([exitPromise, forceTimeout.promise]);
    forceTimeout.cancel();
    if (!forcedExit) {
        throw new Error('Updated server process did not exit for plugin rollback.');
    }
}

/**
 * Whether this process should act as a supervisor instead of booting the server.
 * A supervised child must not supervise again. Launcher scripts may wrap this
 * supervisor so a host-code update can replace the supervisor itself.
 * @param {NodeJS.ProcessEnv} env Environment to inspect
 * @returns {boolean} True when a supervisor loop should run
 */
export function shouldSupervise(env = process.env) {
    return env[SUPERVISED_ENV] !== '1';
}

/**
 * Runs the server as a supervised child and relaunches it whenever it exits
 * with the restart exit code. This makes the in-app "Restart server" action
 * work regardless of how the process was started (bun server.js, node
 * server.js, Docker, systemd) without relying on platform-specific detached
 * relaunch helpers.
 * @param {object} [options] Dependency injection for tests
 * @param {string[]} [options.argv] Command line of this process
 * @param {string[]} [options.execArgv] Runtime flags to forward to the child
 * @param {typeof spawn} [options.spawnFn] Spawn implementation
 * @param {(code: number) => never} [options.exitFn] Exit implementation
 * @returns {Promise<never>} Never resolves; exits the process instead
 */
export async function runSupervisor({
    argv = process.argv,
    execArgv = process.execArgv ?? [],
    spawnFn = spawn,
    exitFn = process.exit,
    pluginUpdate = {
        apply: applyServerPluginRelease,
        discard: discardQueuedServerPluginRelease,
        discardPrepared: discardPreparedServerPluginRelease,
        finalize: finalizeServerPluginRelease,
        recover: recoverInterruptedServerPluginUpdates,
        rollback: rollbackServerPluginRelease,
        validate: validateServerPluginUpdatePayload,
    },
    activationTimeoutMs = SERVER_PLUGIN_ACTIVATION_TIMEOUT_MS,
    prepareLeaseMs = SERVER_PLUGIN_PREPARE_LEASE_MS,
    pluginsRoot = path.join(serverDirectory, 'plugins'),
} = {}) {
    let child = null;
    let shuttingDown = false;
    let forceKillTimer = null;
    let pendingPluginUpdate = null;
    let pendingPluginUpdateTimer = null;
    let activatingPluginUpdate = null;

    const recoverPluginUpdates = () => {
        try {
            pluginUpdate.recover?.(pluginsRoot);
            return true;
        } catch (error) {
            console.error('[SillyBunny] Failed to recover an interrupted server plugin update.', error);
            return false;
        }
    };

    if (!recoverPluginUpdates()) {
        return exitFn(1);
    }

    const clearPendingPluginUpdate = () => {
        if (pendingPluginUpdateTimer) {
            clearTimeout(pendingPluginUpdateTimer);
            pendingPluginUpdateTimer = null;
        }
        pendingPluginUpdate = null;
    };

    const discardPreparedUpdate = update => {
        const discard = pluginUpdate.discardPrepared ?? pluginUpdate.discard;
        discard(update);
    };

    const leasePendingPluginUpdate = () => {
        if (pendingPluginUpdateTimer) {
            clearTimeout(pendingPluginUpdateTimer);
        }
        pendingPluginUpdateTimer = setTimeout(() => {
            const expired = pendingPluginUpdate;
            clearPendingPluginUpdate();
            if (!expired) {
                return;
            }
            try {
                discardPreparedUpdate(expired);
                console.warn(`[SillyBunny] Discarded expired server plugin update ${expired.transactionId}.`);
            } catch (error) {
                console.error('[SillyBunny] Failed to discard an expired server plugin update.', error);
            }
        }, prepareLeaseMs);
        pendingPluginUpdateTimer.unref?.();
    };

    const forceStopChild = () => {
        if (child && child.exitCode === null) {
            child.kill('SIGKILL');
        }
    };

    const requestShutdown = () => {
        shuttingDown = true;
        if (!child || child.exitCode !== null) {
            return;
        }

        forceKillTimer ??= setTimeout(forceStopChild, SUPERVISOR_FORCE_KILL_TIMEOUT_MS);
        forceKillTimer.unref?.();

        if (typeof child.send === 'function' && child.connected !== false) {
            try {
                child.send(SUPERVISOR_SHUTDOWN_MESSAGE, error => error && forceStopChild());
                return;
            } catch {
                // Fall through to the force-stop fallback.
            }
        }

        forceStopChild();
    };

    process.on('SIGINT', requestShutdown);
    process.on('SIGTERM', requestShutdown);
    // Windows delivers SIGHUP/SIGBREAK when the console window is closed or
    // Ctrl+Break is pressed, and it does not kill child processes with their
    // parent. Without this the server survives as an invisible process that
    // keeps holding the listen port.
    process.on('SIGHUP', requestShutdown);
    process.on('SIGBREAK', requestShutdown);
    process.on('exit', () => {
        if (forceKillTimer) {
            clearTimeout(forceKillTimer);
        }
        forceStopChild();
    });

    let isFirstLaunch = true;
    for (;;) {
        if (!isFirstLaunch && !pendingPluginUpdate && !activatingPluginUpdate && !recoverPluginUpdates()) {
            return exitFn(1);
        }

        const env = {
            ...process.env,
            [SUPERVISED_ENV]: '1',
            [SERVER_PLUGIN_UPDATE_SUPERVISOR_API_ENV]: SERVER_PLUGIN_UPDATE_SUPERVISOR_API_VERSION,
        };
        if (!isFirstLaunch) {
            env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH = '1';
        }

        try {
            child = spawnFn(argv[0], [...execArgv, ...argv.slice(1)], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env });
            let resolveStartup;
            const startupPromise = new Promise(resolve => {
                resolveStartup = resolve;
            });
            const respond = (requestId, response) => {
                try {
                    child.send({ type: SERVER_PLUGIN_UPDATE_RESPONSE_MESSAGE, requestId, ...response }, () => {
                        // A disconnect racing this response is handled by the
                        // request lease/cancellation protocol.
                    });
                } catch {
                    // The child may have disconnected while its request was being handled.
                }
            };
            const onMessage = message => {
                if (message?.type === SERVER_STARTUP_READY_MESSAGE) {
                    resolveStartup({ plugins: Array.isArray(message.plugins) ? message.plugins : [] });
                    return;
                }

                if (message?.type === SERVER_PLUGIN_UPDATE_PREPARE_MESSAGE) {
                    try {
                        if (pendingPluginUpdate?.transactionId === message.payload?.transactionId) {
                            leasePendingPluginUpdate();
                            respond(message.requestId, { ok: true });
                            return;
                        }
                        if (pendingPluginUpdate || activatingPluginUpdate) {
                            throw new Error('Another server plugin update is already queued.');
                        }
                        pluginUpdate.validate(message.payload);
                        pendingPluginUpdate = message.payload;
                        leasePendingPluginUpdate();
                        respond(message.requestId, { ok: true });
                    } catch (error) {
                        respond(message.requestId, { ok: false, code: 'invalid_update_handoff', error: error?.message || String(error) });
                    }
                    return;
                }

                if (message?.type === SERVER_PLUGIN_UPDATE_CANCEL_MESSAGE) {
                    try {
                        if (activatingPluginUpdate?.transactionId === message.payload?.transactionId) {
                            throw new Error('Server plugin activation has already started.');
                        }
                        if (pendingPluginUpdate?.transactionId === message.payload?.transactionId) {
                            discardPreparedUpdate(pendingPluginUpdate);
                            clearPendingPluginUpdate();
                        } else if (!pendingPluginUpdate) {
                            // This also resolves a PREPARE response that was
                            // lost after the supervisor accepted ownership.
                            pluginUpdate.discardPrepared?.(message.payload);
                        }
                        respond(message.requestId, { ok: true });
                    } catch (error) {
                        respond(message.requestId, { ok: false, code: 'update_cancel_failed', error: error?.message || String(error) });
                    }
                }
            };
            child.on('message', onMessage);
            const exitPromise = once(child, 'exit').then(([code, signal]) => ({ code, signal }));

            if (activatingPluginUpdate) {
                const activationTimeout = createTimeout(activationTimeoutMs, { timedOut: true });
                const activation = await Promise.race([
                    startupPromise.then(startup => ({ startup })),
                    exitPromise.then(exit => ({ exit })),
                    activationTimeout.promise,
                ]);
                activationTimeout.cancel();

                const loaded = activation.startup?.plugins.some(plugin => (
                    plugin?.id === activatingPluginUpdate.expectedPluginId
                    && path.resolve(String(plugin?.directoryPath ?? '')) === activatingPluginUpdate.pluginPath
                ));
                if (!loaded) {
                    const reason = activation.timedOut
                        ? 'server startup timed out'
                        : activation.exit
                            ? 'updated server exited before startup completed'
                            : `plugin ${activatingPluginUpdate.expectedPluginId} did not load`;
                    if (!activation.exit) {
                        await stopChildForRollback(child, exitPromise);
                    }
                    pluginUpdate.rollback(activatingPluginUpdate, reason);
                    console.error(`[SillyBunny] Server plugin update rolled back: ${reason}.`);
                    activatingPluginUpdate = null;
                    child.off('message', onMessage);
                    if (shuttingDown) {
                        return exitFn(activation.exit?.signal ? 1 : (activation.exit?.code ?? 0));
                    }
                    isFirstLaunch = false;
                    continue;
                }

                try {
                    pluginUpdate.finalize(activatingPluginUpdate);
                    console.info(`[SillyBunny] Server plugin ${activatingPluginUpdate.expectedPluginId} update activated successfully.`);
                } catch (error) {
                    console.error('[SillyBunny] Server plugin update activated, but final cleanup failed.', error);
                    if (error?.serverPluginActivationRecorded === true && !recoverPluginUpdates()) {
                        console.error('[SillyBunny] The healthy plugin is active, but its update lock requires manual cleanup.');
                    } else if (error?.serverPluginActivationRecorded !== true) {
                        console.error('[SillyBunny] Activation could not be recorded; restoring the previous plugin now.');
                        await stopChildForRollback(child, exitPromise);
                        pluginUpdate.rollback(activatingPluginUpdate, 'activation could not be recorded durably');
                        activatingPluginUpdate = null;
                        child.off('message', onMessage);
                        if (shuttingDown) {
                            return exitFn(0);
                        }
                        isFirstLaunch = false;
                        continue;
                    }
                }
                activatingPluginUpdate = null;
            }

            const { code, signal } = await exitPromise;
            child.off('message', onMessage);
            if (forceKillTimer) {
                clearTimeout(forceKillTimer);
                forceKillTimer = null;
            }

            if (code === SERVER_PLUGIN_UPDATE_EXIT_CODE && !shuttingDown) {
                if (!pendingPluginUpdate) {
                    console.error('[SillyBunny] Server plugin update exit requested without a queued transaction.');
                    isFirstLaunch = false;
                    continue;
                }

                if (pendingPluginUpdateTimer) {
                    clearTimeout(pendingPluginUpdateTimer);
                    pendingPluginUpdateTimer = null;
                }
                try {
                    activatingPluginUpdate = pluginUpdate.apply(pendingPluginUpdate);
                } catch (error) {
                    console.error('[SillyBunny] Failed to activate the staged server plugin update. Restarting the previous version.', error);
                    if (!error?.preserveServerPluginTransaction && !error?.serverPluginTransactionCleaned) {
                        try {
                            pluginUpdate.discardPrepared?.(pendingPluginUpdate);
                        } catch (discardError) {
                            console.error('[SillyBunny] Failed to discard the rejected server plugin update.', discardError);
                        }
                    }
                } finally {
                    clearPendingPluginUpdate();
                }
                isFirstLaunch = false;
                continue;
            }

            if (pendingPluginUpdate) {
                try {
                    discardPreparedUpdate(pendingPluginUpdate);
                } catch (error) {
                    console.error('[SillyBunny] Failed to discard a queued server plugin update.', error);
                }
                clearPendingPluginUpdate();
            }

            if (code === RESTART_EXIT_CODE && !shuttingDown) {
                console.info('[SillyBunny] Restarting server...');
                isFirstLaunch = false;
                continue;
            }

            if (code === SUPERVISOR_RELOAD_EXIT_CODE && !shuttingDown) {
                console.info('[SillyBunny] Host update requires a fresh supervisor process.');
                return exitFn(RESTART_EXIT_CODE);
            }

            return exitFn(signal ? 1 : (code ?? 0));
        } catch (error) {
            console.error('[SillyBunny] Supervisor failed to launch the server.', error);
            return exitFn(1);
        }
    }
}
