#!/usr/bin/env bun
import nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SillyBunny: enable Node's V8 bytecode cache before loading application modules so warm restarts skip reparsing.
if (!process.versions.bun && typeof nodeModule.enableCompileCache === 'function') {
    try {
        const compileCacheDir = process.env.NODE_COMPILE_CACHE?.trim()
            || path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', '.cache', 'sillybunny-v8');
        nodeModule.enableCompileCache(compileCacheDir);
    } catch {
        // Read-only filesystems continue without persistent bytecode caching.
    }
}

const { runSupervisor, shouldSupervise } = await import('./src/server-supervisor.js');

// Supervise a child copy so restarts and transactional plugin replacement are
// owned by one process. Launcher scripts may wrap this supervisor so host-code
// updates can reload it; the supervised child boots the application.
if (shouldSupervise()) {
    await runSupervisor();
}

// The log buffer must evaluate before anything else writes to the console.
await import('./src/server-log-buffer.js');
const { CommandLineParser } = await import('./src/command-line.js');
const { APP_NAME, formatRuntimeLabel } = await import('./src/runtime.js');
const { serverDirectory } = await import('./src/server-directory.js');

process.env.NODE_ENV ??= 'production';
console.log(`${APP_NAME} startup on ${formatRuntimeLabel()}. Environment: ${process.env.NODE_ENV ?? 'development'}. Server directory: ${serverDirectory}`);
process.chdir(serverDirectory);

// config.yaml will be set when parsing command line arguments
const cliArgs = new CommandLineParser().parse(process.argv);
globalThis.DATA_ROOT = cliArgs.dataRoot;
globalThis.COMMAND_LINE_ARGS = cliArgs;

try {
    await import('./src/server-main.js');
} catch (error) {
    console.error('A critical error has occurred while starting the server:', error);
    process.exit(1);
}
