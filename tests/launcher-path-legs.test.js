import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'bootstrap-smoke.yml');
const smokeWorkflowSource = readFileSync(smokeWorkflowPath, 'utf8');
const smokeWorkflow = parse(smokeWorkflowSource);

const SPACED_PAREN_DIR = 'Silly Bunny (test)';
const SPACED_PAREN_ARG = 'Silly Bunny (data)';

/**
 * Sets or deletes an environment variable case-insensitively on a plain env
 * object so Windows keys such as `Path` and `PATH` cannot collide.
 * @param {Record<string, string | undefined>} target
 * @param {string} name
 * @param {string | undefined} value
 */
function setEnvCaseInsensitive(target, name, value) {
    for (const existingKey of Object.keys(target)) {
        if (existingKey.toLowerCase() === name.toLowerCase()) {
            delete target[existingKey];
        }
    }
    if (value !== undefined) {
        target[name] = value;
    }
}

/**
 * Finds a bash binary that can execute a script living inside a spaced and
 * parenthesized temp path. On Windows, `bash` on PATH often points to the WSL
 * app-execution alias, so fall back to Git Bash when installed.
 * @returns {string | null}
 */
function findUsableBash() {
    const probeRoot = mkdtempSync(path.join(tmpdir(), 'sb-bash-probe-'));
    const probeDir = path.join(probeRoot, SPACED_PAREN_DIR);
    const probeScript = path.join(probeDir, 'probe.sh');
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(probeScript, '#!/usr/bin/env bash\nset -euo pipefail\necho ok\n');

    const candidates = ['bash'];
    if (process.platform === 'win32') {
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const gitBash = path.join(programFiles, 'Git', 'bin', 'bash.exe');
        if (existsSync(gitBash)) {
            candidates.push(gitBash);
        }
    }

    try {
        for (const candidate of candidates) {
            try {
                const stdout = execFileSync(candidate, [probeScript], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                });
                if (stdout.trim() === 'ok') {
                    return candidate;
                }
            } catch {
                // Try the next candidate.
            }
        }
        return null;
    } finally {
        rmSync(probeRoot, { recursive: true, force: true });
    }
}

/**
 * Checks whether a real Bun executable is available on this Windows host.
 * Start.bat invokes `bun` directly without `call`, so stubbing Bun as a `.cmd`
 * script would transfer control out of Start.bat instead of returning.
 * @returns {boolean}
 */
