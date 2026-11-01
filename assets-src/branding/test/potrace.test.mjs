import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodePbm, findPotrace, parsePotraceSvg, traceBitmap } from '../scripts/lib/potrace.mjs';

let potrace;
try {
    potrace = findPotrace();
} catch {
    potrace = undefined;
}
const needsPotrace = { skip: potrace ? false : 'potrace is not installed' };

// What potrace writes for a ring: units of 0.01 px, y up, the first subpath in M and c, the second in m after the first one's z.
const RING = `<?xml version="1.0" standalone="no"?>
<svg version="1.0" xmlns="http://www.w3.org/2000/svg" width="8.000000pt" height="6.000000pt" viewBox="0 0 8.000000 6.000000">
<metadata>Created by potrace 1.16</metadata>
<g transform="translate(0.000000,6.000000) scale(0.010000,-0.010000)" fill="#000000" stroke="none">
<path d="M100 300 c0 -156 67 -200 300 -200 233 0 300 44 300 200 0 156 -67
200 -300 200 -233 0 -300 -44 -300 -200z m500 0 l-100 50 l0 -50 z"/>
</g>
</svg>`;

test('potrace output is read as absolute commands in image pixels with y down, relative commands resolved and a new subpath placed from the last start', () => {
    const commands = parsePotraceSvg(RING);
    assert.deepEqual(commands.map(({ command }) => command), ['M', 'C', 'C', 'C', 'C', 'Z', 'M', 'L', 'L', 'Z']);
    assert.deepEqual(commands[0].points, [[1, 3]]);
    const [first] = commands[1].points;
    assert.ok(Math.abs(first[0] - 1) < 1e-9 && Math.abs(first[1] - (6 - (300 - 156) / 100)) < 1e-9);
    assert.deepEqual(commands[1].points[2], [4, 5]);
    // The second subpath starts 500 units right of the first one's start, because z returns to the start before the relative m.
    assert.deepEqual(commands[6].points, [[6, 3]]);
    assert.deepEqual(commands[7].points, [[5, 2.5]]);
    assert.deepEqual(commands[8].points, [[5, 3]]);
});

test('potrace output with no scale, or a command that is not read, or data that stops short, is an error and not a guess', () => {
    assert.throws(() => parsePotraceSvg('<svg><path d="M0 0z"/></svg>'), /no translate and scale/);
    assert.throws(() => parsePotraceSvg(RING.replace('m500 0', 'q500 0')), /command "q"/);
    assert.throws(() => parsePotraceSvg(RING.replace('c0 -156 67 -200 300 -200', 'c0 -156 67')), /ends in the middle/);
    assert.throws(() => parsePotraceSvg(RING.replace('M100 300', '100 300')), /no command/);
    assert.throws(() => parsePotraceSvg(RING.replace('-200z m500 0', '-200z 500 0')), /numbers after z/);
    assert.deepEqual(parsePotraceSvg(RING.replace(/<path[^>]*\/>/s, '<path d=" "/>')), []);
});

test('a bitmap is written as a binary PBM with one bit per pixel and each row padded to whole bytes', () => {
    const rows = [[1, 0, 1, 0, 0, 0, 0, 0, 1], [1, 1, 0, 0, 0, 0, 0, 0, 1]];
    const pbm = encodePbm({ width: 9, height: 2, data: Uint8Array.from(rows.flat()) });
    const header = Buffer.from('P4\n9 2\n');
    assert.deepEqual(pbm.subarray(0, header.length), header);
    assert.deepEqual([...pbm.subarray(header.length)], [0b10100000, 0b10000000, 0b11000000, 0b10000000]);
});

test('a bitmap of a rectangle comes back as one closed outline of straight lines at its corners', needsPotrace, () => {
    const [width, height] = [30, 20];
    const data = new Uint8Array(width * height);
    for (let y = 5; y < 15; y++) {
        for (let x = 8; x < 22; x++) {
            data[y * width + x] = 1;
        }
    }
    const commands = traceBitmap({ width, height, data }, { potrace, directory: mkdtempSync(join(tmpdir(), 'sb-potrace-')), alphamax: 1, opttolerance: 0.2 });
    assert.equal(commands.filter(({ command }) => command === 'M').length, 1);
    assert.equal(commands.at(-1).command, 'Z');
    const corners = commands.flatMap(({ points }) => points.slice(-1)).map(([x, y]) => `${Math.round(x)},${Math.round(y)}`);
    for (const corner of ['8,5', '22,5', '22,15', '8,15']) {
        assert.ok(corners.includes(corner), `${corner} in ${corners.join(' ')}`);
    }
});

test('potrace failing is reported with its message', needsPotrace, () => {
    assert.throws(() => traceBitmap({ width: 4, height: 4, data: new Uint8Array(16) }, { potrace, directory: '/nonexistent-directory-for-sb', alphamax: 1, opttolerance: 0.2 }), /ENOENT|no such file/i);
    assert.throws(() => traceBitmap({ width: 4, height: 4, data: new Uint8Array(16) }, { potrace: '/bin/false', directory: mkdtempSync(join(tmpdir(), 'sb-potrace-')), alphamax: 1, opttolerance: 0.2 }), /potrace failed/);
});
