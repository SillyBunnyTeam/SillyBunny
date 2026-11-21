import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../test-support/temp-dir.mjs';

const REAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = ['github-assets.mjs', 'github-snap.mjs', 'github-backdrop.mjs', 'github-contacts.mjs', 'github-config-emit.mjs'];
const run = (script, ...args) => spawnSync(process.execPath, [join(REAL_ROOT, 'scripts', script), ...args], { encoding: 'utf8' });
/** A path that leads out of out/ by way of "..", which has to be checked as the place it leads to. */
const escapeFrom = (target) => `${REAL_ROOT}/out/${relative(join(REAL_ROOT, 'out'), target)}`;

for (const script of SCRIPTS) {
    test(`${script} --help prints its usage on stdout, says nothing on stderr and exits 0`, () => {
        const { status, stdout, stderr } = run(script, '--help');
        assert.equal(status, 0);
        assert.equal(stderr, '');
        assert.match(stdout, /^Usage: /);
    });
}

test('the two snap scripts say in their usage that --stage logs, and refuse a --stage that is not a plain name before they snap anything', () => {
    for (const script of ['github-snap.mjs', 'github-backdrop.mjs']) {
        assert.match(run(script, '--help').stdout, /\[--stage s8\]\n {2}Without --stage this is a preview: it writes under out\/ and logs nothing\./, script);
        // The stage is checked first. The package is an empty folder of the test's own, so that a run which got past the check could not reach the real masters, out/ or log.
        const { status, stdout, stderr } = run(script, '--root', tempDir('sb-github-cli-'), '--stage', '../x');
        assert.equal(status, 1, script);
        assert.equal(stdout, '', script);
        assert.match(stderr, /The stage "\.\.\/x" may hold letters, digits, "_" and "-" only/, script);
        assert.doesNotMatch(stderr, /\n\s+at /, `${script}: a message and not a stack`);
    }
});

test('an unknown option is a message on stderr and exit 1, never a stack', () => {
    for (const script of SCRIPTS) {
        const { status, stderr, stdout } = run(script, '--no-such-option');
        assert.equal(status, 1, script);
        assert.equal(stdout, '', script);
        assert.match(stderr, /Unknown option/, script);
        assert.doesNotMatch(stderr, /\n\s+at /, `${script}: a message and not a stack`);
    }
});

test('the contacts script refuses a number of rows or a zoom that is not a whole number of 1 or more, and an art name it does not know, with a message and exit 1', () => {
    for (const [flag, value] of [['--rows', '0'], ['--rows', 'many'], ['--rows', '1.5'], ['--zoom', '0'], ['--zoom', '-2'], ['--zoom', '']]) {
        const { status, stderr } = run('github-contacts.mjs', `${flag}=${value}`);
        assert.equal(status, 1, `${flag} ${value}`);
        assert.match(stderr, new RegExp(`${flag} must be a whole number of 1 or more, got "${value}"`));
        assert.doesNotMatch(stderr, /\n\s+at /);
    }
    const unknown = run('github-contacts.mjs', '--scene', 'banner-nowhere');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /"banner-nowhere" is not an art source\. The art sources are: banner-main/);
});

// These runs never pass --write: a test of a script against this package must not be able to append to its log or fill its out/ folder, so
// the write run with an escaping --out-dir is tried on a temporary package, in github-assets.test.mjs.
test('an --out-dir that leads out of out/ by way of ".." is refused by the scripts that take one, and nothing is made where it leads', () => {
    const target = join(tmpdir(), `sb-github-escape-${process.pid}`);
    for (const script of ['github-assets.mjs', 'github-contacts.mjs']) {
        const { status, stderr } = run(script, '--out-dir', escapeFrom(target));
        assert.equal(status, 1, script);
        assert.match(stderr, /--out-dir must be inside out\//, script);
        assert.equal(existsSync(target), false, `${script} made nothing at ${target}`);
    }
});
