import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsePatchRequest } from '../scripts/lib/cli.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

function makeRoot(spec = '[{"crop":[0,0,10,10]}]') {
    const root = tempDir('sb-patchcli-');
    writeFileSync(join(root, 'page.png'), 'x');
    writeFileSync(join(root, 'patches.json'), spec);
    return root;
}

test('patch options are parsed with the documented defaults', () => {
    const root = makeRoot();
    const request = parsePatchRequest(['--image', 'page.png', '--spec', 'patches.json', '--out', 'raw/s2/fix'], root);
    assert.equal(request.imagePath, join(root, 'page.png'));
    assert.deepEqual(request.patches, [{ crop: [0, 0, 10, 10] }]);
    assert.deepEqual([request.n, request.feather, request.stage, request.outDir], [1, 6, 'fix', 'raw/s2/fix']);
    assert.deepEqual([request.dryRun, request.yes, request.balance, request.allowUnlocked], [false, false, false, false]);
    assert.equal(request.instruction, undefined);
});

test('instruction, count, feather, stage and the run flags are read', () => {
    const root = makeRoot();
    const request = parsePatchRequest(['--image', 'page.png', '--spec', 'patches.json', '--instruction', 'Remove the human ears.', '--n', '2', '--feather', '0', '--stage', 's2', '--out', 'raw/s2/', '--dry-run', '--yes', '--balance', '--model', 'gpt-image-2.5-flare-h', '--allow-unlocked'], root);
    assert.deepEqual([request.instruction, request.n, request.feather, request.stage], ['Remove the human ears.', 2, 0, 's2']);
    assert.deepEqual([request.dryRun, request.yes, request.balance, request.allowUnlocked, request.model], [true, true, true, true, 'gpt-image-2.5-flare-h']);
});

test('missing or bad input fails before anything is read or sent', () => {
    const root = makeRoot();
    const base = ['--image', 'page.png', '--spec', 'patches.json', '--out', 'raw/s2/'];
    assert.throws(() => parsePatchRequest(['--spec', 'patches.json', '--out', 'raw/s2/'], root), /--image/);
    assert.throws(() => parsePatchRequest(['--image', 'page.png', '--out', 'raw/s2/'], root), /--spec/);
    assert.throws(() => parsePatchRequest(['--image', 'page.png', '--spec', 'patches.json'], root), /--out/);
    assert.throws(() => parsePatchRequest([...base, '--n', '0'], root), /--n/);
    assert.throws(() => parsePatchRequest([...base, '--feather', '-1'], root), /--feather/);
    assert.throws(() => parsePatchRequest([...base, '--feather', '2.5'], root), /--feather/);
    assert.throws(() => parsePatchRequest([...base, '--bogus'], root));
    const broken = makeRoot('[{"crop":');
    assert.throws(() => parsePatchRequest(['--image', 'page.png', '--spec', 'patches.json', '--out', 'raw/s2/'], broken), /patches\.json is not valid JSON/);
});

test('--reuse is read as given, and the variant count is left to the reused run', () => {
    const root = makeRoot();
    const base = ['--image', 'page.png', '--spec', 'patches.json', '--out', 'raw/s5/fix/'];
    const request = parsePatchRequest([...base, '--reuse', 'raw/s5/tails/x/20261101T125043Z-gpt-image-2.5-sunburst-h-patch', '--feather', '2'], root);
    assert.deepEqual([request.reuse, request.feather], ['raw/s5/tails/x/20261101T125043Z-gpt-image-2.5-sunburst-h-patch', 2]);
    assert.equal(parsePatchRequest(base, root).reuse, undefined);
});

test('--reuse refuses the flags that only steer a model call', () => {
    const root = makeRoot();
    const base = ['--image', 'page.png', '--spec', 'patches.json', '--out', 'raw/s5/fix/', '--reuse', 'raw/s5/x-patch'];
    for (const extra of [['--n', '2'], ['--model', 'gpt-image-2.5-flare-h'], ['--instruction', 'x'], ['--balance'], ['--allow-unlocked']]) {
        assert.throws(() => parsePatchRequest([...base, ...extra], root), new RegExp(`--reuse makes no model call, so ${extra[0]} has no effect`));
    }
});

test('--keep-alpha is off unless given, and is allowed with --reuse', () => {
    const root = makeRoot();
    const base = ['--image', 'page.png', '--spec', 'patches.json', '--out', 'raw/s5/fix/'];
    assert.equal(parsePatchRequest(base, root).keepAlpha, false);
    assert.equal(parsePatchRequest([...base, '--keep-alpha'], root).keepAlpha, true);
    const reused = parsePatchRequest([...base, '--keep-alpha', '--reuse', 'raw/s5/x-patch'], root);
    assert.deepEqual([reused.keepAlpha, reused.reuse], [true, 'raw/s5/x-patch']);
});
