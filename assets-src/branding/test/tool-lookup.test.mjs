import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectTools } from '../scripts/lib/notice.mjs';
import { findPotrace } from '../scripts/lib/potrace.mjs';
import { findTool, toolCandidates } from '../scripts/lib/tool-lookup.mjs';
import { findVtracer } from '../scripts/lib/vectorize-run.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const RUNTIMES = { sharp: '0', node: 'v0' };
// What the notice generator does to run a tool, with the PATH of the environment under test so a tool installed on this machine cannot leak in.
const runIn = (env) => (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], env });

/** A folder standing in for a home folder, and a program that answers --version like the real tool. */
function fakeTool(name, version) {
    const home = tempDir('sb-tool-');
    const program = (directory) => {
        mkdirSync(directory, { recursive: true });
        const path = join(directory, name);
        writeFileSync(path, `#!/bin/sh\necho "${name} ${version}"\n`);
        chmodSync(path, 0o755);
        return path;
    };
    return { home, program };
}

const rowOf = (tools, label) => tools.find((tool) => tool.label === label).version;

test('the candidates are the environment variable, then the tool\'s install folder under home, then the PATH', () => {
    assert.deepEqual(toolCandidates('vtracer', { HOME: '/home/x', VTRACER: '/opt/vtracer' }), ['/opt/vtracer', '/home/x/.cargo/bin/vtracer', 'vtracer']);
    assert.deepEqual(toolCandidates('vtracer', { HOME: '/home/x' }), ['/home/x/.cargo/bin/vtracer', 'vtracer']);
    assert.deepEqual(toolCandidates('potrace', { HOME: '/home/x', POTRACE: '/opt/potrace' }), ['/opt/potrace', 'potrace']);
    assert.deepEqual(toolCandidates('python3', { HOME: '/home/x', PYTHON3: '/ignored' }), ['python3'], 'a tool no script looks for elsewhere is on the PATH only');
});

test('vtracer reached through $VTRACER is found by the scripts and shown with its version in the notice', () => {
    const { home, program } = fakeTool('vtracer', '1.2.3');
    const elsewhere = program(join(home, 'opt'));
    const env = { HOME: join(home, 'nothing-here'), PATH: '', VTRACER: elsewhere };
    assert.equal(findTool('vtracer', env), elsewhere);
    assert.equal(findVtracer(env), elsewhere);
    assert.equal(rowOf(detectTools(runIn(env), RUNTIMES, env), 'vtracer'), '1.2.3');
});

test('vtracer reached through the cargo directory, which is not on the PATH, is found by the scripts and shown in the notice', () => {
    const { home, program } = fakeTool('vtracer', '0.6.4');
    const installed = program(join(home, '.cargo', 'bin'));
    const env = { HOME: home, PATH: '' };
    assert.equal(findVtracer(env), installed);
    assert.equal(rowOf(detectTools(runIn(env), RUNTIMES, env), 'vtracer'), '0.6.4');
});

test('a vtracer that is nowhere is refused by the scripts with their message and shown as not installed in the notice', () => {
    const env = { HOME: tempDir('sb-tool-'), PATH: '' };
    assert.equal(findTool('vtracer', env), undefined);
    assert.throws(() => findVtracer(env), /vtracer was not found\. Install it with `cargo install vtracer` or set VTRACER/);
    assert.equal(rowOf(detectTools(runIn(env), RUNTIMES, env), 'vtracer'), 'not installed');
});

test('a $VTRACER that does not run is skipped for the next candidate, in the scripts and in the notice alike', () => {
    const { home, program } = fakeTool('vtracer', '0.6.4');
    const installed = program(join(home, '.cargo', 'bin'));
    const env = { HOME: home, PATH: '', VTRACER: join(home, 'missing', 'vtracer') };
    assert.equal(findVtracer(env), installed);
    assert.equal(rowOf(detectTools(runIn(env), RUNTIMES, env), 'vtracer'), '0.6.4');
});

test('potrace reached through $POTRACE is found by the scripts and shown in the notice, and a missing one is not installed', () => {
    const { home, program } = fakeTool('potrace', '1.16.');
    const path = program(join(home, 'opt'));
    const env = { HOME: home, PATH: '', POTRACE: path };
    assert.equal(findPotrace(env), path);
    assert.equal(rowOf(detectTools(runIn(env), RUNTIMES, env), 'potrace'), '1.16');
    const none = { HOME: home, PATH: '' };
    assert.throws(() => findPotrace(none), /potrace was not found/);
    assert.equal(rowOf(detectTools(runIn(none), RUNTIMES, none), 'potrace'), 'not installed');
});

test('the notice tries the same commands in the same order as the scripts', () => {
    const tried = [];
    detectTools((command) => {
        tried.push(command);
        throw new Error('ENOENT');
    }, RUNTIMES, { HOME: '/home/x', VTRACER: '/opt/vtracer', POTRACE: '/opt/potrace' });
    assert.deepEqual(tried.filter((command) => /vtracer|potrace/.test(command)), [...toolCandidates('potrace', { HOME: '/home/x', POTRACE: '/opt/potrace' }), ...toolCandidates('vtracer', { HOME: '/home/x', VTRACER: '/opt/vtracer' })]);
});
