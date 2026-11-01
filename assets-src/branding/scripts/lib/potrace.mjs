import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** @typedef {import('./geometry.mjs').PathCommand} PathCommand */

/** The potrace binary: $POTRACE, else the PATH. */
export function findPotrace(env = process.env) {
    const candidates = [env.POTRACE, 'potrace'].filter(Boolean);
    const found = candidates.find((candidate) => spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0);
    if (!found) {
        throw new Error('potrace was not found. Install it (for example `brew install potrace`) or set POTRACE to its path.');
    }
    return found;
}

/** A bitmap as a binary PBM (P4), which potrace reads: one bit per pixel, rows padded to whole bytes, 1 is the shape. */
export function encodePbm({ width, height, data }) {
    const rowBytes = Math.ceil(width / 8);
    const bits = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[y * width + x] === 1) {
                bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
            }
        }
    }
    return Buffer.concat([Buffer.from(`P4\n${width} ${height}\n`), bits]);
}

const TOKEN = /[a-zA-Z]|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g;

/**
 * The paths of a potrace SVG as commands in image pixels, y down. Potrace writes its paths in whole units of a fraction of a pixel with the
 * y axis up, scaled and moved by a transform on a group, and in relative commands (m, c, l, z) after a first absolute M.
 * @param {string} svg
 * @returns {PathCommand[]}
 */
export function parsePotraceSvg(svg) {
    const transform = /transform="translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)\s*scale\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)"/.exec(svg);
    if (!transform) {
        throw new Error('The potrace output has no translate and scale on its group, so its units are not known.');
    }
    const [tx, ty, sx, sy] = transform.slice(1).map(Number);
    const data = [...svg.matchAll(/<path\b[^>]*\sd="([^"]*)"/g)].map((match) => match[1]).join(' ');
    if (data.trim() === '') {
        return [];
    }
    const tokens = data.match(TOKEN) ?? [];
    const commands = [];
    const place = (x, y) => [tx + sx * x, ty + sy * y];
    let current = [0, 0];
    let start = [0, 0];
    let at = 0;
    const take = (count) => {
        const values = tokens.slice(at, at + count).map(Number);
        if (values.length < count || values.some(Number.isNaN)) {
            throw new Error('The potrace path data ends in the middle of a command.');
        }
        at += count;
        return values;
    };
    let letter;
    while (at < tokens.length) {
        if (/^[a-zA-Z]$/.test(tokens[at])) {
            letter = tokens[at++];
        }
        if (letter === undefined) {
            throw new Error('The potrace path data starts with numbers and no command.');
        }
        if (letter === 'z' || letter === 'Z') {
            if (at < tokens.length && !/^[a-zA-Z]$/.test(tokens[at])) {
                throw new Error('The potrace path data has numbers after z.');
            }
            commands.push({ command: 'Z', points: [] });
            current = start;
            continue;
        }
        if (letter === 'M' || letter === 'm') {
            const [x, y] = take(2);
            current = letter === 'M' ? [x, y] : [current[0] + x, current[1] + y];
            start = current;
            commands.push({ command: 'M', points: [place(...current)] });
            // More pairs after a move are lines.
            letter = letter === 'M' ? 'L' : 'l';
        } else if (letter === 'L' || letter === 'l') {
            const [x, y] = take(2);
            current = letter === 'L' ? [x, y] : [current[0] + x, current[1] + y];
            commands.push({ command: 'L', points: [place(...current)] });
        } else if (letter === 'C' || letter === 'c') {
            const values = take(6);
            const absolute = letter === 'C' ? values : values.map((value, index) => value + current[index % 2]);
            commands.push({ command: 'C', points: [0, 2, 4].map((index) => place(absolute[index], absolute[index + 1])) });
            current = [absolute[4], absolute[5]];
        } else {
            throw new Error(`The potrace path data has a command "${letter}" that this tool does not read.`);
        }
    }
    return commands;
}

/**
 * Traces the shape pixels of a bitmap with potrace into closed cubic and straight segments in the bitmap's own pixel coordinates.
 * @param {{ width: number, height: number, data: Uint8Array }} bitmap 1 for the shape
 * @param {{ potrace: string, directory: string, alphamax: number, opttolerance: number }} options `directory` is where the temporary files go
 * `alphamax` is potrace's corner threshold (smaller keeps more corners) and `opttolerance` how far curve joining may move a curve in pixels
 * @returns {PathCommand[]}
 */
export function traceBitmap(bitmap, { potrace, directory, alphamax, opttolerance }) {
    const input = join(directory, 'bitmap.pbm');
    const output = join(directory, 'bitmap.svg');
    writeFileSync(input, encodePbm(bitmap));
    // A turd size of 0 keeps every speck, so a small counter of a letter is not lost; -u 100 writes hundredths of a pixel.
    const result = spawnSync(potrace, ['-b', 'svg', '--flat', '-u', '100', '-t', '0', '-a', String(alphamax), '-O', String(opttolerance), '-o', output, input], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`potrace failed: ${(result.stderr || result.stdout).trim().split('\n')[0] || 'no message'}`);
    }
    return parsePotraceSvg(readFileSync(output, 'utf8'));
}