function hasRealWindowsBun() {
    if (process.platform !== 'win32') {
        return false;
    }

    const bunCandidates = ['bun'];
    if (process.env.USERPROFILE) {
        const defaultBun = path.join(process.env.USERPROFILE, '.bun', 'bin', 'bun.exe');
        if (existsSync(defaultBun)) {
            bunCandidates.unshift(defaultBun);
        }
    }

    for (const candidate of bunCandidates) {
        const result = spawnSync(candidate, ['--version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (result.status === 0) {
            return true;
        }
    }
    return false;
}

const usableBash = findUsableBash();
const describeWindows = process.platform === 'win32' ? describe : describe.skip;
const describeWindowsBun = hasRealWindowsBun() ? describe : describe.skip;
const describePosix = usableBash ? describe : describe.skip;

describe('launcher CI workflow legs', () => {
    test('bootstrap-smoke runs on pull requests to staging and release without a paths filter', () => {
        expect(smokeWorkflow.on.pull_request.branches).toEqual(['staging', 'release']);
        expect(smokeWorkflow.on.pull_request.paths).toBeUndefined();
    });

    test('pins every GitHub Action in bootstrap-smoke.yml to a 40-character commit SHA', () => {
        const uses = Object.values(smokeWorkflow.jobs)
            .flatMap(job => job.steps.map(step => step.uses).filter(Boolean));
        expect(uses.length).toBeGreaterThan(0);
        for (const reference of uses) {
            expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        }
    });

    test('runs Windows launchers Start.bat, Start-Bun.bat and Start-Node.bat from a spaced and parenthesized folder', () => {
        const windowsJob = smokeWorkflow.jobs.windows;
        expect(windowsJob.name).toBe('Bootstrap smoke (${{ matrix.runtime }})');
        expect(windowsJob['runs-on']).toBe('windows-latest');
        expect(windowsJob.env.INSTALL_DIR_NAME).toBe(SPACED_PAREN_DIR);

        const secondaryLaunchers = windowsJob.strategy.matrix.include.map(entry => entry.secondary_launcher);
        expect(secondaryLaunchers).toEqual(expect.arrayContaining(['Start-Bun.bat', 'Start-Node.bat']));

        const startBatStep = windowsJob.steps.find(step => step.name === 'Boot the installed copy through Start.bat');
        const secondaryStep = windowsJob.steps.find(step => step.name === 'Boot the installed copy through ${{ matrix.secondary_launcher }}');
        expect(startBatStep).toBeDefined();
        expect(secondaryStep).toBeDefined();

        expect(startBatStep.run).toContain('call `"$installDir\\Start.bat`" < NUL');
        expect(startBatStep.run).toContain('-WorkingDirectory $env:RUNNER_TEMP');
        expect(startBatStep.run).not.toContain('cd /d');
        expect(startBatStep.run).toContain('$banner -notlike "*$env:INSTALL_DIR_NAME*"');

        expect(secondaryStep.run).toContain('call `"$launcherPath`" --port 4445 < NUL');
        expect(secondaryStep.run).toContain('-WorkingDirectory $env:RUNNER_TEMP');
        expect(secondaryStep.run).toContain('Entering SillyBunny (Node.js mode)...');
        expect(secondaryStep.run).toContain('$banner -notlike "*$env:INSTALL_DIR_NAME*"');
    });

    test('runs POSIX launchers start.sh, start-bun.sh and start-node.sh from a spaced and parenthesized folder on Linux and macOS', () => {
        const posixJob = smokeWorkflow.jobs.posix;
        expect(posixJob['runs-on']).toBe('${{ matrix.os }}');
        expect(posixJob.env.INSTALL_DIR_NAME).toBe(SPACED_PAREN_DIR);

        const matrix = posixJob.strategy.matrix.include;
        expect(matrix.some(entry => entry.os === 'ubuntu-latest' && entry.secondary_launcher === 'start-bun.sh')).toBe(true);
        expect(matrix.some(entry => entry.os === 'ubuntu-latest' && entry.secondary_launcher === 'start-node.sh')).toBe(true);
        expect(matrix.some(entry => entry.os === 'macos-latest' && entry.secondary_launcher === 'start-bun.sh')).toBe(true);
        expect(matrix.some(entry => entry.os === 'macos-latest' && entry.secondary_launcher === 'start-node.sh')).toBe(true);

        const startShStep = posixJob.steps.find(step => step.name === 'Boot the installed copy through start.sh');
        const secondaryStep = posixJob.steps.find(step => step.name === 'Boot the installed copy through ${{ matrix.secondary_launcher }}');
        expect(startShStep).toBeDefined();
        expect(secondaryStep).toBeDefined();

        expect(startShStep.run).toContain('cd "$RUNNER_TEMP"');
        expect(startShStep.run).toContain('bash "$install_dir/start.sh"');
        expect(startShStep.run).toContain('"$banner" != *"$INSTALL_DIR_NAME"*');

        expect(secondaryStep.run).toContain('cd "$RUNNER_TEMP"');
        expect(secondaryStep.run).toContain('bash "$install_dir/$LAUNCHER_SCRIPT" --port 4445');
        expect(secondaryStep.run).toContain('"$banner" != *"$INSTALL_DIR_NAME"*');
    });
});

describeWindows('Windows batch launchers in a path with spaces and parentheses', () => {
    let workRoot;
    let appDir;
    let callerDir;
    let markerToken;

    beforeAll(() => {
        const rawRoot = mkdtempSync(path.join(tmpdir(), 'sb-win-launchers-'));
        workRoot = typeof realpathSync.native === 'function' ? realpathSync.native(rawRoot) : realpathSync(rawRoot);
        appDir = path.join(workRoot, SPACED_PAREN_DIR);
        callerDir = path.join(workRoot, 'caller cwd');
        markerToken = 'sb-win-marker-7391';

        mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
        mkdirSync(path.join(appDir, 'node_modules'), { recursive: true });
        mkdirSync(callerDir, { recursive: true });

        for (const launcher of ['Start.bat', 'Start-Node.bat', 'Start-Bun.bat']) {
            copyFileSync(path.join(repoRoot, launcher), path.join(appDir, launcher));
        }

        writeFileSync(path.join(appDir, '.launcher-cwd-marker'), markerToken);
        writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
            name: 'sillybunny',
            version: '0.0.0',
            scripts: {
                init: 'node scripts/stub-init.js',
            },
        }, null, 2));
        writeFileSync(path.join(appDir, 'package-lock.json'), JSON.stringify({
            name: 'sillybunny',
            version: '0.0.0',
            lockfileVersion: 3,
            requires: true,
            packages: {
                '': {
                    name: 'sillybunny',
                    version: '0.0.0',
                },
            },
        }, null, 2));

        writeFileSync(path.join(appDir, 'scripts', 'dependency-state.js'), [
            'import fs from \'node:fs\';',
            'const [action, profile] = process.argv.slice(2);',
            'if (process.env.TEST_LOG_FILE) {',
            '    fs.appendFileSync(process.env.TEST_LOG_FILE, `DEP_STATE ${action} ${profile}\\n`);',
            '}',
            'if (action === \'check\' && process.env.TEST_DEP_CHECK_EXIT) {',
            '    process.exit(Number(process.env.TEST_DEP_CHECK_EXIT));',
            '}',
            'process.exit(0);',
            '',
        ].join('\n'));

        writeFileSync(path.join(appDir, 'scripts', 'stub-init.js'), [
            'import fs from \'node:fs\';',
            'if (process.env.TEST_LOG_FILE) {',
            '    fs.appendFileSync(process.env.TEST_LOG_FILE, `INIT_RUN cwd=${process.cwd()}\\n`);',
            '}',
            'console.log(`STUB_INIT_OK ${process.cwd()}`);',
            '',
        ].join('\n'));

        writeFileSync(path.join(appDir, 'server.js'), [
            'import fs from \'node:fs\';',
            'import path from \'node:path\';',
            'const payload = {',
            '    runtime: globalThis.Bun ? \'bun\' : \'node\',',
            '    cwd: process.cwd(),',
            '    marker: fs.existsSync(path.join(process.cwd(), \'.launcher-cwd-marker\'))',
            '        ? fs.readFileSync(path.join(process.cwd(), \'.launcher-cwd-marker\'), \'utf8\').trim()',
            '        : \'\',',
            '    args: process.argv.slice(2),',
            '    launcherEnv: process.env.SILLYBUNNY_LAUNCHER || \'\',',
            '    nodeEnv: process.env.NODE_ENV || \'\',',
            '};',
            'if (process.env.TEST_RESULT_FILE) {',
            '    fs.writeFileSync(process.env.TEST_RESULT_FILE, JSON.stringify(payload));',
            '}',
            'console.log(`STUB_SERVER ${JSON.stringify(payload)}`);',
            '',
        ].join('\n'));

        writeFileSync(path.join(appDir, 'scripts', 'Self-Update.ps1'), [
            'param([switch]$Optional)',
            'if ($env:TEST_LOG_FILE) {',
            '    Add-Content -LiteralPath $env:TEST_LOG_FILE -Value "SELF_UPDATE optional=$($Optional.IsPresent) root=$PSScriptRoot"',
            '}',
            'Write-Host "SELF_UPDATE_OK $PSScriptRoot"',
            '',
        ].join('\r\n'));
    });

    afterAll(() => {
        rmSync(workRoot, { recursive: true, force: true });
    });

    /**
     * Runs a Windows batch launcher through a wrapper outside the install folder
     * with stdin redirected from NUL so `pause` never blocks.
     */
    function runBatLauncher(batName, { args = [], extraEnv = {} } = {}) {
        const runId = `${batName.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const resultFile = path.join(workRoot, `${runId}.result.json`);
        const logFile = path.join(workRoot, `${runId}.events.log`);
        const wrapperPath = path.join(workRoot, `${runId}.wrapper.cmd`);
        const batPath = path.join(appDir, batName);

        const formattedArgs = args.map(arg => (/[\s()]/).test(arg) ? `"${arg}"` : arg).join(' ');
        const callLine = formattedArgs
            ? `call "${batPath}" ${formattedArgs} < NUL`
            : `call "${batPath}" < NUL`;
        writeFileSync(wrapperPath, `@echo off\r\n${callLine}\r\nexit /b %errorlevel%\r\n`);

        const env = { ...process.env };
        setEnvCaseInsensitive(env, 'SILLYBUNNY_USE_NODE', undefined);
        setEnvCaseInsensitive(env, 'SILLYBUNNY_USE_BUN', undefined);
        setEnvCaseInsensitive(env, 'SILLYBUNNY_BUN_SMOL', undefined);
        setEnvCaseInsensitive(env, 'TEST_DEP_CHECK_EXIT', undefined);
        setEnvCaseInsensitive(env, 'SILLYBUNNY_AUTO_UPDATE', '0');
        setEnvCaseInsensitive(env, 'SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH', '1');
        setEnvCaseInsensitive(env, 'npm_config_offline', 'true');
        setEnvCaseInsensitive(env, 'TEST_RESULT_FILE', resultFile);
        setEnvCaseInsensitive(env, 'TEST_LOG_FILE', logFile);

        for (const [key, value] of Object.entries(extraEnv)) {
            setEnvCaseInsensitive(env, key, value);
        }

        const result = spawnSync('cmd.exe', ['/d', '/c', wrapperPath], {
            cwd: callerDir,
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30000,
        });

        const payload = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
        const events = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
        return {
            status: result.status,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            payload,
            events,
        };
    }

    test('Start-Node.bat parses, switches cwd into Silly Bunny (test) and forwards spaced/parenthesized args', () => {
        const dataArg = path.join(workRoot, SPACED_PAREN_ARG);
        const run = runBatLauncher('Start-Node.bat', {
            args: ['--port', '14444', '--dataRoot', dataArg],
        });

        expect(run.status).toBe(0);
        expect(run.stderr).not.toMatch(/unexpected at this time/i);
        expect(run.stdout).toContain('Dependencies are up to date.');
        expect(run.stdout).toContain('Entering SillyBunny (Node.js mode)...');
        expect(run.events).toContain('DEP_STATE check node-production');
        expect(run.events).toContain(`INIT_RUN cwd=${appDir}`);
        expect(run.payload).toEqual({
            runtime: 'node',
            cwd: appDir,
            marker: markerToken,
            args: ['--port', '14444', '--dataRoot', dataArg],
            launcherEnv: '1',
            nodeEnv: 'production',
        });
    });

    test('Start-Node.bat executes its dependency install block cleanly in Silly Bunny (test)', () => {
        const run = runBatLauncher('Start-Node.bat', {
            args: ['--port', '14445'],
            extraEnv: { TEST_DEP_CHECK_EXIT: '1' },
        });

        expect(run.status).toBe(0);
        expect(run.stderr).not.toMatch(/unexpected at this time/i);
        expect(run.stdout).toContain('Installing packages via npm (Node.js mode)...');
        expect(run.events).toContain('DEP_STATE check node-production');
        expect(run.events).toContain('DEP_STATE mark node-production');
        expect(run.events).toContain(`INIT_RUN cwd=${appDir}`);
        expect(run.payload?.runtime).toBe('node');
        expect(run.payload?.marker).toBe(markerToken);
        expect(run.payload?.args).toEqual(['--port', '14445']);
    });

    test('Start.bat in Node mode handles spaced/parenthesized paths, install block and Self-Update.ps1', () => {
        const gitMarkerDir = path.join(appDir, '.git');
        mkdirSync(gitMarkerDir, { recursive: true });
        try {
            const dataArg = path.join(workRoot, SPACED_PAREN_ARG);
            const run = runBatLauncher('Start.bat', {
                args: ['--port', '14446', '--dataRoot', dataArg],
                extraEnv: {
                    SILLYBUNNY_USE_NODE: '1',
                    SILLYBUNNY_AUTO_UPDATE: '1',
                    TEST_DEP_CHECK_EXIT: '1',
                },
            });

            expect(run.status).toBe(0);
            expect(run.stderr).not.toMatch(/unexpected at this time/i);
            expect(run.stdout).toContain('Installing packages via npm (Node.js mode)...');
            expect(run.events).toContain('SELF_UPDATE optional=True');
            expect(run.events).toContain(SPACED_PAREN_DIR);
            expect(run.events).toContain('DEP_STATE check node-production');
            expect(run.events).toContain('DEP_STATE mark node-production');
            expect(run.events).toContain(`INIT_RUN cwd=${appDir}`);
            expect(run.payload).toEqual({
                runtime: 'node',
                cwd: appDir,
                marker: markerToken,
                args: ['--port', '14446', '--dataRoot', dataArg],
                launcherEnv: '1',
                nodeEnv: 'production',
            });
        } finally {
            rmSync(gitMarkerDir, { recursive: true, force: true });
        }
    });

    describeWindowsBun('Bun-backed Windows launchers', () => {
        test('Start.bat defaults to Bun in Silly Bunny (test) and forwards spaced/parenthesized args', () => {
            const dataArg = path.join(workRoot, SPACED_PAREN_ARG);
            const run = runBatLauncher('Start.bat', {
                args: ['--port', '14447', '--dataRoot', dataArg],
            });

            expect(run.status).toBe(0);
            expect(run.stderr).not.toMatch(/unexpected at this time/i);
            expect(run.stdout).toContain('Dependencies are up to date.');
            expect(run.events).toContain('DEP_STATE check bun-production');
            expect(run.events).toContain(`INIT_RUN cwd=${appDir}`);
            expect(run.payload).toEqual({
                runtime: 'bun',
                cwd: appDir,
                marker: markerToken,
                args: ['--port', '14447', '--dataRoot', dataArg],
                launcherEnv: '1',
                nodeEnv: 'production',
            });
        });

        test('Start-Bun.bat clears SILLYBUNNY_USE_NODE and delegates to Start.bat inside Silly Bunny (test)', () => {
            const dataArg = path.join(workRoot, SPACED_PAREN_ARG);
            const run = runBatLauncher('Start-Bun.bat', {
                args: ['--port', '14448', '--dataRoot', dataArg],
                extraEnv: { SILLYBUNNY_USE_NODE: '1' },
            });

            expect(run.status).toBe(0);
            expect(run.stderr).not.toMatch(/unexpected at this time/i);
            expect(run.stdout).toContain('Dependencies are up to date.');
            expect(run.events).toContain('DEP_STATE check bun-production');
            expect(run.payload).toEqual({
                runtime: 'bun',
                cwd: appDir,
                marker: markerToken,
                args: ['--port', '14448', '--dataRoot', dataArg],
                launcherEnv: '1',
                nodeEnv: 'production',
            });
        });
    });
});

describePosix('POSIX launchers in a path with spaces and parentheses', () => {
    let workRoot;
    let appDir;
    let callerDir;
    let fakeBinDir;
    let fakeHomeDir;
    let markerToken;

    function writeExecutable(filePath, content) {
        writeFileSync(filePath, content.replace(/\r\n/g, '\n'));
        chmodSync(filePath, 0o755);
    }

    beforeAll(() => {
        workRoot = mkdtempSync(path.join(tmpdir(), 'sb-posix-launchers-'));
        appDir = path.join(workRoot, SPACED_PAREN_DIR);
        callerDir = path.join(workRoot, 'caller cwd');
        fakeBinDir = path.join(workRoot, 'fake bin');
        fakeHomeDir = path.join(workRoot, 'fake home');
        markerToken = 'sb-posix-marker-8421';

        mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
        mkdirSync(callerDir, { recursive: true });
        mkdirSync(fakeBinDir, { recursive: true });
        mkdirSync(fakeHomeDir, { recursive: true });

        for (const launcher of [
            'start.sh',
            'start-bun.sh',
            'start-node.sh',
            'Start.command',
            'Start-Bun.command',
            'Start-Node.command',
        ]) {
            const dest = path.join(appDir, launcher);
            copyFileSync(path.join(repoRoot, launcher), dest);
            chmodSync(dest, 0o755);
        }

        writeFileSync(path.join(appDir, '.launcher-cwd-marker'), markerToken);
        writeFileSync(path.join(appDir, 'package-lock.json'), '{}\n');

        writeExecutable(path.join(appDir, 'scripts', 'install-prerequisites.sh'), [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'printf \'PREREQ %s\\n\' "$*" >> "$TEST_LOG_FILE"',
            '',
        ].join('\n'));

        writeExecutable(path.join(appDir, 'scripts', 'self-update.sh'), [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'printf \'SELF_UPDATE %s cwd=%s\\n\' "$*" "$(basename "$PWD")" >> "$TEST_LOG_FILE"',
            '',
        ].join('\n'));

        writeExecutable(path.join(fakeBinDir, 'bun'), [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'if [[ "${1:-}" == *"dependency-state.js" ]]; then',
            '    printf \'BUN_DEP %s %s\\n\' "${2:-}" "${3:-}" >> "$TEST_LOG_FILE"',
            '    if [[ "${2:-}" == "check" && -n "${TEST_DEP_CHECK_EXIT:-}" ]]; then',
            '        exit "$TEST_DEP_CHECK_EXIT"',
            '    fi',
            '    exit 0',
            'fi',
            'if [[ "${1:-}" == "install" ]]; then',
            '    printf \'BUN_INSTALL %s\\n\' "$*" >> "$TEST_LOG_FILE"',
            '    exit 0',
            'fi',
            'if [[ "${1:-}" == "run" ]]; then',
            '    printf \'BUN_RUN %s cwd=%s\\n\' "$*" "$(basename "$PWD")" >> "$TEST_LOG_FILE"',
            '    exit 0',
            'fi',
            'marker="$(cat ./.launcher-cwd-marker 2>/dev/null || true)"',
            'printf \'SERVER runtime=bun cwd=%s marker=%s launcher=%s node_env=%s\' "$(basename "$PWD")" "$marker" "${SILLYBUNNY_LAUNCHER:-}" "${NODE_ENV:-}" > "$TEST_RESULT_FILE"',
            'for arg in "$@"; do',
            '    printf \'|%s\' "$arg" >> "$TEST_RESULT_FILE"',
            'done',
            'printf \'\\n\' >> "$TEST_RESULT_FILE"',
            '',
        ].join('\n'));

        writeExecutable(path.join(fakeBinDir, 'node'), [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'if [[ "${1:-}" == *"dependency-state.js" ]]; then',
            '    printf \'NODE_DEP %s %s\\n\' "${2:-}" "${3:-}" >> "$TEST_LOG_FILE"',
            '    if [[ "${2:-}" == "check" && -n "${TEST_DEP_CHECK_EXIT:-}" ]]; then',
            '        exit "$TEST_DEP_CHECK_EXIT"',
            '    fi',
            '    exit 0',
            'fi',
            'marker="$(cat ./.launcher-cwd-marker 2>/dev/null || true)"',
            'printf \'SERVER runtime=node cwd=%s marker=%s launcher=%s node_env=%s\' "$(basename "$PWD")" "$marker" "${SILLYBUNNY_LAUNCHER:-}" "${NODE_ENV:-}" > "$TEST_RESULT_FILE"',
            'for arg in "$@"; do',
            '    printf \'|%s\' "$arg" >> "$TEST_RESULT_FILE"',
            'done',
            'printf \'\\n\' >> "$TEST_RESULT_FILE"',
            '',
        ].join('\n'));

        writeExecutable(path.join(fakeBinDir, 'npm'), [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'printf \'NPM %s cwd=%s\\n\' "$*" "$(basename "$PWD")" >> "$TEST_LOG_FILE"',
            '',
        ].join('\n'));
    });

    afterAll(() => {
        rmSync(workRoot, { recursive: true, force: true });
    });

    function runPosixLauncher(scriptName, { args = [], extraEnv = {} } = {}) {
        const runId = `${scriptName.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const resultFile = path.join(workRoot, `${runId}.result.txt`);
        const logFile = path.join(workRoot, `${runId}.events.log`);
        const scriptPath = path.join(appDir, scriptName);

        const env = { ...process.env };
        setEnvCaseInsensitive(env, 'SILLYBUNNY_USE_NODE', undefined);
        setEnvCaseInsensitive(env, 'SILLYBUNNY_USE_BUN', undefined);
        setEnvCaseInsensitive(env, 'SILLYBUNNY_BUN_SMOL', undefined);
        setEnvCaseInsensitive(env, 'TERMUX_VERSION', undefined);
        setEnvCaseInsensitive(env, 'PREFIX', undefined);
        setEnvCaseInsensitive(env, 'TEST_DEP_CHECK_EXIT', undefined);

        const currentPath = process.env.PATH || process.env.Path || '';
        setEnvCaseInsensitive(env, 'HOME', fakeHomeDir);
        setEnvCaseInsensitive(env, 'BUN_INSTALL', path.join(fakeHomeDir, 'empty-bun'));
        setEnvCaseInsensitive(env, 'SILLYBUNNY_NODE_INSTALL', path.join(fakeHomeDir, 'empty-node'));
        setEnvCaseInsensitive(env, 'SILLYBUNNY_AUTO_UPDATE', '0');
        setEnvCaseInsensitive(env, 'SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH', '1');
        setEnvCaseInsensitive(env, 'TEST_RESULT_FILE', resultFile);
        setEnvCaseInsensitive(env, 'TEST_LOG_FILE', logFile);
        setEnvCaseInsensitive(env, 'PATH', `${fakeBinDir}${path.delimiter}${currentPath}`);

        for (const [key, value] of Object.entries(extraEnv)) {
            setEnvCaseInsensitive(env, key, value);
        }

        const result = spawnSync(usableBash, [scriptPath, ...args], {
            cwd: callerDir,
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30000,
        });

        const serverLine = existsSync(resultFile) ? readFileSync(resultFile, 'utf8').trim() : '';
        const events = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
        return {
            status: result.status,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            serverLine,
            events,
        };
    }

    test('start.sh runs from Silly Bunny (test) in Bun mode and preserves spaced/parenthesized args', () => {
        const dataArg = `/tmp/${SPACED_PAREN_ARG}`;
        const run = runPosixLauncher('start.sh', {
            args: ['--port', '14444', '--dataRoot', dataArg],
            extraEnv: { SILLYBUNNY_USE_BUN: '1' },
        });

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('Dependencies are up to date.');
        expect(run.stdout).toContain('Entering SillyBunny...');
        expect(run.events).toContain('BUN_DEP check bun-production');
        expect(run.events).toContain(`BUN_RUN run init cwd=${SPACED_PAREN_DIR}`);
        expect(run.serverLine).toBe(
            `SERVER runtime=bun cwd=${SPACED_PAREN_DIR} marker=${markerToken} launcher=1 node_env=production|server.js|--port|14444|--dataRoot|${dataArg}`,
        );
    });

    test('start-bun.sh clears SILLYBUNNY_USE_NODE and delegates to start.sh inside Silly Bunny (test)', () => {
        const dataArg = `/tmp/${SPACED_PAREN_ARG}`;
        const run = runPosixLauncher('start-bun.sh', {
            args: ['--port', '14445', '--dataRoot', dataArg],
            extraEnv: { SILLYBUNNY_USE_NODE: '1' },
        });

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('Entering SillyBunny...');
        expect(run.serverLine).toBe(
            `SERVER runtime=bun cwd=${SPACED_PAREN_DIR} marker=${markerToken} launcher=1 node_env=production|server.js|--port|14445|--dataRoot|${dataArg}`,
        );
    });

    test('start-node.sh clears SILLYBUNNY_USE_BUN and delegates to start.sh inside Silly Bunny (test)', () => {
        const dataArg = `/tmp/${SPACED_PAREN_ARG}`;
        const run = runPosixLauncher('start-node.sh', {
            args: ['--port', '14446', '--dataRoot', dataArg],
            extraEnv: { SILLYBUNNY_USE_BUN: '1' },
        });

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('Entering SillyBunny...');
        expect(run.events).toContain('PREREQ --require-node-runtime --skip-bun');
        expect(run.events).toContain('NODE_DEP check node-production');
        expect(run.events).toContain(`NPM run init cwd=${SPACED_PAREN_DIR}`);
        expect(run.serverLine).toBe(
            `SERVER runtime=node cwd=${SPACED_PAREN_DIR} marker=${markerToken} launcher=1 node_env=production|--no-warnings|server.js|--port|14446|--dataRoot|${dataArg}`,
        );
    });

    test('start.sh exercises its install and optional self-update branches inside Silly Bunny (test)', () => {
        const gitMarkerDir = path.join(appDir, '.git');
        mkdirSync(gitMarkerDir, { recursive: true });
        try {
            const bunRun = runPosixLauncher('start.sh', {
                args: ['--port', '14447'],
                extraEnv: {
                    SILLYBUNNY_USE_BUN: '1',
                    SILLYBUNNY_AUTO_UPDATE: '1',
                    TEST_DEP_CHECK_EXIT: '1',
                },
            });

            expect(bunRun.status).toBe(0);
            expect(bunRun.events).toContain('PREREQ --require-git');
            expect(bunRun.events).toContain(`SELF_UPDATE --optional cwd=${SPACED_PAREN_DIR}`);
            expect(bunRun.events).toContain('BUN_INSTALL install --frozen-lockfile --no-progress --no-summary --production');
            expect(bunRun.events).toContain('BUN_DEP mark bun-production');

            const nodeRun = runPosixLauncher('start-node.sh', {
                args: ['--port', '14448'],
                extraEnv: {
                    SILLYBUNNY_AUTO_UPDATE: '0',
                    TEST_DEP_CHECK_EXIT: '1',
                },
            });

            expect(nodeRun.status).toBe(0);
            expect(nodeRun.events).toContain(`NPM ci --no-audit --no-fund --omit=dev cwd=${SPACED_PAREN_DIR}`);
            expect(nodeRun.events).toContain('NODE_DEP mark node-production');
        } finally {
            rmSync(gitMarkerDir, { recursive: true, force: true });
        }
    });

    test('macOS .command wrappers delegate across spaces and parentheses', () => {
        const startCommand = runPosixLauncher('Start.command', {
            args: ['--port', '14449'],
            extraEnv: { SILLYBUNNY_USE_BUN: '1' },
        });
        expect(startCommand.status).toBe(0);
        expect(startCommand.serverLine).toContain(`runtime=bun cwd=${SPACED_PAREN_DIR} marker=${markerToken}`);

        const bunCommand = runPosixLauncher('Start-Bun.command', {
            args: ['--port', '14450'],
            extraEnv: { SILLYBUNNY_USE_NODE: '1' },
        });
        expect(bunCommand.status).toBe(0);
        expect(bunCommand.serverLine).toContain(`runtime=bun cwd=${SPACED_PAREN_DIR} marker=${markerToken}`);

        const nodeCommand = runPosixLauncher('Start-Node.command', {
            args: ['--port', '14451'],
            extraEnv: { SILLYBUNNY_USE_BUN: '1' },
        });
        expect(nodeCommand.status).toBe(0);
        expect(nodeCommand.serverLine).toContain(`runtime=node cwd=${SPACED_PAREN_DIR} marker=${markerToken}`);
    });
});
