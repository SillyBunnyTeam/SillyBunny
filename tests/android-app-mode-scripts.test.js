import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        for (const name of ['is_android_app', 'is_termux', 'prefer_node_runtime', 'prune_android_node_modules']) {
            expect(extractShellFunction(launcherSource, name)).toMatch(new RegExp(`^${name}\\(\\) \\{`));
        }
        // Never exec Node inside start.sh (preserves exit-75/77 restart loop and StopEscalation parent-child tree).
        const runServerFn = extractShellFunction(launcherSource, 'run_server');
        expect(runServerFn).not.toMatch(/\bexec\s+"\$RUNTIME_CMD"/);
        expect(launcherSource).toContain('supervisor_reload_exit_code=77');
    });

    test('prune_android_node_modules removes only dead files and duplicate ORT WASMs without touching package.json', () => {
        const pruneFn = extractShellFunction(launcherSource, 'prune_android_node_modules');
        const scriptMatch = pruneFn.match(/"\$RUNTIME_CMD" -e '([\s\S]*?)' "\$SCRIPT_DIR\/node_modules"/);
        expect(scriptMatch).not.toBeNull();
        const inlineScript = scriptMatch[1];

        const runPrune = (nmDir) => spawnSync(process.execPath, ['-e', inlineScript, nmDir], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const wasms = [
            'ort-wasm-simd-threaded.wasm',
            'ort-wasm-simd.wasm',
            'ort-wasm-threaded.wasm',
            'ort-wasm.wasm',
        ];
        const tempRoot = mkdtempSync(path.join(tmpdir(), 'sb-android-prune-'));
        try {
            const nm = path.join(tempRoot, 'node_modules');
            const write = (rel, content = 'x') => {
                const target = path.join(nm, rel);
                mkdirSync(path.dirname(target), { recursive: true });
                writeFileSync(target, content);
                return target;
            };

            const keepPkgJson = write('sample-pkg/package.json', '{"name":"sample-pkg"}\n');
            const keepIndexJs = write('sample-pkg/index.js', 'export const ok = true;\n');
            const deadMap = write('sample-pkg/dist/index.js.map', '{}');
            const deadDts = write('sample-pkg/dist/index.d.ts', 'export {};');
            const deadDmts = write('sample-pkg/dist/index.d.mts', 'export {};');
            const deadDcts = write('sample-pkg/dist/index.d.cts', 'export {};');
            const deadDocs = write('sample-pkg/docs/guide.md', '# guide');
            const deadTest = write('sample-pkg/test/spec.js', 'test');
            const keepTestWithPkg = write('pkg-with-test-pkg/test/package.json', '{"type":"module"}\n');
            const deadScopedTests = write('@scope/lib/tests/a.js', 'test');
            const keepScopedPkg = write('@scope/lib/package.json', '{"name":"@scope/lib"}\n');

            // Case 1: only 3 of 4 active WASMs exist in sillytavern-transformers -> keep ALL onnxruntime-web WASMs.
            for (const w of wasms.slice(0, 3)) {
                write(`sillytavern-transformers/dist/${w}`, 'active-wasm-bytes');
            }
            const ortWasmFiles = wasms.map((w) => write(`onnxruntime-web/dist/${w}`, 'dup-wasm-bytes'));
            const keepOrtJs = write('onnxruntime-web/dist/ort.min.js', 'js');

            let result = runPrune(nm);
            expect(result.status).toBe(0);
            expect(existsSync(keepPkgJson)).toBe(true);
            expect(existsSync(keepIndexJs)).toBe(true);
            expect(existsSync(keepScopedPkg)).toBe(true);
            expect(existsSync(keepTestWithPkg)).toBe(true);
            expect(existsSync(keepOrtJs)).toBe(true);
            expect(existsSync(deadMap)).toBe(false);
            expect(existsSync(deadDts)).toBe(false);
            expect(existsSync(deadDmts)).toBe(false);
            expect(existsSync(deadDcts)).toBe(false);
            expect(existsSync(deadDocs)).toBe(false);
            expect(existsSync(deadTest)).toBe(false);
            expect(existsSync(deadScopedTests)).toBe(false);
            for (const ortFile of ortWasmFiles) {
                expect(existsSync(ortFile)).toBe(true);
            }

            // Case 2: all 4 active WASMs exist in sillytavern-transformers/dist -> prune duplicate onnxruntime-web WASMs.
            write(`sillytavern-transformers/dist/${wasms[3]}`, 'active-wasm-bytes');
            result = runPrune(nm);
            expect(result.status).toBe(0);
            for (const w of wasms) {
                expect(existsSync(path.join(nm, 'sillytavern-transformers', 'dist', w))).toBe(true);
                expect(existsSync(path.join(nm, 'onnxruntime-web', 'dist', w))).toBe(false);
            }
            expect(existsSync(keepOrtJs)).toBe(true);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
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

    test('warm Android node boot skips redundant dependency-state and init spawns until HEAD changes', () => {
        const repoDir = mkdtempSync(path.join(tmpdir(), 'sb-android-fastboot-'));
        try {
            mkdirSync(path.join(repoDir, 'scripts'));
            mkdirSync(path.join(repoDir, 'default'));
            mkdirSync(path.join(repoDir, 'node_modules'));
            mkdirSync(path.join(repoDir, '.git', 'refs', 'heads'), { recursive: true });
            writeFileSync(path.join(repoDir, 'start.sh'), launcherSource);
            writeFileSync(path.join(repoDir, 'package.json'), '{"name":"sillybunny"}\n');
            writeFileSync(path.join(repoDir, 'package-lock.json'), '{}\n');
            writeFileSync(path.join(repoDir, 'default', 'config.yaml'), 'port: 8000\n');
            writeFileSync(path.join(repoDir, 'config.yaml'), 'port: 8000\n');
            writeFileSync(path.join(repoDir, 'node_modules', '.sillybunny-dependencies.json'), '{"version":1}\n');
            writeFileSync(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/release\n');
            writeFileSync(path.join(repoDir, '.git', 'refs', 'heads', 'release'), '1111111111111111111111111111111111111111\n');

            const runBoot = (label) => {
                const callsFile = path.join(repoDir, `calls-${label}`);
                const result = spawnSync('bash', [path.join(repoDir, 'start.sh'), '--skip-self-update', '--port', '54321'], {
                    cwd: repoDir,
                    env: launcherEnv({
                        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
                        HOME: homeDir,
                        SILLYBUNNY_ANDROID_APP: '1',
                        SILLYBUNNY_ANDROID_APP_VERSION_CODE: '1',
                        TEST_CALLS: callsFile,
                    }),
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                return { result, calls: readFileSync(callsFile, 'utf8') };
            };

            // First boot has no fast-boot stamp yet, so it runs dependency-state + npm run init and writes the stamp.
            const first = runBoot('first');
            expect(first.result.status).toBe(0);
            expect(first.calls).toContain('dependency-state.js check node-production');
            expect(first.calls).toContain('npm: run init\n');

            // Second boot matches the stamp and launches server.js directly.
            const second = runBoot('second');
            expect(second.result.status).toBe(0);
            expect(second.calls).not.toContain('dependency-state.js');
            expect(second.calls).not.toContain('npm: run init');
            expect(second.calls).toContain('node: --no-warnings server.js --port 54321\n');

            // Advancing HEAD invalidates the stamp so dependency checks and init run again.
            writeFileSync(path.join(repoDir, '.git', 'refs', 'heads', 'release'), '2222222222222222222222222222222222222222\n');
            const third = runBoot('third');
            expect(third.result.status).toBe(0);
            expect(third.calls).toContain('dependency-state.js check node-production');
            expect(third.calls).toContain('npm: run init\n');
        } finally {
            rmSync(repoDir, { recursive: true, force: true });
        }
    });
});
