import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'masters.mjs');
const run = (args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '', GEMINI_API_KEY: '' } });

test('a dry run prints the table, the totals for one and two images, the cap check and the prompts asked for, and sends nothing', () => {
    const { stdout, status } = run(['--dry-run', '--prompt', 'empty-tewi']);
    assert.equal(status, 0);
    assert.match(stdout, /id\s+size\s+aspect\s+refs\s+cost/);
    assert.match(stdout, /hero-duo-night\s+2048x1024\s+2:1\s+5: 2 sheets, line-up, 2 sprites\s+\$0\.20/);
    assert.match(stdout, /1 image per slot: 17 x \$0\.20 = \$3\.40/);
    assert.match(stdout, /2 images per slot: 34 x \$0\.20 = \$6\.80/);
    assert.match(stdout, /cap \$20\.00/);
    assert.match(stdout, /--- prompt: empty-tewi ---\nPixel art style/);
    assert.ok(!/--- prompt: hero-duo ---/.test(stdout));
    assert.match(stdout, /dry run: nothing was sent, saved or logged\./);
});

test('--only limits the table and --prompt all prints every prompt', () => {
    const only = run(['--dry-run', '--only', 'hero-duo,empty-tewi']);
    assert.equal((only.stdout.match(/\$0\.20$/gm) ?? []).length, 2);
    assert.match(only.stdout, /1 image per slot: 2 x \$0\.20 = \$0\.40/);
    const all = run(['--dry-run', '--only', 'hero-duo,empty-tewi', '--prompt', 'all']);
    assert.equal((all.stdout.match(/^--- prompt: /gm) ?? []).length, 2);
});

// A real run is not started from here: a developer's .env could hold a key, and the run would spend money.
test('an unknown slot and a prompt for a slot that was not run are reported before anything is sent', () => {
    assert.match(run(['--dry-run', '--only', 'row-nahida']).stderr, /row-nahida/);
    assert.match(run(['--dry-run', '--only', 'hero-duo', '--prompt', 'empty-tewi']).stderr, /empty-tewi/);
});
