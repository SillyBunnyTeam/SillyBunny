import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfUpdateMjsPath = path.join(repoRoot, 'scripts', 'self-update.mjs');
const selfUpdateShPath = path.join(repoRoot, 'scripts', 'self-update.sh');
const startBatPath = path.join(repoRoot, 'Start.bat');
const startNodeBatPath = path.join(repoRoot, 'Start-Node.bat');
const startShPath = path.join(repoRoot, 'start.sh');

const selfUpdateMjsSource = fs.readFileSync(selfUpdateMjsPath, 'utf8');
const selfUpdateShSource = fs.readFileSync(selfUpdateShPath, 'utf8');
const startBatSource = fs.readFileSync(startBatPath, 'utf8');
const startNodeBatSource = fs.readFileSync(startNodeBatPath, 'utf8');
const startShSource = fs.readFileSync(startShPath, 'utf8');

const hasBun = spawnSync('bun', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;
const runtimeMatrix = [
    ['node', process.execPath],
    ...(hasBun ? [['bun', 'bun']] : []),
];

let suiteRoot = '';
let emptyGitConfigPath = '';

function resolveUsableBash(probeRoot) {
    const probePath = path.join(probeRoot, 'bash-probe.sh');
    fs.writeFileSync(probePath, '#!/usr/bin/env bash\nset -euo pipefail\nprintf ready\n');
    const candidates = [];

    if (process.platform === 'win32') {
        try {
            const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
            candidates.push(path.resolve(gitExecPath, '..', '..', '..', 'bin', 'bash.exe'));
        } catch {
            // Git Bash discovery is optional on Windows hosts without Git for Windows.
        }
    } else if (process.env.BASH) {
        candidates.push(process.env.BASH);
    }
    candidates.push('bash');

    for (const candidate of [...new Set(candidates.filter(Boolean))]) {
        try {
            const stdout = execFileSync(candidate, [probePath], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            });
            if (stdout.trim() === 'ready') {
                return candidate;
            }
        } catch {
            // Candidate cannot execute scripts in os.tmpdir() (e.g. unconfigured WSL stub).
        }
    }

    return null;
}

function toPosixShellPath(bashExecutable, targetPath) {
    if (process.platform !== 'win32' || !bashExecutable) {
        return targetPath;
    }

    return execFileSync(bashExecutable, ['-lc', 'cygpath -u "$1"', 'bash', targetPath], {
        encoding: 'utf8',
        windowsHide: true,
    }).trim();
}

function makeGitEnv(extraEnv = {}) {
    const env = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: emptyGitConfigPath,
        GIT_AUTHOR_NAME: 'Test Author',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test Author',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        ...extraEnv,
    };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    return env;
}

function git(cwd, ...args) {
    const result = spawnSync('git', args, {
        cwd,
        env: makeGitEnv(),
        encoding: 'utf8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
    }
    return result.stdout.trim();
}

let fixtureCounter = 0;

function createSelfUpdateFixture() {
    fixtureCounter += 1;
    const dir = path.join(suiteRoot, `fixture-${fixtureCounter}`);
    const remoteDir = path.join(dir, 'remote.git');
    const upstreamWorkDir = path.join(dir, 'upstream-work');
    const cloneDir = path.join(dir, 'clone');

    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '--quiet', '--bare', '--initial-branch=release', remoteDir);
    git(dir, 'init', '--quiet', '--initial-branch=release', upstreamWorkDir);

    fs.writeFileSync(path.join(upstreamWorkDir, 'README.md'), 'initial\n');
    fs.writeFileSync(path.join(upstreamWorkDir, 'bun.lock'), 'lockfile-v1\n');
    git(upstreamWorkDir, 'add', 'README.md', 'bun.lock');
    git(upstreamWorkDir, 'commit', '--quiet', '-m', 'initial commit');
    git(upstreamWorkDir, 'remote', 'add', 'origin', remoteDir);
    git(upstreamWorkDir, 'push', '--quiet', '-u', 'origin', 'release');
    git(dir, 'clone', '--quiet', '--branch', 'release', remoteDir, cloneDir);

    return { dir, remoteDir, upstreamWorkDir, cloneDir };
}

