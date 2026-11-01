import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'logo-final-check.mjs');
const FILES = ['logo-emblem.svg', 'logo-emblem-nolines.svg', 'logo-plate.svg', 'logo-plate-nolines.svg'];
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="#8b64aa"/></svg>\n';

// The command only writes under the package's own out/, so each test uses a sheet name of its own there and removes it.
const sheetName = (label) => join('out', 'test-tmp', `logo-final-check-${process.pid}-${label}.png`);
const run = (args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT });
const folderWith = (names) => {
    const directory = mkdtempSync(join(tmpdir(), 'sb-final-'));
    for (const name of names) {
        writeFileSync(join(directory, name), SVG);
    }
    return directory;
};

test('the command checks the four files, prints their sizes and writes the sheet under out/', async () => {
    const sheet = sheetName('ok');
    try {
        const outcome = run(['--dir', folderWith(FILES), '--sheet', sheet]);
        assert.equal(outcome.status, 0, outcome.stderr);
        for (const name of FILES) {
            assert.match(outcome.stdout, new RegExp(`${name}  \\d+ bytes, \\d+ gzipped`));
        }
        assert.ok(outcome.stdout.trim().endsWith(sheet.split('\\').join('/')));
        assert.ok((await sharp(join(ROOT, sheet)).metadata()).width > 1000);
    } finally {
        rmSync(join(ROOT, 'out', 'test-tmp'), { recursive: true, force: true });
    }
});

test('a missing file is named, and nothing is written', () => {
    const sheet = sheetName('missing');
    const outcome = run(['--dir', folderWith(FILES.slice(0, 3)), '--sheet', sheet]);
    assert.equal(outcome.status, 1);
    assert.match(outcome.stderr, /logo-plate-nolines\.svg is missing/);
    assert.ok(!existsSync(join(ROOT, sheet)));
});

test('a file that fails the checks stops the command with its name before any sheet is made', () => {
    const sheet = sheetName('bad');
    const directory = folderWith(FILES);
    writeFileSync(join(directory, 'logo-plate.svg'), SVG.replace('<svg ', '<svg width="10" '));
    const outcome = run(['--dir', directory, '--sheet', sheet]);
    assert.equal(outcome.status, 1);
    assert.match(outcome.stderr, /logo-plate\.svg has a width or a height/);
    assert.ok(!existsSync(join(ROOT, sheet)));
});

test('a sheet that exists is not overwritten, and a sheet outside out/ is refused', () => {
    const sheet = sheetName('exists');
    try {
        mkdirSync(dirname(join(ROOT, sheet)), { recursive: true });
        writeFileSync(join(ROOT, sheet), 'keep');
        const existing = run(['--dir', folderWith(FILES), '--sheet', sheet]);
        assert.equal(existing.status, 1);
        assert.match(existing.stderr, /already exists/);
        assert.equal(run(['--dir', folderWith(FILES), '--sheet', join('raw', 'x.png')]).status, 1);
        assert.match(run(['--dir', folderWith(FILES), '--sheet', join('raw', 'x.png')]).stderr, /written under out\/ only/);
        assert.match(run(['--dir', folderWith(FILES), '--sheet', join(tmpdir(), 'x.png')]).stderr, /inside raw\/ or out\//);
    } finally {
        rmSync(join(ROOT, 'out', 'test-tmp'), { recursive: true, force: true });
    }
});
