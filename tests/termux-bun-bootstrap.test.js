import { describe, test, expect, afterAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prerequisitesSource = readFileSync(path.join(repoRoot, 'scripts', 'install-prerequisites.sh'), 'utf8');

/**
 * Lifts a top-level shell function out of install-prerequisites.sh so it can be
 * exercised in isolation. Sourcing the script directly is not an option: it
 * would try to install Bun, Node.js and git on the way past.
 *
 * Terminates on the first closing brace at column 0, which matches how every
 * function in the script is written. A mis-extraction fails the behavioural
 * assertions below rather than passing quietly.
 */
function extractShellFunction(source, name) {
    const lines = source.split('\n');
    const start = lines.findIndex(line => line.startsWith(`${name}() {`));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    expect(end).toBeGreaterThan(start);
    return lines.slice(start, end + 1).join('\n');
}

const harnessDir = mkdtempSync(path.join(tmpdir(), 'sb-termux-bun-'));
const harnessPath = path.join(harnessDir, 'harness.sh');
const fakeBinDir = path.join(harnessDir, 'fakebin');

mkdirSync(fakeBinDir, { recursive: true });
writeFileSync(path.join(fakeBinDir, 'grun'), '#!/usr/bin/env bash\nexit 0\n');
chmodSync(path.join(fakeBinDir, 'grun'), 0o755);

// Mirrors install-prerequisites.sh's own `set -euo pipefail` so the probe is
// exercised under the same strictness it runs under in production.
writeFileSync(harnessPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    extractShellFunction(prerequisitesSource, 'have_command'),
    extractShellFunction(prerequisitesSource, 'termux_glibc_runner_path'),
    extractShellFunction(prerequisitesSource, 'termux_glibc_ready'),
    'if termux_glibc_ready; then echo ready; else echo not-ready; fi',
    '',
].join('\n\n'));

afterAll(() => {
    rmSync(harnessDir, { recursive: true, force: true });
});

/**
 * Resolves the absolute path of a `bash` that can run a script living in the
 * temp dir, or null when there is none.
 *
 * The absolute path matters because the fixtures below run with a narrowed PATH
 * to keep a real `grun` from deciding the outcome. Relying on PATH to find bash
 * would then break wherever bash does not happen to sit next to the Node
 * binary, which is the case on the CI runners.
 *
 * On Windows `bash` also resolves to the WSL app-execution alias ahead of Git
 * Bash, and that alias either has no distribution installed or cannot see the
 * Windows temp path — so probe the real mechanism rather than inferring
 * capability from process.platform.
 */
