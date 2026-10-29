import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(repoRoot, 'tests');
const webkitImage = process.env.SB_FOUNDATION_WEBKIT_IMAGE || 'mcr.microsoft.com/playwright:v1.60.0-noble';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function hasCommand(command, args = ['--version']) {
    return spawnSync(command, args, { cwd: repoRoot, stdio: 'ignore' }).status === 0;
}

function run(command, args, { cwd = repoRoot, env = process.env } = {}) {
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

function runChromium(runtime) {
    const command = runtime === 'bun' ? 'bun' : npmCommand;
    const args = runtime === 'bun'
        ? [
            'node_modules/@playwright/test/cli.js',
            'test',
            '--config',
            'playwright.foundation.config.js',
            '--project=chromium-*',
        ]
        : ['run', 'test:foundation', '--', '--project=chromium-*'];

    run(command, args, {
        cwd: testsRoot,
        env: { ...process.env, SB_UI_TEST_RUNTIME: runtime, SB_UI_ARTIFACTS: `test-results/foundation-gate-${runtime}` },
    });
}

function runWebKit() {
    if (!hasCommand('podman', ['--version'])) {
        throw new Error('WebKit foundation verification requires Podman or an explicitly managed browser runner.');
    }

    if (spawnSync('podman', ['image', 'exists', webkitImage], { cwd: repoRoot, stdio: 'ignore' }).status !== 0) {
        throw new Error(`WebKit foundation image is unavailable: ${webkitImage}`);
    }

    run('podman', [
        'run', '--rm', '--network=host', '--userns=keep-id',
        '-e', 'CI=1',
        '-e', 'SB_UI_TEST_RUNTIME=node',
        '-e', 'SB_UI_ARTIFACTS=test-results/foundation-gate-webkit',
        '-v', `${repoRoot}:/work:Z`,
        '-w', '/work/tests',
        webkitImage,
        'node_modules/.bin/playwright', 'test',
        '--config', 'playwright.foundation.config.js',
        '--project=webkit-*',
    ]);
}

function runGate() {
    run(npmCommand, ['run', 'check:frontend-contracts']);
    run(npmCommand, ['run', 'lint']);
    run(npmCommand, ['run', 'check:frontend-budgets']);
    run(npmCommand, ['--prefix', 'tests', 'run', 'test:unit', '--', '--runInBand']);
    runChromium('node');

    if (!hasCommand('bun')) {
        throw new Error('Bun is required for the runtime parity foundation check.');
    }

    runChromium('bun');
    runWebKit();
}

try {
    if (!fs.existsSync(path.join(testsRoot, 'node_modules'))) {
        throw new Error('tests/node_modules is missing; install test dependencies before running the foundation gate.');
    }

    runGate();
    console.log('Frontend foundation verification passed for static contracts, unit tests, Node, Bun, Chromium, WebKit, and frontend budgets.');
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
