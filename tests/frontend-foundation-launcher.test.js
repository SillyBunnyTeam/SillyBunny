import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const launcherUrl = new URL('../scripts/lib/npm-launcher.js', import.meta.url);
const temporaryRoots = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('sb foundation & launcher ')) {
            throw new Error('Unexpected launcher test directory.');
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function createWorkingDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb foundation & launcher '));
    temporaryRoots.push(directory);
    return directory;
}

function launchNpm(args, { cwd = createWorkingDirectory(), env = process.env, runtime = process.execPath } = {}) {
    const script = `import { runNpm } from ${JSON.stringify(launcherUrl.href)}; runNpm(${JSON.stringify(args)}, { cwd: process.cwd() });`;
    return spawnSync(runtime, ['--input-type=module', '--eval', script], {
        cwd,
        env: { ...env, npm_config_cache: path.join(cwd, 'npm cache'), npm_config_update_notifier: 'false' },
        encoding: 'utf8',
    });
}

// npm or Bun may print a warning line on stderr without failing the launcher; only an EINVAL or Error marker counts as a failure.
function expectLauncherSuccess(result) {
    expect({ status: result.status, stderr: result.stderr }).toEqual({
        status: 0,
        stderr: expect.not.stringMatching(/EINVAL|Error/),
    });
}

describe('frontend foundation npm launcher', () => {
    test('runs npm from a working directory containing spaces', () => {
        const result = launchNpm(['--version']);

        expectLauncherSuccess(result);
        expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
    });

    const describeWithBun = spawnSync('bun', ['--version']).status === 0 ? describe : describe.skip;
    describeWithBun('Bun runtime', () => {
        test('runs npm when Bun starts the launcher', () => {
            const result = launchNpm(['--version'], { runtime: 'bun' });

            expectLauncherSuccess(result);
            expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
        });
    });

    test('finds npm when the check was not started by npm', () => {
        const env = { ...process.env };
        delete env.npm_execpath;

        const result = launchNpm(['--version'], { env });

        expectLauncherSuccess(result);
        expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
    });

    test('passes paths with spaces and shell characters as one npm argument', () => {
        const cwd = createWorkingDirectory();
        const result = launchNpm(['--prefix', cwd, 'prefix'], { cwd });

        expectLauncherSuccess(result);
        expect(path.resolve(result.stdout.trim())).toBe(cwd);
    });

    test('fails when an npm check fails', () => {
        const cwd = createWorkingDirectory();
        fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ private: true, scripts: {} }));

        const result = launchNpm(['run', 'missing-foundation-check'], { cwd });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Missing script: "missing-foundation-check"');
        expect(result.stderr).toContain('exited with status 1');
    });
});
