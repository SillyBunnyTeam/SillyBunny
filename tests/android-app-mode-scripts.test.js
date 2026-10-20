import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherSource = readFileSync(path.join(repoRoot, 'start.sh'), 'utf8');
const describePosix = process.platform === 'win32' ? describe.skip : describe;

function extractShellFunction(source, name) {
    const lines = source.split('\n');
    const start = lines.findIndex(line => line.startsWith(`${name}() {`));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    expect(end).toBeGreaterThan(start);
    return lines.slice(start, end + 1).join('\n');
}

function launcherEnv(extraEnv = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('SILLYBUNNY_') || ['TERMUX_VERSION', 'PREFIX', 'BASH_ENV', 'ENV'].includes(key)) {
            delete env[key];
        }
    }
    return { ...env, ...extraEnv };
}

describe('Android app script sources', () => {
    test('the initial minimum version is a single decimal integer', () => {
        expect(readFileSync(path.join(repoRoot, 'android', 'min-app-version'), 'utf8')).toBe('1\n');
    });

    test('APK helper functions remain extractable for shell checks', () => {
        for (const name of ['is_android_app', 'is_termux', 'prefer_node_runtime']) {
            expect(extractShellFunction(launcherSource, name)).toMatch(new RegExp(`^${name}\\(\\) \\{`));
        }
    });
});

describePosix('Android app launcher runtime selection', () => {
    let functions;

    beforeAll(() => {
        functions = ['is_truthy', 'is_android_app', 'is_termux', 'prefer_node_runtime']
            .map(name => extractShellFunction(launcherSource, name))
            .join('\n\n');
    });

    function runFunction(name, env = {}, prelude = '') {
        return spawnSync('bash', ['-c', `set -euo pipefail\n${functions}\n${prelude}\n${name}`], {
            env: launcherEnv(env),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }

    test.each([
        ['1', 0],
        ['', 1],
        ['0', 1],
        ['true', 1],
        ['01', 1],
        [' 1 ', 1],
    ])('is_android_app accepts only the exact flag: %j', (value, status) => {
        const result = runFunction('is_android_app', { SILLYBUNNY_ANDROID_APP: value });
        expect(result.status).toBe(status);
        expect(result.stdout + result.stderr).toBe('');
    });

    test('is_android_app is disabled when the flag is unset', () => {
        expect(runFunction('is_android_app').status).toBe(1);
    });

    test.each([
        { TERMUX_VERSION: '0.118.0' },
        { PREFIX: '/data/data/com.termux/files/usr' },
    ])('APK mode takes precedence over Termux detection: %j', termuxEnv => {
        expect(runFunction('is_termux', termuxEnv).status).toBe(0);
        expect(runFunction('is_termux', { ...termuxEnv, SILLYBUNNY_ANDROID_APP: '1' }).status).toBe(1);
        expect(runFunction('is_termux', { ...termuxEnv, SILLYBUNNY_ANDROID_APP: 'true' }).status).toBe(0);
    });

    test.each([
        [{}, 0],
        [{ SILLYBUNNY_USE_NODE: '1' }, 0],
        [{ SILLYBUNNY_USE_BUN: '1' }, 1],
        [{ SILLYBUNNY_USE_BUN: 'TRUE' }, 1],
        [{ SILLYBUNNY_USE_BUN: '0' }, 0],
        [{ SILLYBUNNY_USE_NODE: '1', SILLYBUNNY_USE_BUN: '1' }, 0],
        [{ TERMUX_VERSION: '0.118.0', SILLYBUNNY_TERMUX_RUNTIME: 'bun' }, 0],
    ])('APK runtime overrides stay silent and bypass host detection: %j', (env, status) => {
        const result = runFunction('prefer_node_runtime', { SILLYBUNNY_ANDROID_APP: '1', ...env },
            'uname() { printf "unexpected host detection\\n" >&2; return 99; }');
        expect(result.status).toBe(status);
        expect(result.stdout + result.stderr).toBe('');
    });

    test('non-APK macOS auto-selection keeps its existing message', () => {
        const result = runFunction('prefer_node_runtime', {}, 'uname() { echo Darwin; }');
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('[SillyBunny] macOS detected — using Node.js to avoid Bun CPU overhead (oven-sh/bun#26415)\n');
        expect(result.stderr).toBe('');
    });
});

describePosix('Android app launcher without prerequisite installation', () => {
    let workDir;
    let binDir;
    let homeDir;

    beforeAll(() => {
        workDir = mkdtempSync(path.join(tmpdir(), 'sb-android-launcher-'));
        binDir = path.join(workDir, 'bin');
        homeDir = path.join(workDir, 'home');
        mkdirSync(binDir);
        mkdirSync(homeDir);
        mkdirSync(path.join(workDir, 'scripts'));
        writeFileSync(path.join(workDir, 'start.sh'), launcherSource);
        writeFileSync(path.join(workDir, 'scripts', 'install-prerequisites.sh'), 'echo unexpected-prerequisites >&2\nexit 91\n');
        for (const runtime of ['node', 'npm', 'bun']) {
            writeFileSync(path.join(binDir, runtime), `#!/bin/bash\nprintf '${runtime}: %s\\n' "$*" >> "$TEST_CALLS"\n`, { mode: 0o755 });
        }
    });

    afterAll(() => {
        if (workDir) {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    test.each(['node', 'bun'])('APK %s launch skips prerequisites even with Termux environment', runtime => {
        const callsFile = path.join(workDir, `calls-${runtime}`);
        const result = spawnSync('bash', [path.join(workDir, 'start.sh'), '--skip-self-update', '--port', '54321'], {
            cwd: workDir,
            env: launcherEnv({
                PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
                HOME: homeDir,
                BUN_INSTALL: path.join(homeDir, '.bun'),
                SILLYBUNNY_ANDROID_APP: '1',
                SILLYBUNNY_USE_BUN: runtime === 'bun' ? '1' : '0',
                TERMUX_VERSION: '0.118.0',
                PREFIX: '/data/data/com.termux/files/usr',
                TEST_CALLS: callsFile,
            }),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('Dependencies are up to date.\nEntering SillyBunny...\n');
        expect(result.stderr).toBe('');
        const calls = readFileSync(callsFile, 'utf8');
        expect(calls).toContain(`${runtime}: ${workDir}/scripts/dependency-state.js check ${runtime}-production\n`);
        expect(calls).toContain(`${runtime === 'node' ? 'npm' : 'bun'}: run init\n`);
        expect(calls).toContain(`${runtime}: ${runtime === 'node' ? '--no-warnings ' : ''}server.js --port 54321\n`);
    });
});
