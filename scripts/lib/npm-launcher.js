import { spawnSync } from 'node:child_process';
import { getNpmCommand } from '../../src/npm-launcher.js';

export { findNpmCli } from '../../src/npm-launcher.js';

/**
 * Runs a command with inherited stdio and throws when it does not exit with status 0.
 * @param {string} command Executable name or path.
 * @param {string[]} args Arguments passed through without shell interpretation.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function run(command, args, { cwd = process.cwd(), env = process.env } = {}) {
    const result = spawnSync(command, args, {
        cwd,
        env: { ...env },
        stdio: 'inherit',
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with status ${result.status ?? 'unknown'}`);
    }
}

/**
 * Runs npm with the given arguments and throws when it does not exit with status 0.
 * On Windows, getNpmCommand runs npm-cli.js with node instead of npm.cmd.
 * @param {string[]} args npm arguments.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function runNpm(args, { env = process.env, ...options } = {}) {
    const npm = getNpmCommand(args, { env });
    run(npm.command, npm.args, { ...options, env });
}
