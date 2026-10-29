import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, runNpm } from './lib/npm-launcher.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(repoRoot, 'tests');
const webkitImage = process.env.SB_FOUNDATION_WEBKIT_IMAGE || 'mcr.microsoft.com/playwright:v1.60.0-noble';

function hasCommand(command, args = ['--version']) {
    return spawnSync(command, args, { cwd: repoRoot, stdio: 'ignore' }).status === 0;
}

function runChromium(runtime) {
    const args = runtime === 'bun'
        ? [
            'node_modules/@playwright/test/cli.js',
            'test',
            '--config',
            'playwright.foundation.config.js',
            '--project=chromium-*',
        ]
        : ['run', 'test:foundation', '--', '--project=chromium-*'];

    const options = {
        cwd: testsRoot,
        env: { ...process.env, SB_UI_TEST_RUNTIME: runtime, SB_UI_ARTIFACTS: `test-results/foundation-gate-${runtime}` },
    };
    if (runtime === 'bun') {
        run('bun', args, options);
    } else {
        runNpm(args, options);
    }
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
    ], { cwd: repoRoot });
}

function runGate() {
    runNpm(['run', 'check:frontend-contracts'], { cwd: repoRoot });
    runNpm(['run', 'lint'], { cwd: repoRoot });
    runNpm(['run', 'check:frontend-budgets'], { cwd: repoRoot });
    runNpm(['--prefix', 'tests', 'run', 'test:unit', '--', '--runInBand'], { cwd: repoRoot });
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
