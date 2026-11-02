import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseBreathConfig } from '../scripts/lib/breath-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL = JSON.parse(readFileSync(join(ROOT, 'breath-config.json'), 'utf8'));

test('the real breath-config.json parses: the waist at 55 percent, two breaths in 3.5 seconds, the three grid scenes and no splash', () => {
    const config = parseBreathConfig(REAL);
    assert.equal(config.waist, 0.55);
    assert.equal(config.cycleSeconds, 3.5);
    assert.equal(config.breathsPerCycle, 2);
    assert.deepEqual(config.scenes, ['hero-duo', 'hero-duo-night', 'welcome-both']);
    assert.deepEqual(config.stills, []);
});

test('a config with a wrong key, waist, rhythm or picture name is refused with the key named', () => {
    const changed = (edit) => {
        const copy = structuredClone(REAL);
        edit(copy);
        return () => parseBreathConfig(copy);
    };
    assert.throws(changed((raw) => { raw.extra = 1; }), /unknown key "extra"/);
    assert.throws(changed((raw) => { raw.waist = 0; }), /waist must be a number above 0 and below 1/);
    assert.throws(changed((raw) => { raw.waist = 1; }), /waist must be a number above 0 and below 1/);
    assert.throws(changed((raw) => { raw.waist = '0.55'; }), /waist must be a number/);
    assert.throws(changed((raw) => { raw.cycleSeconds = 0; }), /cycleSeconds must be a number of seconds above 0/);
    assert.throws(changed((raw) => { raw.breathsPerCycle = 1.5; }), /breathsPerCycle must be a whole number of 1 or more/);
    assert.throws(changed((raw) => { raw.stills = ['../x']; }), /stills must be a list of picture names/);
    assert.throws(changed((raw) => { raw.scenes = ['a', 'a']; }), /scenes names a picture twice/);
    assert.throws(() => parseBreathConfig([]), /must hold an object/);
});
