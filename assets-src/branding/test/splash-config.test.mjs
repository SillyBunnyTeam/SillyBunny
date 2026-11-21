import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSplashConfig } from '../scripts/lib/splash-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL = JSON.parse(readFileSync(join(ROOT, 'splash-config.json'), 'utf8'));

const changed = (edit) => {
    const copy = structuredClone(REAL);
    edit(copy);
    return () => parseSplashConfig(copy);
};

test('the real splash-config.json parses: two bases, the three frames, the parts kept from Tewi\'s base, a scene and a timeline for each character and for both', () => {
    const config = parseSplashConfig(REAL);
    assert.deepEqual(config.frames.map(({ name, base }) => `${base}/${name}`), ['reisen/call', 'tewi/mid', 'tewi/strike']);
    assert.deepEqual(config.poses, { reisen: ['idle', 'call'], tewi: ['raised', 'mid', 'strike'] });
    assert.deepEqual(config.frames[1].keep.map(({ name }) => name), ['face', 'skirt', 'legs', 'mortar-body']);
    assert.deepEqual(config.frames[0].keep, []);
    assert.equal(config.timelines.reisen.seconds, 2.4);
    assert.equal(config.timelines.tewi.seconds, 1.6);
    assert.equal(config.timelines.both.seconds, 2.4);
    const call = config.timelines.both.reisen.find(({ frame }) => frame === 'call').at;
    const strike = config.timelines.both.tewi.find(({ frame }) => frame === 'strike').at;
    assert.equal(call, strike, 'in the loop of both, her call lands on her strike');
});

test('a bad splash-config.json is refused with the place named: unknown keys, bases, keep groups, settings (kind and range), paths, poses, timelines, scene and boxes', () => {
    assert.throws(changed((raw) => { raw.extra = 1; }), /the file has an unknown key "extra"/);
    assert.throws(changed((raw) => { raw.frames[0].base = 'nobody'; }), /frames\[0\]\.base "nobody" is not one of the bases/);
    assert.throws(changed((raw) => { raw.frames[1].keep = 'missing'; }), /frames\[1\]\.keep "missing" is not a group in keep/);
    assert.throws(changed((raw) => { raw.frames[1].settings.colourTolerance = -1; }), /frames\[1\]\.settings\.colourTolerance must be a number of 0 or more/);
    assert.throws(changed((raw) => { raw.frames[1].settings.sparkle = 1; }), /unknown key "sparkle"/);
    for (const key of ['shift', 'openRadius', 'closeRadius']) {
        assert.throws(changed((raw) => { raw.frames[1].settings[key] = 1.5; }), new RegExp(`frames\\[1\\]\\.settings\\.${key} must be a whole number of pixels, got 1\\.5`));
    }
    assert.throws(changed((raw) => { raw.frames[1].settings.minAlpha = 256; }), /settings\.minAlpha must be at most 255, got 256/);
    assert.doesNotThrow(changed((raw) => { raw.frames[1].settings.minAlpha = 255; raw.frames[1].settings.shift = 0; raw.frames[1].settings.growRadius = 7.5; }), 'the limit itself, a zero and a fractional radius are allowed');
    assert.throws(changed((raw) => { raw.frames[2].name = 'mid'; }), /the poses of tewi are not all different/);
    assert.throws(changed((raw) => { raw.frames[0].edit = '/etc/passwd'; }), /frames\[0\]\.edit must be a path inside the package/);
    assert.throws(changed((raw) => { raw.timelines.tewi.keys[1].frame = 'fly'; }), /timelines\.tewi\.keys\[1\]\.frame "fly" is not a pose of this character/);
    assert.throws(changed((raw) => { raw.timelines.tewi.keys[1].at = 9; }), /at must be a time from 0 up to \(not including\) 1.6 seconds/);
    assert.throws(changed((raw) => { raw.timelines.tewi.keys[2].at = 0.1; }), /must start at 0 and go forward in time/);
    assert.throws(changed((raw) => { raw.timelines.reisen.effect.at.x = 2; }), /effect\.at must give x and y as shares/);
    assert.throws(changed((raw) => { raw.timelines.both.seconds = 0; }), /timelines\.both\.seconds must be a number of seconds above 0/);
    assert.throws(changed((raw) => { raw.scene.right = 'reisen'; }), /scene\.left and scene\.right must be the two different bases/);
    assert.throws(changed((raw) => { raw.scene.gap = 1.5; }), /scene\.gap and scene\.margin must be whole numbers/);
    assert.throws(changed((raw) => { raw.keep.tewi[0].box.width = 0; }), /keep\.tewi\[0\]\.box needs whole master pixels/);
    assert.throws(() => parseSplashConfig([]), /the file must be an object/);
});
