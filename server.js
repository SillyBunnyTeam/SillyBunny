#!/usr/bin/env bun
import { runSupervisor, shouldSupervise } from './src/server-supervisor.js';

// When started directly (bun/node server.js, Docker, systemd), supervise a
// child copy of this process so the in-app restart (exit code 75) relaunches
// it. Launcher scripts set SILLYBUNNY_LAUNCHER=1 and loop on the exit code
// themselves; the supervised child sees SILLYBUNNY_SUPERVISED=1 and boots.
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
