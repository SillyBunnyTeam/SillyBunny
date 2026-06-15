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

export function normalizeExitCode(exitCode = 0) {
    const numericExitCode = Number(exitCode ?? 0);

    return Number.isInteger(numericExitCode) ? numericExitCode : 0;
}

export function requestGracefulExit(exitCode = 0) {
    if (isShutdownRequested) return;
    isShutdownRequested = true;
    const normalizedExitCode = normalizeExitCode(exitCode);

    const forceTimeout = setTimeout(() => {
        console.error(`Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit with code ${normalizedExitCode}.`);
        process.exit(normalizedExitCode);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimeout.unref?.();

    if (typeof registeredShutdownFn === 'function') {
        Promise.resolve(registeredShutdownFn(normalizedExitCode)).catch((error) => {
            console.error('Error during graceful shutdown:', error);
        });
    } else {
        process.exit(normalizedExitCode);
    }
}
