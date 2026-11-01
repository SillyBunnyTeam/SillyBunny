import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bodyHeightFor, characterOf, configuredRingWidths, parseSnapConfig } from '../scripts/lib/snap-config.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = { bodyHeights: { tewi: 283, reisen: 340 }, lineupRatio: 0.8333 };

function root({ config = CONFIG, assets = { solo: { characters: ['tewi'] }, duo: { characters: ['reisen', 'tewi'] } } } = {}) {
    const rootDir = mkdtempSync(join(tmpdir(), 'sb-snapcfg-'));
    mkdirSync(join(rootDir, 'prompts'));
    writeFileSync(join(rootDir, 'prompts', 's5-masters.json'), JSON.stringify({ assets }));
    if (config) {
        writeFileSync(join(rootDir, 'snap-config.json'), JSON.stringify(config));
    }
    return rootDir;
}

test('the snap-config.json of the package parses, and its two heights keep the line-up ratio', () => {
    const { bodyHeights, lineupRatio } = parseSnapConfig(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'snap-config.json'), 'utf8')));
    assert.deepEqual(bodyHeights, { tewi: 283, reisen: 340 });
    assert.deepEqual(parseSnapConfig(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'snap-config.json'), 'utf8'))).rings, { rim: 2, band: 2 });
    assert.ok(Math.abs(bodyHeights.tewi / bodyHeights.reisen - lineupRatio) / lineupRatio < 0.005);
});

test('a config with an unknown key, a height that is not a whole number, or two heights off the ratio is refused, saying what the height should be', () => {
    assert.throws(() => parseSnapConfig({ ...CONFIG, extra: 1 }), /unknown key "extra"/);
    assert.throws(() => parseSnapConfig({ ...CONFIG, bodyHeights: { tewi: 283.5, reisen: 340 } }), /whole number of 8 or more/);
    assert.throws(() => parseSnapConfig({ bodyHeights: {}, lineupRatio: 0.8 }), /at least one character/);
    assert.throws(() => parseSnapConfig({ bodyHeights: { tewi: 283, reisen: 340 } }), /lineupRatio must be/);
    assert.throws(() => parseSnapConfig({ ...CONFIG, bodyHeights: { tewi: 283, reisen: 330 } }), /reisen should be 340/);
    assert.deepEqual(parseSnapConfig({ bodyHeights: { tewi: 283 }, lineupRatio: 0.8333 }).bodyHeights, { tewi: 283 });
});

test('a picture takes the character that prompts/s5-masters.json gives it, unless the caller names one, and a picture of both has none', () => {
    const rootDir = root();
    assert.equal(characterOf(rootDir, 'solo'), 'tewi');
    assert.equal(characterOf(rootDir, 'anything', 'reisen'), 'reisen');
    assert.throws(() => characterOf(rootDir, 'duo'), /shows reisen and tewi, so it has no one body height/);
    assert.throws(() => characterOf(rootDir, 'missing'), /"missing" is not in prompts\/s5-masters.json/);
});

test('the body height is the one set for the picture\'s character, and a missing config or character is refused', () => {
    const rootDir = root();
    assert.deepEqual(bodyHeightFor({ rootDir, id: 'solo' }), { character: 'tewi', bodyHeight: 283 });
    assert.deepEqual(bodyHeightFor({ rootDir, id: 'x', character: 'reisen' }), { character: 'reisen', bodyHeight: 340 });
    assert.throws(() => bodyHeightFor({ rootDir, id: 'x', character: 'moon' }), /no body height for "moon"\. It has: tewi, reisen/);
    assert.throws(() => bodyHeightFor({ rootDir: root({ config: null }), id: 'solo' }), /snap-config.json does not exist/);
});

test('the ring widths of the config are whole numbers of art pixels, and none are set when the file has none or does not exist', () => {
    assert.deepEqual(parseSnapConfig({ ...CONFIG, rings: { rim: 2, band: 3 } }).rings, { rim: 2, band: 3 });
    assert.equal(parseSnapConfig(CONFIG).rings, undefined);
    assert.throws(() => parseSnapConfig({ ...CONFIG, rings: { rim: 2 } }), /rings.band must be a whole number/);
    assert.throws(() => parseSnapConfig({ ...CONFIG, rings: { rim: 0, band: 2 } }), /rings.rim must be a whole number/);
    assert.throws(() => parseSnapConfig({ ...CONFIG, rings: { rim: 2, band: 2, glow: 1 } }), /unknown key "glow"/);
    assert.deepEqual(configuredRingWidths(root({ config: { ...CONFIG, rings: { rim: 2, band: 3 } } })), { rimWidth: 2, bandWidth: 3 });
    assert.deepEqual(configuredRingWidths(root()), {});
    assert.deepEqual(configuredRingWidths(root({ config: null })), {});
});
