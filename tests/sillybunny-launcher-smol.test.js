import { describe, test, expect, afterAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startShSource = readFileSync(path.join(repoRoot, 'start.sh'), 'utf8');
const startBatSource = readFileSync(path.join(repoRoot, 'Start.bat'), 'utf8');
const startNodeBatSource = readFileSync(path.join(repoRoot, 'Start-Node.bat'), 'utf8');
const dockerEntrypointSource = readFileSync(path.join(repoRoot, 'docker', 'docker-entrypoint.sh'), 'utf8');
const prMetadataSource = readFileSync(path.join(repoRoot, '.github', 'workflows', 'pr-metadata.yml'), 'utf8');
const serverGlobalSource = readFileSync(path.join(repoRoot, 'src', 'server-global.js'), 'utf8');
const serverSource = readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

/**
 * Lifts a top-level shell function out of start.sh so it can be exercised in
 * isolation. Sourcing start.sh directly is not an option: it would run the
 * dependency install and git auto-update on the way past.
 *
 * Terminates on the first closing brace at column 0, which matches how every
 * function in start.sh is written. A mis-extraction fails the behavioural
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

const harnessDir = mkdtempSync(path.join(tmpdir(), 'sb-launcher-smol-'));
const harnessPath = path.join(harnessDir, 'harness.sh');

// The harness mirrors start.sh's own `set -euo pipefail` so run_server is
// exercised under the same strictness it runs under in production.
writeFileSync(harnessPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    extractShellFunction(startShSource, 'is_truthy'),
    extractShellFunction(startShSource, 'run_server'),
    'runtime_kind="$TEST_RUNTIME_KIND"',
    'RUNTIME_CMD=echo',
    'run_server "$@"',
    '',
].join('\n\n'));

afterAll(() => {
    rmSync(harnessDir, { recursive: true, force: true });
});

/**
 * Whether `bash` on PATH can actually run a script living in the temp dir. On
 * Windows `bash` resolves to the WSL app-execution alias ahead of Git Bash, and
 * that alias either has no distribution installed or cannot see the Windows temp
 * path — so probe the exact mechanism these tests use rather than inferring
 * capability from process.platform.
 */
function hasUsableBash() {
    const probePath = path.join(harnessDir, 'probe.sh');
    writeFileSync(probePath, '#!/usr/bin/env bash\nset -euo pipefail\necho ok\n');

    try {
        const stdout = execFileSync('bash', [probePath], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return stdout.trim() === 'ok';
    } catch {
        return false;
    }
}

// CI runs unit tests on ubuntu-latest, so this only spares Windows contributors
// a wall of failures that say nothing about start.sh. The source-level parity
// checks below still run everywhere.
const describeShell = hasUsableBash() ? describe : describe.skip;

/** Runs run_server with a stubbed runtime; returns the argv it would have used. */
function runServer({ runtimeKind = 'bun', smol, args = [] } = {}) {
    const env = { ...process.env, TEST_RUNTIME_KIND: runtimeKind };
    if (smol === undefined) {
        delete env.SILLYBUNNY_BUN_SMOL;
    } else {
        env.SILLYBUNNY_BUN_SMOL = smol;
    }
    return execFileSync('bash', [harnessPath, ...args], { env, encoding: 'utf8' }).trim();
}

describeShell('start.sh run_server --smol gating', () => {
    test('omits --smol by default', () => {
        expect(runServer()).toBe('server.js');
    });

    test('adds --smol when SILLYBUNNY_BUN_SMOL is truthy', () => {
        for (const value of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
            expect(runServer({ smol: value })).toBe('--smol server.js');
        }
    });

    test('omits --smol for falsy and unrecognised values', () => {
        for (const value of ['', '0', 'false', 'no', 'off', 'maybe']) {
            expect(runServer({ smol: value })).toBe('server.js');
        }
    });

    test('ignores the flag on the Node runtime, where --smol does not exist', () => {
        expect(runServer({ runtimeKind: 'node', smol: '1' })).toBe('--no-warnings server.js');
    });

    test('keeps forwarding caller arguments after the flag', () => {
        expect(runServer({ smol: '1', args: ['--port', '8000'] }))
            .toBe('--smol server.js --port 8000');
        expect(runServer({ args: ['--port', '8000'] }))
            .toBe('server.js --port 8000');
    });
});

// Neither Start.bat nor the Docker entrypoint can be executed on the CI runners,
// and start.sh's Node-mode warning lives in top-level code the harness cannot
// reach. Assert those branches are wired instead: without this, a launcher
// silently drops the flag.
describe('launcher parity', () => {
    test('start.sh warns when the flag is set but Node.js was selected', () => {
        expect(startShSource).toMatch(/is_truthy "\$\{SILLYBUNNY_BUN_SMOL:-\}" && \[\[ "\$runtime_kind" == node \]\]/);
    });

    test('Start.bat accepts the same spellings as is_truthy', () => {
        for (const value of ['1', 'true', 'yes', 'on']) {
            expect(startBatSource).toMatch(
                new RegExp(`if\\s+/I\\s+"!SILLYBUNNY_BUN_SMOL!"=="${value}"\\s+set "_bun_smol=1"`),
            );
        }
    });

    test('Start.bat gates a --smol branch on the normalised flag', () => {
        expect(startBatSource).toMatch(/else if "!_bun_smol!"=="1"/);
        expect(startBatSource).toMatch(/bun --smol server\.js %\*/);
    });

    test('Start.bat still has the plain bun and node launch branches', () => {
        expect(startBatSource).toMatch(/bun server\.js %\*/);
        expect(startBatSource).toMatch(/node --no-warnings server\.js %\*/);
    });

    test('Start.bat warns when the flag is set but Node.js was selected', () => {
        expect(startBatSource).toMatch(/if "!_bun_smol!"=="1" if "!_server_runtime!"=="node"/);
    });

    test('Start.bat accepts the shared Node and Bun runtime overrides', () => {
        for (const value of ['1', 'true', 'yes', 'on']) {
            expect(startBatSource).toMatch(
                new RegExp(`if\\s+/I\\s+"!SILLYBUNNY_USE_NODE!"=="${value}"\\s+set "_force_node=1"`),
            );
            expect(startBatSource).toMatch(
                new RegExp(`if\\s+/I\\s+"!SILLYBUNNY_USE_BUN!"=="${value}"\\s+set "_force_bun=1"`),
            );
        }
    });

    test('Start.bat selects runtime before installing matching dependencies', () => {
        const runtimeSelection = startBatSource.indexOf('set "_server_runtime=bun"');
        const dependencyProfile = startBatSource.indexOf('set "_dependency_profile=!_server_runtime!-production"');

        expect(runtimeSelection).toBeGreaterThanOrEqual(0);
        expect(dependencyProfile).toBeGreaterThan(runtimeSelection);
        expect(startBatSource).toMatch(/if "!_force_node!"=="1" set "_server_runtime=node"/);
        expect(startBatSource).toMatch(/if "!_force_node!"=="0" if "!_force_bun!"=="0" if "!_is_arm64!"=="1"/);
        expect(startBatSource).toMatch(/node scripts\\dependency-state\.js check !_dependency_profile!/);
        expect(startBatSource).toMatch(/call npm ci --no-audit --no-fund --omit=dev --loglevel=error/);
        expect(startBatSource).toMatch(/call bun install !_bun_install_args!/);
        expect(startBatSource).toMatch(/call npm run init/);
        expect(startBatSource).toMatch(/call bun run init/);
    });

    test('Start-Node initializes before entering its restart loop', () => {
        const initIndex = startNodeBatSource.indexOf('call npm run init');
        const serverIndex = startNodeBatSource.indexOf('node --no-warnings server.js %*');

        expect(initIndex).toBeGreaterThanOrEqual(0);
        expect(serverIndex).toBeGreaterThan(initIndex);
        expect(startNodeBatSource).toMatch(/node scripts\\dependency-state\.js check !_dependency_profile!/);
        expect(startNodeBatSource).toMatch(/call npm ci --no-audit --no-fund --omit=dev --loglevel=error/);
        expect(startNodeBatSource).toMatch(/if "!_server_exit!"=="75"/);
    });

    test('the Docker entrypoint gates --smol on the same accepted values', () => {
        expect(dockerEntrypointSource).toMatch(/^\s*1\|true\|yes\|on\)/m);
        expect(startShSource).toMatch(/^\s*1\|true\|yes\|on\)/m);
        expect(dockerEntrypointSource).toMatch(/is_truthy "\$\{SILLYBUNNY_BUN_SMOL:-\}"/);
        expect(dockerEntrypointSource).toMatch(/exec \$PREFIX bun --smol server\.js --listen "\$@"/);
    });

    test('the Docker entrypoint keeps its plain launch path', () => {
        expect(dockerEntrypointSource).toMatch(/exec \$PREFIX bun server\.js --listen "\$@"/);
    });

    test('the Docker mount guard matches the Bun image app root', () => {
        expect(dockerEntrypointSource).toContain('app_path="/home/bun/app"');
        expect(dockerEntrypointSource).toContain('[ "$PARENT_DIR" != "/home/bun/app" ]');
        expect(dockerEntrypointSource).not.toContain('/home/node/app');
    });

    test('global package bins use Node while the default launch remains Bun-first', () => {
        expect(packageJson.bin).toEqual({
            sillybunny: './src/server-global.js',
            sillytavern: './src/server-global.js',
        });
        expect(serverGlobalSource.startsWith('#!/usr/bin/env node')).toBe(true);
        expect(serverSource.startsWith('#!/usr/bin/env bun')).toBe(true);
        expect(packageJson.scripts.start).toBe('bun server.js');
        expect(packageJson.scripts['start:node']).toBe('node --no-warnings server.js');
    });

    test('declares the supported Node engine and focused Node counterparts', () => {
        expect(packageJson.engines).toEqual({
            bun: '>= 1.3.0',
            node: '>= 20',
        });
        expect(packageJson.scripts['debug:node']).toBe('node --inspect server.js');
        expect(packageJson.scripts['start:global:node']).toBe('node --no-warnings server.js --global');
        expect(packageJson.scripts['start:no-csrf:node']).toBe('node --no-warnings server.js --disableCsrf');
    });

    test('PR metadata keeps ordinary work on staging and permits staging releases to main', () => {
        expect(prMetadataSource).toContain('[ "$BASE_REF" = "staging" ]');
        expect(prMetadataSource).toContain('[ "$BASE_REF" = "main" ] && [ "$HEAD_REF" = "staging" ] && [ "$HEAD_REPOSITORY" = "$REPOSITORY" ]');
        expect(prMetadataSource).toContain('HEAD_REPOSITORY: ${{ github.event.pull_request.head.repo.full_name }}');
        expect(prMetadataSource).toContain('Only the staging release branch may target main.');
        expect(prMetadataSource).toContain('Pull requests must target staging.');
        expect(prMetadataSource).not.toContain('TLD/mobile-refactor');
    });
});
