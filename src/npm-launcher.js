import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { isBunRuntime } from './runtime.js';

const npmCliRelativePath = path.join('node_modules', 'npm', 'bin', 'npm-cli.js');

/**
 * Lists the npm-cli.js locations checked on Windows, in search order and without duplicates.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function npmCliCandidates(env) {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
    const searchDirectories = (env[pathKey] || '').split(path.delimiter).filter(Boolean);
    const candidates = [
        env.npm_execpath,
        ...searchDirectories.map(directory => path.join(directory.replace(/^"|"$/g, ''), npmCliRelativePath)),
        path.join(path.dirname(process.execPath), npmCliRelativePath),
    ];

    return [...new Set(candidates.filter(candidate => candidate && path.basename(candidate) === 'npm-cli.js'))];
}

/**
 * Finds npm-cli.js through npm_execpath, PATH, then the runtime directory.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} Path of the first npm-cli.js that exists.
 */
export function findNpmCli(env = process.env) {
    const candidates = npmCliCandidates(env);
    const npmCli = candidates.find(candidate => fs.existsSync(candidate));

    if (!npmCli) {
        const searched = candidates.length > 0 ? candidates.map(candidate => `  ${candidate}`).join('\n') : '  (no candidate locations)';
        throw new Error(`Cannot locate npm-cli.js for the Windows npm launcher. Searched:\n${searched}`);
    }

    return npmCli;
}

/**
 * Runs npm without a shell; Windows uses npm-cli.js because Node cannot spawn batch files directly.
 * @param {string[]} args npm arguments.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 * @returns {{ command: string, args: string[] }}
 */
export function getNpmCommand(args, { env = process.env, platform = process.platform } = {}) {
    if (platform !== 'win32') {
        return { command: 'npm', args };
    }

    const npmCli = findNpmCli(env);
    // npm-cli.js needs Node, so Bun uses the Node executable from PATH.
    const command = isBunRuntime() ? 'node' : process.execPath;
    return { command, args: [npmCli, ...args] };
}
