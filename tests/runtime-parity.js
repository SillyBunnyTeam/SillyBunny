import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveParityRuntime, runRuntimeParitySuite } from './util/runtime-parity-harness.js';

/**
 * Parses CLI flags for the standalone runtime parity runner.
 * @param {string[]} argv Command-line arguments after the script path
 * @param {NodeJS.ProcessEnv} [env] Environment variables
 * @returns {{ runtime: 'bun' | 'node', logFilePath: string }}
 */
export function parseParityCliArgs(argv, env = process.env) {
    let runtime;
    let logFilePath = env.SILLYBUNNY_PARITY_SERVER_LOG || '';

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--runtime' && argv[index + 1]) {
            runtime = argv[++index];
        } else if (arg.startsWith('--runtime=')) {
            runtime = arg.slice('--runtime='.length);
        } else if (arg === '--log-file' && argv[index + 1]) {
            logFilePath = argv[++index];
        } else if (arg.startsWith('--log-file=')) {
            logFilePath = arg.slice('--log-file='.length);
        } else {
            throw new Error(`Unknown argument "${arg}". Supported flags: --runtime <bun|node>, --log-file <path>.`);
        }
    }

    return {
        runtime: resolveParityRuntime(runtime, env),
        logFilePath,
    };
}

async function main() {
    const { runtime, logFilePath } = parseParityCliArgs(process.argv.slice(2));
    console.log(`[runtime-parity:${runtime}] Booting real SillyBunny server with isolated temp data root...`);

    const summary = await runRuntimeParitySuite({
        runtime,
        logFilePath,
        onCheckPass: check => {
            console.log(`[runtime-parity:${runtime}] PASS ${check.title} (${check.durationMs}ms)`);
        },
    });

    console.log(
        `[runtime-parity:${summary.runtime}] All ${summary.checks.length} parity checks passed `
        + `(boot ${summary.bootDurationMs}ms, total ${summary.totalDurationMs}ms).`,
    );
}

const resolvedArg = process.argv[1] ? path.resolve(process.argv[1]) : '';
const resolvedSelf = path.resolve(fileURLToPath(import.meta.url));
const isEntrypoint = Boolean(resolvedArg) && (
    process.platform === 'win32'
        ? resolvedArg.toLowerCase() === resolvedSelf.toLowerCase()
        : resolvedArg === resolvedSelf
);
if (isEntrypoint) {
    main().catch(error => {
        console.error(`[runtime-parity] FAILED: ${error?.stack || error}`);
        if (error?.serverLogTail) {
            console.error('--- Server log tail ---');
            console.error(error.serverLogTail);
        }
        process.exit(1);
    });
}
