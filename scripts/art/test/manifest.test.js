import assert from 'node:assert/strict';
import { test } from 'node:test';
import { masterFile, mastersOf, outputFile, outputsOf, parseRatio, picturesOf, validateManifest } from '../lib/manifest.js';
import { fakeSha, sampleManifest } from '../test-support/manifests.js';

const messages = (manifest) => validateManifest(manifest).map(({ message }) => message);

test('a manifest with one asset of every type is valid', () => {
    assert.deepEqual(validateManifest(sampleManifest()), []);
});

test('a ratio is master pixels per placement pixel in lowest terms, and nothing else is one', () => {
    assert.deepEqual(parseRatio('1'), { p: 1, q: 1 });
    assert.deepEqual(parseRatio('3/2'), { p: 3, q: 2 });
    assert.deepEqual(parseRatio('4/2'), { p: 2, q: 1 });
    for (const text of ['0', '1.5', '3/0', '-2', '', undefined]) {
        assert.equal(parseRatio(text), null, String(text));
    }
});

test('an output may only be a file the app serves or seeds art from', () => {
    for (const path of ['src/x.png', '../x.png', '/etc/x.png', 'public/img\\x.png', 'public/index.html', 'public/img/../index.html']) {
        const manifest = sampleManifest();
        manifest.assets['gs-reisen'].outputs[0].path = path;
        assert.ok(messages(manifest).some((message) => message.includes('must be a path under')), path);
    }
});

test('a master may not leave the master folder', () => {
    const manifest = sampleManifest();
    manifest.assets['gs-reisen'].master = '../branding/approved/gs-reisen.png';

    assert.ok(messages(manifest).some((message) => message.includes('must be a path inside assets-src/art/master')));
    assert.throws(() => masterFile('/repo', '../../outside.png'), /leaves/);
    assert.throws(() => outputFile('/repo', '../outside.png'), /leaves/);
});

test('two assets cannot ship the same file', () => {
    const manifest = sampleManifest();
    manifest.assets['icon-16'].outputs[0].path = 'public/img/sillybunny/gs-reisen@native.webp';

    assert.ok(messages(manifest).some((message) => message.includes('is also an output of gs-reisen')));
});

test('the shape of each asset is checked', () => {
    const cases = [
        [(manifest) => { manifest.format = 2; }, 'format must be 1'],
        [(manifest) => { manifest.extra = true; }, 'unknown key "extra"'],
        [(manifest) => { manifest.assets['gs-reisen'].type = 'sprite'; }, 'type must be one of'],
        [(manifest) => { manifest.assets.Bad = manifest.assets['gs-reisen']; }, 'must be lowercase letters'],
        [(manifest) => { manifest.assets['gs-reisen'].ratio = '1.5'; }, 'ratio must be'],
        [(manifest) => { manifest.assets['gs-reisen'].frame = { mode: 'subject' }; }, 'frame must be'],
        [(manifest) => { manifest.assets['gs-reisen'].grid = [0, 3]; }, 'grid must be'],
        [(manifest) => { manifest.assets['gs-reisen'].outputs[0].sha256 = 'abc'; }, '64 lowercase hex'],
        [(manifest) => { delete manifest.assets['gs-reisen'].outputs[0].encoding; }, 'needs an encoding'],
        [(manifest) => { manifest.assets['splash-reisen'].outputs[0].from = 'call'; }, 'does not have'],
        [(manifest) => { delete manifest.assets['splash-reisen'].outputs[0].from; }, 'must take every output from a frame'],
        [(manifest) => { manifest.assets['hero-duo'].layers.reisen.box = [2, 4, 0, 362]; }, 'needs a box'],
        [(manifest) => { delete manifest.assets['hero-duo'].compose; }, 'compose needs the pose'],
        [(manifest) => { manifest.assets.favicon.entries = ['gs-reisen']; }, 'is not an icon'],
        [(manifest) => { manifest.assets['greeting-reisen'].outputs.pop(); }, 'exactly two outputs'],
        [(manifest) => { manifest.assets['greeting-reisen'].reason = ''; }, 'needs the reason'],
        [(manifest) => { manifest.keys = { home: { value: '2026115a', stamp: fakeSha('1') } }; }, 'keys.home needs'],
        [(manifest) => { manifest.keys = { splash: { value: '20261106e', stamp: fakeSha('1') } }; }, 'keys.splash needs the script key'],
    ];
    for (const [change, expected] of cases) {
        const manifest = sampleManifest();
        change(manifest);
        assert.ok(messages(manifest).some((message) => message.includes(expected)), `${expected}: ${messages(manifest).join(' | ')}`);
    }
});

test('the pictures, outputs and masters of an asset are listed with every frame, layer and motion file', () => {
    const { assets } = sampleManifest();

    assert.deepEqual(picturesOf(assets['splash-reisen']).map(({ role, master }) => [role, master]), [['frame idle', 'reisen/splash-reisen--idle.png']]);
    assert.deepEqual(picturesOf(assets['hero-duo']).map(({ role }) => role), ['base', 'backdrop', 'layer reisen breath-c']);
    assert.deepEqual(outputsOf(assets['splash-reisen']).map(({ path }) => path), [
        'public/img/sillybunny/splash-reisen@native.webp',
        'public/img/sillybunny/splash-reisen--idle@native.webp',
        'public/img/sillybunny/splash-reisen--anim.json',
    ]);
    assert.deepEqual(mastersOf(assets['logo-svg']), ['logo/logo.svg']);
    assert.deepEqual(mastersOf(assets['hero-duo']), [
        'hero-duo/hero-duo.png',
        'hero-duo/hero-duo--backdrop.png',
        'hero-duo/hero-duo--reisen--breath-c.png',
        'hero-duo/hero-duo--breath.json',
    ]);
});
