import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSplitColumn, LINEUP_RANGE, measureLineup } from '../scripts/lib/github-lineup.mjs';
import { parseSnapConfig } from '../scripts/lib/snap-config.mjs';
import { createRaster, setPixel } from '../test-support/synthetic.mjs';

const HEAD = [60, 40, 80, 255];

/** Two plain figures standing on one line, `left` and `right` tall, with a gap between them. */
function pair({ left, right, height = 120 }) {
    const raster = createRaster(100, height);
    const fill = (x0, x1, tall) => {
        for (let y = height - 2 - tall; y < height - 2; y++) {
            for (let x = x0; x < x1; x++) {
                setPixel(raster, x, y, HEAD);
            }
        }
    };
    fill(8, 38, left);
    fill(55, 85, right);
    return raster;
}

test('the range of ratios that is let through is centred on the line-up that snap-config.json sets', () => {
    const { lineupRatio } = parseSnapConfig(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'snap-config.json'), 'utf8')));
    assert.deepEqual({ ...LINEUP_RANGE }, { min: 0.81, max: 0.85 });
    assert.ok(Math.abs((LINEUP_RANGE.min + LINEUP_RANGE.max) / 2 - lineupRatio) < 0.005, `the middle of the range is the line-up ${lineupRatio}`);
});

test('the two figures part at the emptiest column in the middle of the picture', () => {
    const split = findSplitColumn(pair({ left: 100, right: 83 }));
    assert.ok(split >= 38 && split < 55, `split at ${split}, in the gap between the figures`);
});

test('Tewi over Reisen is measured on the figures, whichever side Reisen is on, and flagged outside the range', () => {
    const inLineup = measureLineup(pair({ left: 100, right: 83 }), { reisen: 'left', pose: 'standing' });
    assert.ok(inLineup.ratio >= LINEUP_RANGE.min && inLineup.ratio <= LINEUP_RANGE.max, `ratio ${inLineup.ratio}`);
    assert.equal(inLineup.verdict, 'ok');
    assert.ok(inLineup.reisen > inLineup.tewi);

    const mirrored = measureLineup(pair({ left: 83, right: 100 }), { reisen: 'right', pose: 'standing' });
    assert.equal(mirrored.verdict, 'ok');
    assert.equal(mirrored.reisen, inLineup.reisen);

    const tall = measureLineup(pair({ left: 100, right: 96 }), { reisen: 'left', pose: 'standing' });
    assert.equal(tall.verdict, 'check', 'a Tewi almost as tall as Reisen is flagged');
    const short = measureLineup(pair({ left: 100, right: 70 }), { reisen: 'left', pose: 'standing' });
    assert.equal(short.verdict, 'check', 'and so is one who is too short');
});

test('a pair of which one kneels and one stands is measured but not judged', () => {
    const mixed = measureLineup(pair({ left: 100, right: 96 }), { reisen: 'left', pose: 'mixed' });
    assert.equal(mixed.comparable, false);
    assert.equal(mixed.verdict, 'not comparable');
    assert.ok(mixed.ratio > LINEUP_RANGE.max, 'the number is still reported');
});
