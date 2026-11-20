import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runBump, runCheck } from '../lib/commands.js';
import { nextKey, stampOf } from '../lib/keys.js';
import { readManifest } from '../lib/manifest.js';
import { REPO_ROOT } from '../test-support/pictures.js';
import { copyOfArt, writeFixtureManifest } from '../test-support/repos.js';

const HOME_KEY_FILE = 'public/scripts/sillybunny-home/art-sources.js';
const codes = (run) => run.result.problems.map(({ code }) => code);

/** A copy of the checkout whose manifest records another sha256 for one output, as derive --write does after a change. */
function copyWithChangedOutput(t, change) {
    const root = copyOfArt(t);
    const { manifest } = readManifest(root);
    change(manifest.assets);
    writeFixtureManifest(root, manifest);
    return { root, before: manifest };
}

test('the next key is the next letter on the same day and `a` on a later day, and never goes back', () => {
    assert.equal(nextKey('20261105a', '20261105'), '20261105b');
    assert.equal(nextKey('20261105c', '20261114'), '20261114a');
    assert.equal(nextKey('20261120b', '20261114'), '20261120c');
    assert.throws(() => nextKey('20261105z', '20261105'), /last key of its day/);
});

test('the keys of the checkout are current, because no file changed since its key did', async () => {
    const run = await runBump({ root: REPO_ROOT });

    assert.deepEqual([run.result.bumps, run.result.problems], [[], []]);
});

test('a changed Home file gives Home a new key, records it with a new stamp, and leaves the splash keys alone', async (t) => {
    const { root, before } = copyWithChangedOutput(t, (assets) => {
        assets['gs-reisen'].outputs[0].sha256 = '0'.repeat(64);
    });
    assert.ok(codes(await runCheck({ root })).includes('key-stale'));

    const dry = await runBump({ root, today: '2026-11-14' });
    assert.deepEqual(dry.result.bumps, [{ group: 'home', field: 'value', file: HOME_KEY_FILE, from: '20261105a', to: '20261114a' }]);

    const run = await runBump({ root, today: '2026-11-14', write: true });
    assert.deepEqual(run.result.written, [HOME_KEY_FILE]);
    assert.match(readFileSync(join(root, HOME_KEY_FILE), 'utf8'), /export const ART_VERSION = '20261114a';/);
    const { manifest } = readManifest(root);
    assert.deepEqual([manifest.keys.home.value, manifest.keys.home.stamp], ['20261114a', stampOf(manifest, 'home')]);
    assert.deepEqual(manifest.keys.splash, before.keys.splash);
    assert.deepEqual((await runBump({ root })).result.bumps, []);
    assert.equal(codes(await runCheck({ root })).includes('key-stale'), false);
});

test('a changed splash file gives the splash script and its index.html link new keys', async (t) => {
    const { root } = copyWithChangedOutput(t, (assets) => {
        assets['splash-tewi'].frames.raised.outputs[0].sha256 = '1'.repeat(64);
    });

    const script = /scripts\/sillybunny-splash\.js\?v=(\d{8}[a-z])/.exec(readFileSync(join(root, 'public/index.html'), 'utf8'))[1];
    const run = await runBump({ root, today: '2026-11-14', write: true });

    assert.deepEqual(run.result.bumps.map(({ field, from, to }) => [field, from, to]), [['value', '20261106e', '20261114a'], ['script', script, '20261114a']]);
    assert.match(readFileSync(join(root, 'public/scripts/sillybunny-splash.js'), 'utf8'), /var ART_VERSION = '20261114a';/);
    assert.match(readFileSync(join(root, 'public/index.html'), 'utf8'), /scripts\/sillybunny-splash\.js\?v=20261114a"/);
});

test('a key that is not newer, a malformed key or day, a key changed by hand and a key held twice are refused', async (t) => {
    const { root } = copyWithChangedOutput(t, (assets) => {
        assets['gs-reisen'].outputs[0].sha256 = '0'.repeat(64);
    });
    assert.deepEqual(codes(await runBump({ root, key: '20261101a', write: true })), ['usage']);
    assert.deepEqual(codes(await runBump({ root, key: 'soon', write: true })), ['usage']);
    assert.deepEqual(codes(await runBump({ root, today: '14 November', write: true })), ['usage']);
    assert.match(readFileSync(join(root, HOME_KEY_FILE), 'utf8'), /'20261105a'/);

    const homeFile = join(root, HOME_KEY_FILE);
    writeFileSync(homeFile, readFileSync(homeFile, 'utf8').replace(/'20261105a'/, '\'20261101a\''));
    assert.ok(codes(await runCheck({ root })).includes('key-mismatch'));

    const index = join(root, 'public/index.html');
    writeFileSync(index, `${readFileSync(index, 'utf8')}<script src="scripts/sillybunny-splash.js?v=20261106d"></script>\n`);
    assert.ok(codes(await runCheck({ root })).includes('key-source'));
});

test('a key ahead of the one the manifest records passes, because the splash script key also moves with its code', async (t) => {
    const root = copyOfArt(t);
    const index = join(root, 'public/index.html');
    writeFileSync(index, readFileSync(index, 'utf8').replace(/(scripts\/sillybunny-splash\.js\?v=)\d{8}[a-z]/, '$120991231z'));

    assert.equal(codes(await runCheck({ root })).includes('key-mismatch'), false);
});
