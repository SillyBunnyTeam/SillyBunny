#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const USAGE = `Usage: node scripts/art/cli.js <command> [options]

Commands:
  list      List the assets of the art manifest with their masters and outputs.
  check     Check the manifest, the masters, the provenance records and the shipped files, without encoding,
            and warn about each figure whose rings measure other widths than the manifest gives.
  derive    Derive every output from its master and report the files that would change.
  prove     Derive every output again and compare it with the shipped file, byte for byte.
  bump      Give a new cache key to every group whose files changed since its key did.
  notice    Make the generated region of assets-src/art/NOTICE.md from the provenance records.

Options:
  --root <dir>        The SillyBunny checkout. Default: the one that holds this script.
  --manifest <path>   The manifest, relative to the root. Default: assets-src/art/art-manifest.json.
  --only <id,id>      derive, prove: only these assets.
  --write             derive: write the changed outputs and their sha256 in the manifest.
                      bump: write the new keys into their files and the manifest.
                      notice: write the generated region.
  --pixels            prove: compare encoded pictures by their decoded pixels, for an encoder that gives other bytes.
  --today <day>       bump: the day of a new key, as YYYY-MM-DD. Default: today in UTC.
  --key <key>         bump: the key every changed key takes, such as 20261114a.
  --help              Show this text.

The result is one JSON document on stdout, with its problems and its warnings. Warnings never change the exit code.
Exit codes: 0 no problem, 1 problems, 2 usage, 3 the install (sharp is missing, or its encoder versions differ from
the manifest).`;

const COMMANDS = Object.freeze({
    list: { run: 'runList', options: [] },
    check: { run: 'runCheck', options: [] },
    derive: { run: 'runDerive', options: ['only', 'write'] },
    prove: { run: 'runProve', options: ['only', 'pixels'] },
    bump: { run: 'runBump', options: ['write', 'today', 'key'] },
    notice: { run: 'runNotice', options: ['write'] },
});
const VALUE_OPTIONS = Object.freeze(['root', 'manifest', 'only', 'today', 'key']);
const FLAG_OPTIONS = Object.freeze(['write', 'pixels', 'help']);

class UsageError extends Error {}

/**
 * @param {string[]} argv The arguments after the script.
 * @returns {{ command: string | null, help: boolean, options: Record<string, any> }}
 */
export function parseArguments(argv) {
    let command = null;
    const options = {};
    for (let at = 0; at < argv.length; at++) {
        const argument = argv[at];
        if (!argument.startsWith('--')) {
            if (command !== null) {
                throw new UsageError(`Give one command, got "${command}" and "${argument}".`);
            }
            command = argument;
            continue;
        }
        const name = argument.slice(2);
        if (FLAG_OPTIONS.includes(name)) {
            options[name] = true;
        } else if (VALUE_OPTIONS.includes(name)) {
            const value = argv[++at];
            if (value === undefined || value.startsWith('--')) {
                throw new UsageError(`--${name} needs a value.`);
            }
            options[name] = name === 'only' ? value.split(',').filter(Boolean) : value;
        } else {
            throw new UsageError(`Unknown option ${argument}.`);
        }
    }
    if (options.help) {
        return { command, help: true, options };
    }
    if (command === null || !COMMANDS[command]) {
        throw new UsageError(command === null ? 'Give a command.' : `Unknown command "${command}".`);
    }
    for (const name of Object.keys(options)) {
        if (!['root', 'manifest'].includes(name) && !COMMANDS[command].options.includes(name)) {
            throw new UsageError(`--${name} does not apply to ${command}.`);
        }
    }
    return { command, help: false, options };
}

/**
 * Runs one command and returns what the process prints and its exit code, so tests need no child process.
 * @param {string[]} argv
 * @returns {Promise<{ output: string, exitCode: number }>}
 */
export async function main(argv) {
    let parsed;
    try {
        parsed = parseArguments(argv);
    } catch (error) {
        if (!(error instanceof UsageError)) {
            throw error;
        }
        return report({ format: 1, command: null, ok: false, problems: [{ code: 'usage', message: `${error.message} Run with --help for the commands.` }], warnings: [] }, 2);
    }
    if (parsed.help) {
        return { output: `${USAGE}\n`, exitCode: 0 };
    }
    let commands;
    try {
        commands = await import('./lib/commands.js');
    } catch (error) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND' && /'sharp'/.test(error.message)) {
            return report({ format: 1, command: parsed.command, ok: false, problems: [{ code: 'sharp-missing', message: 'sharp is not installed for scripts/art. Run npm ci --prefix scripts/art.' }], warnings: [] }, 3);
        }
        throw error;
    }
    const { options } = parsed;
    const { result, exitCode } = await commands[COMMANDS[parsed.command].run]({
        root: resolve(options.root ?? DEFAULT_ROOT),
        manifestPath: options.manifest,
        only: options.only,
        write: options.write,
        pixels: options.pixels,
        today: options.today,
        key: options.key,
    });
    return report(result, exitCode);
}

const report = (result, exitCode) => ({ output: `${JSON.stringify(result, null, 2)}\n`, exitCode });

function isDirectRun() {
    try {
        return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isDirectRun()) {
    const { output, exitCode } = await main(process.argv.slice(2));
    process.stdout.write(output);
    process.exitCode = exitCode;
}