function resolveBash() {
    const probePath = path.join(harnessDir, 'probe.sh');
    writeFileSync(probePath, 'set -euo pipefail\nprintf %s "$BASH"\n');

    try {
        const stdout = execFileSync('bash', [probePath], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

const bashPath = resolveBash();

// CI runs unit tests on ubuntu-latest, so this only spares Windows contributors
// a wall of failures that say nothing about the bootstrap. The source-level
// checks below still run everywhere.
const describeShell = bashPath ? describe : describe.skip;

let glibcRootCounter = 0;

/**
 * Runs termux_glibc_ready against a synthetic glibc root.
 *
 * @param {object} options Fixture shape.
 * @param {boolean} options.grun Whether `grun` resolves on PATH.
 * @param {boolean} options.linker Whether a glibc dynamic linker exists under lib/.
 * @returns {string} Either 'ready' or 'not-ready'.
 */
function glibcReady({ grun, linker }) {
    const glibcRoot = path.join(harnessDir, `glibc-${glibcRootCounter++}`);
    mkdirSync(path.join(glibcRoot, 'lib'), { recursive: true });

    if (linker) {
        writeFileSync(path.join(glibcRoot, 'lib', 'ld-linux-aarch64.so.1'), '');
    }

    // An empty PATH keeps a real grun on the developer's machine from deciding
    // the outcome. termux_glibc_runner_path only needs `command -v`, which is a
    // bash builtin, so nothing here depends on PATH being populated.
    const env = {
        ...process.env,
        PATH: grun ? fakeBinDir : '',
        TERMUX_PREFIX: path.join(glibcRoot, 'no-such-prefix'),
        TERMUX_GLIBC_ROOT: glibcRoot,
    };

    return execFileSync(bashPath, [harnessPath], { env, encoding: 'utf8' }).trim();
}

describeShell('install-prerequisites.sh termux_glibc_ready', () => {
    test('reports ready only when grun and the dynamic linker are both present', () => {
        expect(glibcReady({ grun: true, linker: true })).toBe('ready');
    });

    // The bug this guards: bun-termux aborts with "glibc-repo/glibc-runner
    // unavailable" when the linker is missing, even though grun resolves. A probe
    // that only checks grun short-circuits the repair and leaves the user stuck.
    test('reports not ready when grun resolves but no dynamic linker exists', () => {
        expect(glibcReady({ grun: true, linker: false })).toBe('not-ready');
    });

    test('reports not ready when the linker exists but grun is missing', () => {
        expect(glibcReady({ grun: false, linker: true })).toBe('not-ready');
    });

    test('reports not ready when neither is present', () => {
        expect(glibcReady({ grun: false, linker: false })).toBe('not-ready');
    });
});

describe('install-prerequisites.sh Termux Bun bootstrap wiring', () => {
    // bun-termux bails out early on a missing dynamic linker, so glibc has to be
    // provisioned before it runs. The reverse order turns a fixable glibc problem
    // into an opaque wrapper failure.
    test('repair_termux_bun provisions glibc before invoking bun-termux', () => {
        const repair = extractShellFunction(prerequisitesSource, 'repair_termux_bun');
        const glibcStep = repair.indexOf('install_termux_glibc_runner');
        const managerStep = repair.indexOf('install_termux_bun_manager');

        expect(glibcStep).toBeGreaterThanOrEqual(0);
        expect(managerStep).toBeGreaterThan(glibcStep);
    });

    test('bun-termux is told which glibc root to use', () => {
        const manager = extractShellFunction(prerequisitesSource, 'install_termux_bun_manager');
        const invocations = manager.match(/GLIBC_ROOT="\$TERMUX_GLIBC_ROOT"/g) ?? [];

        // One for the curl path, one for the wget fallback.
        expect(invocations).toHaveLength(2);
    });

    test('the glibc root honours a caller-supplied GLIBC_ROOT', () => {
        expect(prerequisitesSource).toContain('TERMUX_GLIBC_ROOT="${GLIBC_ROOT:-$TERMUX_PREFIX/glibc}"');
    });

    // The manager is piped straight into bash, so tracking a branch would let an
    // upstream push change what runs on a user's device without review.
    test('the bun-termux manager URL is pinned to a commit', () => {
        expect(prerequisitesSource).toMatch(/^TERMUX_BUN_MANAGER_COMMIT='[0-9a-f]{40}'$/m);
        expect(prerequisitesSource).toContain('/$TERMUX_BUN_MANAGER_COMMIT/helper_scripts/bun-termux-manager');
        expect(prerequisitesSource).not.toContain('bun-termux/main/helper_scripts');
    });

    test('glibc failures point at Node.js as the way to start now', () => {
        const glibcRunner = extractShellFunction(prerequisitesSource, 'install_termux_glibc_runner');
        const fallbackHints = glibcRunner.match(/bash start-termux-node\.sh/g) ?? [];

        // One per failure exit: the package install failure and the final probe.
        expect(fallbackHints).toHaveLength(2);
    });

    test('a stale package index is refreshed before installing glibc', () => {
        const glibcRunner = extractShellFunction(prerequisitesSource, 'install_termux_glibc_runner');
        const updateStep = glibcRunner.indexOf('pkg update -y');
        const installStep = glibcRunner.indexOf('pkg install -y glibc-repo');

        expect(updateStep).toBeGreaterThanOrEqual(0);
        expect(installStep).toBeGreaterThan(updateStep);
    });

    // install_bun's is_termux branch always returns or exits, so any further
    // is_termux handling below it is unreachable.
    test('install_bun keeps all Termux handling in one branch', () => {
        const installBun = extractShellFunction(prerequisitesSource, 'install_bun');
        const termuxChecks = installBun.match(/is_termux/g) ?? [];

        expect(termuxChecks).toHaveLength(1);
    });
});
