import process from 'node:process';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let registeredShutdownFn = null;
let isShutdownRequested = false;

export function registerGracefulShutdown(fn) {
    registeredShutdownFn = fn;
}

export function isShutdownInProgress() {
    return isShutdownRequested;
}

export function requestGracefulExit(exitCode = 0) {
    if (isShutdownRequested) return;
    isShutdownRequested = true;

    const forceTimeout = setTimeout(() => {
        console.error(`Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit with code ${exitCode}.`);
        process.exit(exitCode);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimeout.unref?.();

    if (typeof registeredShutdownFn === 'function') {
        Promise.resolve(registeredShutdownFn(exitCode)).catch((error) => {
            console.error('Error during graceful shutdown:', error);
        });
    } else {
        process.exit(exitCode);
    }
}
