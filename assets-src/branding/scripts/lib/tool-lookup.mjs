import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Where a tool is looked for, first match wins: the environment variable named here, then each install directory under the home folder
// (the place the tool's own installer puts it, which is often not on the PATH), then the PATH. A tool not listed is looked for on the PATH only.
const LOOKUP = {
    vtracer: { envVar: 'VTRACER', installDirs: [['.cargo', 'bin']] },
    potrace: { envVar: 'POTRACE', installDirs: [] },
};

/**
 * The commands to try for a tool, in the order they are tried. Every script that runs the tool and every report of its version
 * uses this list, so they cannot disagree about whether the tool is installed.
 * @param {string} name
 * @param {Record<string, string | undefined>} [env]
 */
export function toolCandidates(name, env = process.env) {
    const { envVar, installDirs = [] } = LOOKUP[name] ?? {};
    const home = env.HOME ?? homedir();
    return [envVar && env[envVar], ...installDirs.map((directory) => join(home, ...directory, name)), name].filter(Boolean);
}

/**
 * The first candidate that answers `--version` successfully, or undefined. The PATH it searches is the one in `env`.
 * @param {string} name
 * @param {Record<string, string | undefined>} [env]
 */
export function findTool(name, env = process.env) {
    return toolCandidates(name, env).find((candidate) => spawnSync(candidate, ['--version'], { encoding: 'utf8', env }).status === 0);
}
