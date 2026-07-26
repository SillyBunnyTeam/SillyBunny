import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startShSource = readFileSync(path.join(repoRoot, 'start.sh'), 'utf8');
const startBatSource = readFileSync(path.join(repoRoot, 'Start.bat'), 'utf8');

/**
 * Lifts a top-level shell function out of start.sh so it can be exercised in
 * isolation. Sourcing start.sh directly is not an option: it would run the
 * dependency install and git auto-update on the way past.
 */
function extractShellFunction(source, name) {
    const lines = source.split('\n');
    const start = lines.findIndex(line => line.startsWith(`${name}() {`));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    expect(end).toBeGreaterThan(start);
    return lines.slice(start, end + 1).join('\n');
}

let harnessDir;
let harnessPath;

beforeAll(() => {
    harnessDir = mkdtempSync(path.join(tmpdir(), 'sb-launcher-smol-'));
    harnessPath = path.join(harnessDir, 'harness.sh');
    // Mirrors start.sh's own `set -euo pipefail` so that an unguarded empty
    // array expansion would fail the test rather than pass silently.
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
});

afterAll(() => {
    rmSync(harnessDir, { recursive: true, force: true });
});

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

describe('start.sh run_server --smol gating', () => {
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

describe('Start.bat parity', () => {
    // Start.bat cannot be executed on the CI runners, so assert the branch is
    // wired. Without this, the Windows launcher silently loses the flag.
    test('gates a --smol branch behind SILLYBUNNY_BUN_SMOL', () => {
        expect(startBatSource).toMatch(/if\s+\/I\s+"!SILLYBUNNY_BUN_SMOL!"=="1"/);
        expect(startBatSource).toMatch(/bun --smol server\.js %\*/);
    });

    test('still has the plain bun and node launch branches', () => {
        expect(startBatSource).toMatch(/bun server\.js %\*/);
        expect(startBatSource).toMatch(/node --no-warnings server\.js %\*/);
    });
});