function runMjsSelfUpdate(runtimeBin, cloneDir, args = [], extraEnv = {}) {
    const result = spawnSync(runtimeBin, [selfUpdateMjsPath, '--repo', cloneDir, ...args], {
        cwd: cloneDir,
        env: makeGitEnv(extraEnv),
        encoding: 'utf8',
        windowsHide: true,
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
    };
}

const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perf-launchers-bash-'));
const bashExecutable = resolveUsableBash(probeRoot);
fs.rmSync(probeRoot, { recursive: true, force: true });

const describeWin32 = process.platform === 'win32' ? describe : describe.skip;
const describeShell = bashExecutable ? describe : describe.skip;

beforeAll(() => {
    suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-perf-launchers-'));
    emptyGitConfigPath = path.join(suiteRoot, 'empty.gitconfig');
    fs.writeFileSync(emptyGitConfigPath, '');
});

afterAll(() => {
    if (suiteRoot) {
        fs.rmSync(suiteRoot, { recursive: true, force: true });
    }
});

describe('cross-platform launcher static and line-ending contracts', () => {
    test('Windows batch launchers preserve strict CRLF line endings', () => {
        expect((startBatSource.match(/(?<!\r)\n/g) || []).length).toBe(0);
        expect((startBatSource.match(/\r\n/g) || []).length).toBeGreaterThan(50);
        expect((startNodeBatSource.match(/(?<!\r)\n/g) || []).length).toBe(0);
        expect((startNodeBatSource.match(/\r\n/g) || []).length).toBeGreaterThan(30);
    });

    test('POSIX shell and ESM self-update scripts preserve strict LF line endings', () => {
        expect(startShSource.includes('\r')).toBe(false);
        expect(selfUpdateShSource.includes('\r')).toBe(false);
        expect(selfUpdateMjsSource.includes('\r')).toBe(false);
    });

    test('scripts/self-update.mjs uses only built-in node:* modules', () => {
        const specifiers = [...selfUpdateMjsSource.matchAll(/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm)]
            .map(match => match[1]);
        expect(specifiers.length).toBeGreaterThan(0);
        expect(specifiers.every(specifier => specifier.startsWith('node:'))).toBe(true);
    });

    test('Start.bat and Start-Node.bat invoke server-init.js directly and fast-check known runtime paths', () => {
        expect(startBatSource).not.toContain('call npm run init');
        expect(startBatSource).not.toContain('call bun run init');
        expect(startNodeBatSource).not.toContain('call npm run init');

        expect(startBatSource).toContain('node "%~dp0src\\server-init.js"');
        expect(startBatSource).toContain('bun "%~dp0src\\server-init.js"');
        expect(startNodeBatSource).toContain('node "%~dp0src\\server-init.js"');

        expect(startBatSource).toContain('"%RUNTIME_CMD%" "%~dp0scripts\\self-update.mjs" --optional');
        expect(startBatSource).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\Self-Update.ps1" -Optional');

        expect(startBatSource).toContain('if exist "%USERPROFILE%\\.bun\\bin\\bun.exe"');
        expect(startBatSource).toContain('if exist "%ProgramFiles%\\nodejs\\node.exe"');
        expect(startNodeBatSource).toContain('if exist "%ProgramFiles%\\nodejs\\node.exe"');

        expect(startBatSource).toContain('node_modules\\.cache\\.sillybunny-boot-stamp');
        expect(startNodeBatSource).toContain('node_modules\\.cache\\.sillybunny-boot-stamp');
    });

    test('start.sh gates install-prerequisites.sh, invokes server-init.js directly, and avoids exec on the server loop', () => {
        expect(startShSource).not.toContain('"$PACKAGE_MANAGER_CMD" run init');
        expect(startShSource).toContain('"$RUNTIME_CMD" "$SCRIPT_DIR/src/server-init.js"');
        expect(startShSource).toContain('if ! have_required_prerequisites; then');
        expect(startShSource).toContain('node_modules/.cache/.sillybunny-boot-stamp');

        const runServerMatch = startShSource.match(/^run_server\(\) \{[\s\S]*?^\}/m);
        expect(runServerMatch).not.toBeNull();
        expect(runServerMatch[0]).not.toMatch(/\bexec\b/);
    });

    test('scripts/self-update.sh runs git status --porcelain once and configures optional fetch timeouts and --no-tags', () => {
        const porcelainMatches = selfUpdateShSource.match(/git status --porcelain --untracked-files=normal/g) || [];
        expect(porcelainMatches).toHaveLength(1);
        expect(selfUpdateShSource).toContain('remote.$upstream_remote.tagOpt=--no-tags');
        expect(selfUpdateShSource).toContain('http.lowSpeedLimit=1000');
        expect(selfUpdateShSource).toContain('http.lowSpeedTime=$low_speed_time');
    });
});

describe.each(runtimeMatrix)('scripts/self-update.mjs parity on %s', (_runtimeName, runtimeBin) => {
    test('reports up to date on a clean checkout and runs git status at most once', () => {
        const { cloneDir, dir } = createSelfUpdateFixture();
        const tracePath = path.join(dir, 'git-trace.log');

        const result = runMjsSelfUpdate(runtimeBin, cloneDir, ['--optional'], {
            GIT_TRACE: tracePath,
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('Checking for updates on origin/release...');
        expect(result.stdout).toContain('SillyBunny is already up to date.');

        const traceText = fs.readFileSync(tracePath, 'utf8');
        const statusInvocations = traceText.match(/built-in: git status --porcelain --untracked-files=normal/g) || [];
        expect(statusInvocations).toHaveLength(1);
        expect(traceText).toContain('--no-tags');
    });

    test('supports PowerShell-style -Optional flag and linked git worktrees', () => {
        const { cloneDir, dir } = createSelfUpdateFixture();
        const worktreeDir = path.join(dir, 'linked-worktree');
        git(cloneDir, 'checkout', '-b', 'feature-branch');
        git(cloneDir, 'push', '--quiet', '-u', 'origin', 'feature-branch');
        git(cloneDir, 'checkout', '--quiet', 'release');
        git(cloneDir, 'worktree', 'add', '--quiet', worktreeDir, 'feature-branch');

        const result = runMjsSelfUpdate(runtimeBin, worktreeDir, ['-Optional']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Checking for updates on origin/feature-branch...');
        expect(result.stdout).toContain('SillyBunny is already up to date.');
    });

    test('fast-forwards cleanly when upstream advances', () => {
        const { upstreamWorkDir, cloneDir } = createSelfUpdateFixture();
        const beforeShort = git(cloneDir, 'rev-parse', '--short', 'HEAD');

        fs.writeFileSync(path.join(upstreamWorkDir, 'README.md'), 'updated upstream\n');
        git(upstreamWorkDir, 'add', 'README.md');
        git(upstreamWorkDir, 'commit', '--quiet', '-m', 'upstream update');
        git(upstreamWorkDir, 'push', '--quiet', 'origin', 'release');
        const afterShort = git(upstreamWorkDir, 'rev-parse', '--short', 'HEAD');

        const result = runMjsSelfUpdate(runtimeBin, cloneDir, ['--optional']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Updating SillyBunny...');
        expect(result.stdout).toContain(`Updated SillyBunny from ${beforeShort} to ${afterShort}.`);
        expect(fs.readFileSync(path.join(cloneDir, 'README.md'), 'utf8')).toBe('updated upstream\n');
    });

    test('restores a lone tracked bun.lock change before pulling updates', () => {
        const { upstreamWorkDir, cloneDir } = createSelfUpdateFixture();

        fs.writeFileSync(path.join(upstreamWorkDir, 'README.md'), 'after lockfile restore\n');
        git(upstreamWorkDir, 'add', 'README.md');
        git(upstreamWorkDir, 'commit', '--quiet', '-m', 'advance release');
        git(upstreamWorkDir, 'push', '--quiet', 'origin', 'release');

        fs.writeFileSync(path.join(cloneDir, 'bun.lock'), 'locally-mutated-bun-lock\n');

        const result = runMjsSelfUpdate(runtimeBin, cloneDir, ['--optional']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Restoring tracked bun.lock before self-update...');
        expect(fs.readFileSync(path.join(cloneDir, 'bun.lock'), 'utf8')).toBe('lockfile-v1\n');
        expect(fs.readFileSync(path.join(cloneDir, 'README.md'), 'utf8')).toBe('after lockfile restore\n');
    });

    test('preserves dirty worktrees instead of overwriting local changes', () => {
        const { upstreamWorkDir, cloneDir } = createSelfUpdateFixture();
        fs.writeFileSync(path.join(upstreamWorkDir, 'README.md'), 'remote edit\n');
        git(upstreamWorkDir, 'add', 'README.md');
        git(upstreamWorkDir, 'commit', '--quiet', '-m', 'remote edit');
        git(upstreamWorkDir, 'push', '--quiet', 'origin', 'release');

        fs.writeFileSync(path.join(cloneDir, 'README.md'), 'my uncommitted work\n');

        const optionalResult = runMjsSelfUpdate(runtimeBin, cloneDir, ['--optional']);
        expect(optionalResult.status).toBe(0);
        expect(optionalResult.stderr).toContain('Skipping self-update: the working tree is not clean. Commit, stash, or remove local changes first.');
        expect(fs.readFileSync(path.join(cloneDir, 'README.md'), 'utf8')).toBe('my uncommitted work\n');

        const requiredResult = runMjsSelfUpdate(runtimeBin, cloneDir, []);
        expect(requiredResult.status).toBe(1);
        expect(requiredResult.stderr).toContain('Self-update failed: the working tree is not clean. Commit, stash, or remove local changes first.');
        expect(fs.readFileSync(path.join(cloneDir, 'README.md'), 'utf8')).toBe('my uncommitted work\n');
    });

    test('handles ahead, diverged, detached HEAD, missing upstream, and offline remotes cleanly', () => {
        const { upstreamWorkDir, cloneDir } = createSelfUpdateFixture();

        fs.writeFileSync(path.join(cloneDir, 'local.txt'), 'ahead\n');
        git(cloneDir, 'add', 'local.txt');
        git(cloneDir, 'commit', '--quiet', '-m', 'local commit');

        const aheadResult = runMjsSelfUpdate(runtimeBin, cloneDir);
        expect(aheadResult.status).toBe(0);
        expect(aheadResult.stdout).toContain('Local branch \'release\' is already ahead of \'origin/release\'; nothing to pull.');

        fs.writeFileSync(path.join(upstreamWorkDir, 'remote.txt'), 'diverged\n');
        git(upstreamWorkDir, 'add', 'remote.txt');
        git(upstreamWorkDir, 'commit', '--quiet', '-m', 'upstream commit');
        git(upstreamWorkDir, 'push', '--quiet', 'origin', 'release');

        const divergedOptional = runMjsSelfUpdate(runtimeBin, cloneDir, ['--optional']);
        expect(divergedOptional.status).toBe(0);
        expect(divergedOptional.stderr).toContain('Skipping self-update: branch \'release\' has diverged from \'origin/release\'.');

        const divergedRequired = runMjsSelfUpdate(runtimeBin, cloneDir);
        expect(divergedRequired.status).toBe(1);
        expect(divergedRequired.stderr).toContain('Self-update failed: branch \'release\' has diverged from \'origin/release\'.');

        const { cloneDir: offlineClone, dir: offlineParent } = createSelfUpdateFixture();
        git(offlineClone, 'remote', 'set-url', 'origin', path.join(offlineParent, 'missing-remote.git'));

        const offlineOptional = runMjsSelfUpdate(runtimeBin, offlineClone, ['--optional'], {
            SILLYBUNNY_GIT_LOW_SPEED_TIME: '1',
        });
        expect(offlineOptional.status).toBe(0);
        expect(offlineOptional.stderr).toContain('Skipping self-update: could not fetch from \'origin\'.');

        const offlineRequired = runMjsSelfUpdate(runtimeBin, offlineClone, []);
        expect(offlineRequired.status).toBe(1);
        expect(offlineRequired.stderr).toContain('Self-update failed: could not fetch from \'origin\'.');

        git(offlineClone, 'checkout', '--quiet', '-b', 'untracked-local-branch');
        const noUpstreamOptional = runMjsSelfUpdate(runtimeBin, offlineClone, ['--optional']);
        expect(noUpstreamOptional.status).toBe(0);
        expect(noUpstreamOptional.stderr).toContain('Skipping self-update: branch \'untracked-local-branch\' does not have an upstream configured.');

        git(offlineClone, 'checkout', '--quiet', '--detach', 'HEAD');
        const detachedOptional = runMjsSelfUpdate(runtimeBin, offlineClone, ['--optional']);
        expect(detachedOptional.status).toBe(0);
        expect(detachedOptional.stderr).toContain('Skipping self-update: detached HEAD checkouts cannot be updated automatically.');
    });
});

describeWin32('Windows batch warm-boot fast-stamp execution', () => {
    test('Start-Node.bat skips dependency-state and server-init on unchanged warm boots and invalidates on change', () => {
        const appDir = path.join(suiteRoot, 'win-warm-boot');
        fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(appDir, 'default'), { recursive: true });
        fs.mkdirSync(path.join(appDir, 'public'), { recursive: true });
        fs.mkdirSync(path.join(appDir, 'node_modules'), { recursive: true });

        fs.copyFileSync(startNodeBatPath, path.join(appDir, 'Start-Node.bat'));
        // Strip interactive `pause` at EOF so automated runs exit cleanly.
        const nonInteractiveBat = fs.readFileSync(path.join(appDir, 'Start-Node.bat'), 'utf8')
            .replace(/\r\npause\r\n/, '\r\n');
        fs.writeFileSync(path.join(appDir, 'Start-Node.bat'), nonInteractiveBat, 'utf8');

        fs.writeFileSync(path.join(appDir, 'package.json'), '{"name":"sillybunny","type":"module"}\n');
        fs.writeFileSync(path.join(appDir, 'package-lock.json'), '{"lockfileVersion":3}\n');
        fs.writeFileSync(path.join(appDir, 'default', 'config.yaml'), 'port: 4444\n');
        fs.writeFileSync(path.join(appDir, 'config.yaml'), 'port: 4444\n');
        fs.writeFileSync(path.join(appDir, 'public', 'index.html'), '<!doctype html>\n');
        fs.writeFileSync(path.join(appDir, 'node_modules', '.sillybunny-dependencies.json'), '{"version":1,"profiles":{}}\n');

        fs.writeFileSync(
            path.join(appDir, 'scripts', 'dependency-state.js'),
            'import fs from "node:fs"; fs.appendFileSync("boot-calls.log", `dep:${process.argv.slice(2).join(",")}\\n`);\n',
        );
        fs.writeFileSync(
            path.join(appDir, 'src', 'server-init.js'),
            'import fs from "node:fs"; fs.appendFileSync("boot-calls.log", "init\\n");\n',
        );
        fs.writeFileSync(
            path.join(appDir, 'server.js'),
            'import fs from "node:fs"; fs.appendFileSync("boot-calls.log", "server\\n");\n',
        );

        git(suiteRoot, 'init', '--quiet', '--initial-branch=release', appDir);
        git(appDir, 'add', 'package.json', 'package-lock.json', 'default/config.yaml');
        git(appDir, 'commit', '--quiet', '-m', 'fixture');

        const bootOnce = () => spawnSync('cmd.exe', ['/d', '/c', 'call Start-Node.bat'], {
            cwd: appDir,
            env: makeGitEnv(),
            encoding: 'utf8',
            windowsHide: true,
        });

        const firstRun = bootOnce();
        expect(firstRun.status).toBe(0);
        const stampPath = path.join(appDir, 'node_modules', '.cache', '.sillybunny-boot-stamp');
        expect(fs.existsSync(stampPath)).toBe(true);
        expect(fs.readFileSync(path.join(appDir, 'boot-calls.log'), 'utf8').trim().split('\n')).toEqual([
            'dep:check,node-production',
            'init',
            'server',
        ]);

        fs.writeFileSync(path.join(appDir, 'boot-calls.log'), '');
        const secondRun = bootOnce();
        expect(secondRun.status).toBe(0);
        expect(secondRun.stdout).toContain('Dependencies are up to date.');
        expect(fs.readFileSync(path.join(appDir, 'boot-calls.log'), 'utf8').trim().split('\n')).toEqual([
            'server',
        ]);

        fs.writeFileSync(path.join(appDir, 'boot-calls.log'), '');
        fs.writeFileSync(path.join(appDir, 'default', 'config.yaml'), 'port: 4444\nlisten: false\n');
        const thirdRun = bootOnce();
        expect(thirdRun.status).toBe(0);
        expect(fs.readFileSync(path.join(appDir, 'boot-calls.log'), 'utf8').trim().split('\n')).toEqual([
            'dep:check,node-production',
            'init',
            'server',
        ]);
    });

    test('Start.bat runs self-update.mjs, skips warm-boot init when unchanged, and invalidates after fast-forward pull', () => {
        const { upstreamWorkDir, cloneDir } = createSelfUpdateFixture();
        fs.mkdirSync(path.join(cloneDir, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(cloneDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(cloneDir, 'default'), { recursive: true });
        fs.mkdirSync(path.join(cloneDir, 'public'), { recursive: true });
        fs.mkdirSync(path.join(cloneDir, 'node_modules'), { recursive: true });

        const nonInteractiveStartBat = startBatSource.replace(/\r\npause\r\n/, '\r\n');
        fs.writeFileSync(path.join(cloneDir, 'Start.bat'), nonInteractiveStartBat, 'utf8');
        fs.copyFileSync(selfUpdateMjsPath, path.join(cloneDir, 'scripts', 'self-update.mjs'));
        fs.writeFileSync(path.join(cloneDir, 'package.json'), '{"name":"sillybunny","type":"module"}\n');
        fs.writeFileSync(path.join(cloneDir, 'package-lock.json'), '{"lockfileVersion":3}\n');
        fs.writeFileSync(path.join(cloneDir, 'default', 'config.yaml'), 'port: 4444\n');
        fs.writeFileSync(
            path.join(cloneDir, 'scripts', 'dependency-state.js'),
            'import fs from "node:fs"; fs.appendFileSync("node_modules/boot-calls.log", `dep:${process.argv.slice(2).join(",")}\\n`);\n',
        );
        fs.writeFileSync(
            path.join(cloneDir, 'src', 'server-init.js'),
            'import fs from "node:fs"; fs.appendFileSync("node_modules/boot-calls.log", "init\\n");\n',
        );
        fs.writeFileSync(
            path.join(cloneDir, 'server.js'),
            [
                'import fs from "node:fs";',
                'const marker = "node_modules/restarted.once";',
                'if (!fs.existsSync(marker)) {',
                '    fs.writeFileSync(marker, "1");',
                '    fs.appendFileSync("node_modules/boot-calls.log", "server:75\\n");',
                '    process.exit(75);',
                '}',
                'fs.appendFileSync("node_modules/boot-calls.log", `server:0:skipBrowser=${process.env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH || ""}\\n`);',
                '',
            ].join('\n'),
        );
        fs.writeFileSync(path.join(cloneDir, '.gitignore'), 'node_modules/\nconfig.yaml\npublic/\n');

        git(cloneDir, 'add', '-A');
        git(cloneDir, 'commit', '--quiet', '-m', 'launcher fixture');
        git(cloneDir, 'push', '--quiet', 'origin', 'release');
        git(upstreamWorkDir, 'pull', '--quiet', '--ff-only');

        fs.writeFileSync(path.join(cloneDir, 'config.yaml'), 'port: 4444\n');
        fs.writeFileSync(path.join(cloneDir, 'public', 'index.html'), '<!doctype html>\n');
        fs.writeFileSync(path.join(cloneDir, 'node_modules', '.sillybunny-dependencies.json'), '{"version":1,"profiles":{}}\n');

        const bootStartBat = () => spawnSync('cmd.exe', ['/d', '/c', 'call Start.bat'], {
            cwd: cloneDir,
            env: makeGitEnv({ SILLYBUNNY_USE_NODE: '1' }),
            encoding: 'utf8',
            windowsHide: true,
        });

        const coldRun = bootStartBat();
        expect(coldRun.status).toBe(0);
        expect(coldRun.stdout).toContain('Checking for updates on origin/release...');
        expect(coldRun.stdout).toContain('SillyBunny is already up to date.');
        expect(fs.readFileSync(path.join(cloneDir, 'node_modules', 'boot-calls.log'), 'utf8').trim().split('\n')).toEqual([
            'dep:check,node-production',
            'init',
            'server:75',
            'server:0:skipBrowser=1',
        ]);

        fs.writeFileSync(path.join(cloneDir, 'node_modules', 'boot-calls.log'), '');
        const warmRun = bootStartBat();
        expect(warmRun.status).toBe(0);
        expect(warmRun.stdout).toContain('SillyBunny is already up to date.');
        expect(warmRun.stdout).toContain('Dependencies are up to date.');
        expect(fs.readFileSync(path.join(cloneDir, 'node_modules', 'boot-calls.log'), 'utf8').trim().split('\n')).toEqual([
            'server:0:skipBrowser=',
        ]);

        fs.writeFileSync(path.join(upstreamWorkDir, 'README.md'), 'new release commit\n');
        git(upstreamWorkDir, 'add', 'README.md');
        git(upstreamWorkDir, 'commit', '--quiet', '-m', 'release bump');
        git(upstreamWorkDir, 'push', '--quiet', 'origin', 'release');

        fs.writeFileSync(path.join(cloneDir, 'node_modules', 'boot-calls.log'), '');
        const pulledRun = bootStartBat();
        expect(pulledRun.status).toBe(0);
        expect(pulledRun.stdout).toContain('Updated SillyBunny from ');
        expect(fs.readFileSync(path.join(cloneDir, 'node_modules', 'boot-calls.log'), 'utf8').trim().split('\n')).toEqual([
            'dep:check,node-production',
            'init',
            'server:0:skipBrowser=',
        ]);
    });
});

describeShell('POSIX shell warm-boot fast-stamp and self-update execution', () => {
    test('start.sh and scripts/self-update.sh execute warm-boot stamp, exit-75 restart, and self-update cleanly', () => {
        const { upstreamWorkDir, cloneDir } = createSelfUpdateFixture();
        fs.mkdirSync(path.join(cloneDir, 'scripts'), { recursive: true });
        fs.copyFileSync(selfUpdateShPath, path.join(cloneDir, 'scripts', 'self-update.sh'));
        git(cloneDir, 'add', 'scripts/self-update.sh');
        git(cloneDir, 'commit', '--quiet', '-m', 'add self-update.sh');
        git(cloneDir, 'push', '--quiet', 'origin', 'release');
        git(upstreamWorkDir, 'pull', '--quiet', '--ff-only');

        fs.writeFileSync(path.join(upstreamWorkDir, 'README.md'), 'shell-pulled\n');
        git(upstreamWorkDir, 'add', 'README.md');
        git(upstreamWorkDir, 'commit', '--quiet', '-m', 'advance for sh');
        git(upstreamWorkDir, 'push', '--quiet', 'origin', 'release');

        fs.writeFileSync(path.join(cloneDir, 'bun.lock'), 'dirty-bun-lock\n');

        const shUpdate = spawnSync(
            bashExecutable,
            [toPosixShellPath(bashExecutable, path.join(cloneDir, 'scripts', 'self-update.sh')), '--optional'],
            {
                cwd: cloneDir,
                env: makeGitEnv(),
                encoding: 'utf8',
                windowsHide: true,
            },
        );
        expect(shUpdate.status).toBe(0);
        expect(shUpdate.stdout).toContain('Restoring tracked bun.lock before self-update...');
        expect(shUpdate.stdout).toContain('Updated SillyBunny from ');
        expect(fs.readFileSync(path.join(cloneDir, 'bun.lock'), 'utf8')).toBe('lockfile-v1\n');
        expect(fs.readFileSync(path.join(cloneDir, 'README.md'), 'utf8')).toBe('shell-pulled\n');

        const appDir = path.join(suiteRoot, 'posix-warm-boot');
        fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(appDir, 'default'), { recursive: true });
        fs.mkdirSync(path.join(appDir, 'public'), { recursive: true });
        fs.mkdirSync(path.join(appDir, 'node_modules'), { recursive: true });

        fs.copyFileSync(startShPath, path.join(appDir, 'start.sh'));
        fs.writeFileSync(
            path.join(appDir, 'scripts', 'install-prerequisites.sh'),
            '#!/usr/bin/env bash\necho "prereq" >> boot-calls.log\n',
        );
        fs.writeFileSync(path.join(appDir, 'package.json'), '{"name":"sillybunny","type":"module"}\n');
        fs.writeFileSync(path.join(appDir, 'package-lock.json'), '{"lockfileVersion":3}\n');
        fs.writeFileSync(path.join(appDir, 'default', 'config.yaml'), 'port: 4444\n');
        fs.writeFileSync(path.join(appDir, 'config.yaml'), 'port: 4444\n');
        fs.writeFileSync(path.join(appDir, 'public', 'index.html'), '<!doctype html>\n');
        fs.writeFileSync(path.join(appDir, 'node_modules', '.sillybunny-dependencies.json'), '{"version":1,"profiles":{}}\n');

        fs.writeFileSync(
            path.join(appDir, 'scripts', 'dependency-state.js'),
            'import fs from "node:fs"; fs.appendFileSync("boot-calls.log", `dep:${process.argv.slice(2).join(",")}\\n`);\n',
        );
        fs.writeFileSync(
            path.join(appDir, 'src', 'server-init.js'),
            'import fs from "node:fs"; fs.appendFileSync("boot-calls.log", "init\\n");\n',
        );
        fs.writeFileSync(
            path.join(appDir, 'server.js'),
            [
                'import fs from "node:fs";',
                'const marker = "restarted.once";',
                'if (!fs.existsSync(marker)) {',
                '    fs.writeFileSync(marker, "1");',
                '    fs.appendFileSync("boot-calls.log", "server:75\\n");',
                '    process.exit(75);',
                '}',
                'fs.appendFileSync("boot-calls.log", `server:0:skipBrowser=${process.env.SILLYBUNNY_SKIP_BROWSER_AUTO_LAUNCH || ""}\\n`);',
                '',
            ].join('\n'),
        );

        git(suiteRoot, 'init', '--quiet', '--initial-branch=release', appDir);
        git(appDir, 'add', 'package.json', 'package-lock.json', 'default/config.yaml');
        git(appDir, 'commit', '--quiet', '-m', 'posix fixture');

        const runStartSh = () => spawnSync(
            bashExecutable,
            [toPosixShellPath(bashExecutable, path.join(appDir, 'start.sh')), '--skip-self-update'],
            {
                cwd: appDir,
                env: makeGitEnv({ SILLYBUNNY_USE_NODE: '1' }),
                encoding: 'utf8',
                windowsHide: true,
            },
        );

        const coldBoot = runStartSh();
        expect(coldBoot.status).toBe(0);
        expect(coldBoot.stdout).toContain('Entering SillyBunny...');
        expect(coldBoot.stdout).toContain('Restarting SillyBunny...');
        expect(fs.readFileSync(path.join(appDir, 'boot-calls.log'), 'utf8').trim().split('\n')).toEqual([
            'dep:check,node-production',
            'init',
            'server:75',
            'server:0:skipBrowser=1',
        ]);

        fs.writeFileSync(path.join(appDir, 'boot-calls.log'), '');
        const warmBoot = runStartSh();
        expect(warmBoot.status).toBe(0);
        expect(warmBoot.stdout).toContain('Dependencies are up to date.');
        expect(fs.readFileSync(path.join(appDir, 'boot-calls.log'), 'utf8').trim().split('\n')).toEqual([
            'server:0:skipBrowser=',
        ]);
    });
});
