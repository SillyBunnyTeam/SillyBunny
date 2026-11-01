import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'logo-fix-check.mjs');
const PLATES = ['logo-plate-nolines.svg', 'logo-plate.svg'];

// A plate like the real ones, 1024 units square: the outline used for the lip and the plate, then a block with the letters' place as a hole, at
// the same pixels as the letters of the master below, moved by `shift`.
const plate = (shift) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><path id="o" d="M0 0h1024v1024h-1024z"/></defs><use href="#o" fill="#e4d2f5"/><use href="#o" fill="#f5e9ff"/><path fill="#8b64aa" d="M${300 + shift} ${700 + shift}h420v260h-420zM${372 + shift} ${769 + shift}v171h280v-171z"/></svg>\n`;

// The command only writes under the package's own out/, so each test uses a sheet name of its own there and removes it.
const sheetName = (label) => join('out', 'test-tmp', `logo-fix-check-${process.pid}-${label}.png`);
const run = (args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT });
const folderWith = (names, at) => {
    const directory = mkdtempSync(join(tmpdir(), 'sb-fix-'));
    for (const name of names) {
        writeFileSync(join(directory, name), plate(at));
    }
    return directory;
};
// A master with a block and the letters' place cut out of it as a transparent hole, as the letters are.
const masterFile = async () => {
    const data = Buffer.alloc(1024 * 1024 * 4);
    for (let y = 700; y < 960; y++) {
        for (let x = 300; x < 720; x++) {
            const hole = x >= 372 && x < 652 && y >= 769 && y < 940;
            data.set(hole ? [139, 100, 170, 0] : [139, 100, 170, 255], (y * 1024 + x) * 4);
        }
    }
    const path = join(mkdtempSync(join(tmpdir(), 'sb-master-')), 'master.png');
    await sharp(data, { raw: { width: 1024, height: 1024, channels: 4 } }).png().toFile(path);
    return path;
};

test('the command checks both plates in both folders, prints their sizes and writes the sheet under out/', async () => {
    const sheet = sheetName('ok');
    try {
        const outcome = run(['--master', await masterFile(), '--old', folderWith(PLATES, 0), '--new', folderWith(PLATES, 2), '--scale', '1', '--sheet', sheet]);
        assert.equal(outcome.status, 0, outcome.stderr);
        for (const name of ['logo-plate-nolines', 'logo-plate']) {
            assert.match(outcome.stdout, new RegExp(`${name}  old \\d+ bytes, \\d+ gzipped  new \\d+ bytes, \\d+ gzipped`));
        }
        assert.ok(outcome.stdout.trim().endsWith(sheet.split('\\').join('/')));
        assert.ok((await sharp(join(ROOT, sheet)).metadata()).width > 1000);
    } finally {
        rmSync(join(ROOT, 'out', 'test-tmp'), { recursive: true, force: true });
    }
});

test('a missing plate is named, and nothing is written', async () => {
    const sheet = sheetName('missing');
    const outcome = run(['--master', await masterFile(), '--old', folderWith(PLATES, 0), '--new', folderWith(PLATES.slice(0, 1), 2), '--sheet', sheet]);
    assert.equal(outcome.status, 1);
    assert.match(outcome.stderr, /logo-plate\.svg is missing/);
    assert.ok(!existsSync(join(ROOT, sheet)));
});

test('a master with no letters, and a call with no master, stop the command with a message', async () => {
    const solid = join(mkdtempSync(join(tmpdir(), 'sb-master-')), 'solid.png');
    await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toFile(solid);
    const sheet = sheetName('solid');
    const outcome = run(['--master', solid, '--old', folderWith(PLATES, 0), '--new', folderWith(PLATES, 2), '--sheet', sheet]);
    assert.equal(outcome.status, 1);
    assert.match(outcome.stderr, /no letters cut out/);
    assert.match(run([]).stderr, /Usage: logo-fix-check/);
    assert.ok(!existsSync(join(ROOT, sheet)));
});

test('a sheet that exists is not overwritten, and a sheet outside out/ is refused', async () => {
    const sheet = sheetName('exists');
    try {
        mkdirSync(dirname(join(ROOT, sheet)), { recursive: true });
        writeFileSync(join(ROOT, sheet), 'keep');
        const args = ['--master', await masterFile(), '--old', folderWith(PLATES, 0), '--new', folderWith(PLATES, 2)];
        const existing = run([...args, '--sheet', sheet]);
        assert.equal(existing.status, 1);
        assert.match(existing.stderr, /already exists/);
        assert.match(run([...args, '--sheet', join('raw', 'x.png')]).stderr, /written under out\/ only/);
        assert.match(run([...args, '--sheet', join(tmpdir(), 'x.png')]).stderr, /inside raw\/ or out\//);
    } finally {
        rmSync(join(ROOT, 'out', 'test-tmp'), { recursive: true, force: true });
    }
});
