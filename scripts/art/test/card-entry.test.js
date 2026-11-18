import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cardOnGrid, differences, embedCard, loadAppCardParser } from '../lib/card.js';
import { rgbOf } from '../lib/card-entry.js';
import { decode, encode, encoderVersions } from '../lib/codec.js';
import { runBump, runCheck, runDerive, runNotice, runProve } from '../lib/commands.js';
import { MASTER_ROOT, mastersOf, outputsOf, picturesOf, readManifest, validateManifest } from '../lib/manifest.js';
import { samePixels, sha256, upscaleNearest } from '../lib/raster.js';
import { fixtureCard } from '../test-support/cards.js';
import { fakeSha, sampleManifest, sampleRecord } from '../test-support/manifests.js';
import { paint } from '../test-support/pictures.js';
import { copyOfArt, fixtureRepo, writeFixtureManifest } from '../test-support/repos.js';

const CARD_FILE = 'default/content/default_AssistantTest.png';
const CLEAR = [0, 0, 0, 0];
const SKIN = [250, 220, 200, 255];
const DRESS = [90, 60, 140, 255];

/** A waist-up sprite on a transparent ground: a head over a body that the bottom edge cuts, as at the waist. */
const sprite = () => paint(8, 12, (x, y) => (y >= 2 && y < 5 && x >= 3 && x < 6 ? SKIN : y >= 5 && x >= 1 && x < 7 ? DRESS : CLEAR));

/** A card entry that passes: a 6x9 crop of the master shipped at scale 4, with its text read from the card file it ships. */
function cardEntry(extra = {}) {
    return {
        type: 'card',
        key: null,
        master: 'test/card-test.png',
        crop: [1, -1, 6, 9],
        grid: [6, 9],
        gradient: { top: '#f5e9ff', bottom: '#d9c2f0' },
        text: CARD_FILE,
        world: 'Test World',
        outputs: [{ path: CARD_FILE, encoding: 'png-card', scale: 4, sha256: fakeSha('d') }],
        ...extra,
    };
}

const withCard = (asset) => {
    const manifest = sampleManifest();
    manifest.assets['card-test'] = asset;
    return manifest;
};
const messages = (manifest) => validateManifest(manifest).map(({ message }) => message);

test('a card entry takes the sprite master, its crop at the grid, the gradient, the text source, the world and one card file', () => {
    const asset = cardEntry();

    assert.deepEqual(validateManifest(withCard(asset)), []);
    assert.deepEqual(mastersOf(asset), ['test/card-test.png']);
    assert.deepEqual(outputsOf(asset).map(({ path }) => path), [CARD_FILE]);
    assert.deepEqual(picturesOf(asset).map(({ role, master }) => [role, master]), [['base', 'test/card-test.png']]);
});

test('each fault of a card entry is named', () => {
    const output = cardEntry().outputs[0];
    const cases = [
        [{ key: 'home' }, 'key must be null'],
        [{ size: [768, 1152] }, 'unknown key "size"'],
        [{ master: '../card.png' }, 'must be a path inside assets-src/art/master'],
        [{ crop: [1, -1, 6] }, 'crop must be [left, top, width, height]'],
        [{ crop: [1, -1.5, 6, 9] }, 'crop must be [left, top, width, height]'],
        [{ crop: [1, -1, 0, 9] }, 'crop must be [left, top, width, height]'],
        [{ crop: [1, -1, 6, 8] }, 'The crop is 6x8, but the grid is 6x9'],
        [{ grid: [6] }, 'grid must be'],
        [{ gradient: { top: '#F5E9FF', bottom: '#d9c2f0' } }, 'gradient must be'],
        [{ gradient: { top: '#f5e9ff' } }, 'gradient must be'],
        [{ gradient: { top: '#f5e9ff', bottom: '#d9c2f0', middle: '#ffffff' } }, 'gradient must be'],
        [{ text: 'default/content/Assistant Test.json' }, 'text must be the path of the card file'],
        [{ text: '../outside.png' }, 'text must be the path of the card file'],
        [{ world: '' }, 'world must name'],
        [{ outputs: [output, { ...output, path: 'default/content/other.png' }] }, 'exactly one file'],
        [{ outputs: [{ ...output, encoding: 'png' }] }, 'exactly one file'],
        [{ outputs: [{ ...output, path: 'default/content/Test/card.png' }] }, 'exactly one file'],
        [{ outputs: [{ ...output, path: 'public/img/sillybunny/card.png' }] }, 'exactly one file'],
        [{ outputs: [{ ...output, scale: 1.5 }] }, 'must be a whole number of 1 or more'],
        [{ outputs: [{ ...output, sha256: 'abc' }] }, '64 lowercase hex'],
    ];
    for (const [change, expected] of cases) {
        const found = messages(withCard(cardEntry(change)));
        assert.ok(found.some((message) => message.includes(expected)), `${JSON.stringify(change)}: ${found.join(' | ')}`);
    }
});

test('a card ships a file that no other asset ships', () => {
    const manifest = withCard(cardEntry({ outputs: [{ path: 'default/content/default_AssistantTest.png', encoding: 'png-card', scale: 4, sha256: fakeSha('d') }] }));
    manifest.assets['card-other'] = cardEntry({ master: 'test/card-other.png' });

    assert.ok(messages(manifest).some((message) => message.includes('is also an output of card-test')));
});

test('a gradient colour is read as its three channels', () => {
    assert.deepEqual(rgbOf('#f5e9ff'), [0xf5, 0xe9, 0xff]);
    assert.deepEqual(rgbOf('#000a10'), [0, 10, 16]);
});

/** The card entry of `sprite()`: its whole figure, with room above and to the left where the gradient shows, at scale 4. */
const derivedEntry = (extra = {}) => cardEntry({ crop: [-1, -2, 8, 14], grid: [8, 14], ...extra });
const plainPicture = () => encode(paint(2, 3, () => [10, 20, 30, 255], 3), 'png');
const codes = (run) => run.result.problems.map(({ code }) => code);

/**
 * A scratch checkout with one card entry, its master, and the card file that holds its text: a small picture that carries
 * the fixture card, as a card file does before its first derive.
 */
async function cardRepo(t, { entry = derivedEntry(), master = sprite(), text } = {}) {
    const root = await fixtureRepo(t, {
        [`${MASTER_ROOT}/test/card-test.png`]: master,
        [CARD_FILE]: text ?? await embedCard(await plainPicture(), fixtureCard()),
    });
    writeFixtureManifest(root, { format: 1, encoder: encoderVersions(), assets: { 'card-test': entry } });
    return root;
}

/** Runs `action` with the app's reader free to log, as it does for a picture that holds no card, without printing it. */
async function quietly(action) {
    const original = console.error;
    console.error = () => {};
    try {
        return await action();
    } finally {
        console.error = original;
    }
}

test('a card is derived from its sprite master: the crop over the gradient at a whole scale, carrying the text of its card file with the world set', async (t) => {
    const root = await cardRepo(t);

    const first = await runDerive({ root, write: true });

    assert.deepEqual([codes(first), first.result.written], [[], [CARD_FILE]]);
    const bytes = readFileSync(join(root, CARD_FILE));
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20), bytes[24], bytes[25]], [32, 56, 8, 2], 'an 8-bit RGB picture of the grid at scale 4');
    assert.equal(samePixels(await decode(bytes), upscaleNearest(cardOnGrid(sprite(), derivedEntry()), 4)), true);
    const { read } = await loadAppCardParser();
    assert.deepEqual(differences(fixtureCard(), JSON.parse(read(bytes))).map(({ path }) => path), ['data.extensions.world']);
    assert.equal(readManifest(root).manifest.assets['card-test'].outputs[0].sha256, sha256(bytes));

    const again = await runDerive({ root, write: true });
    assert.deepEqual([again.result.changed, again.result.written, again.result.manifestChanged], [[], [], false]);
    assert.equal((await runProve({ root })).exitCode, 0);
    assert.equal((await runProve({ root, pixels: true })).exitCode, 0);
});

test('the card file is the one source of its text: a new text there is kept, and a picture there that the master does not give is replaced', async (t) => {
    const root = await cardRepo(t);
    await runDerive({ root, write: true });
    const { read, write } = await loadAppCardParser();
    const path = join(root, CARD_FILE);
    const edited = JSON.parse(read(readFileSync(path)));
    edited.data.description = 'A new description, written in the app.';
    writeFileSync(path, write(readFileSync(path), JSON.stringify(edited)));

    assert.deepEqual(codes(await runProve({ root })), ['manifest-stale'], 'the file is what its master and its own text give; only the recorded hash is old');
    const recorded = await runDerive({ root, write: true });
    assert.deepEqual([recorded.result.written, recorded.result.manifestChanged], [[], true]);
    assert.equal((await runProve({ root })).exitCode, 0);

    writeFileSync(path, write(await encode(paint(32, 56, () => [1, 2, 3, 255], 3), 'png-card'), read(readFileSync(path))));
    assert.deepEqual(codes(await runProve({ root })), ['output-stale']);
    const restored = await runDerive({ root, write: true });
    assert.deepEqual(restored.result.written, [CARD_FILE]);
    const bytes = readFileSync(path);
    assert.equal(samePixels(await decode(bytes), upscaleNearest(cardOnGrid(sprite(), derivedEntry()), 4)), true, 'the picture is the master\'s again');
    assert.equal(JSON.parse(read(bytes)).data.description, 'A new description, written in the app.', 'and the text is the one the file held');
});

test('a proof by pixels compares a card\'s text as well, so a card file that shows the right pixels with other text is stale', async (t) => {
    const root = await cardRepo(t);
    await runDerive({ root, write: true });
    const { read, write } = await loadAppCardParser();
    const path = join(root, CARD_FILE);
    const card = JSON.parse(read(readFileSync(path)));
    card.data.character_book = { name: 'Embedded', entries: [], extensions: {} };
    writeFileSync(path, write(readFileSync(path), JSON.stringify(card)));

    const byPixels = await runProve({ root, pixels: true });
    assert.deepEqual(codes(byPixels), ['output-stale'], 'the derive drops the embedded book, so the text it gives differs while every pixel is the same');
    assert.match(byPixels.result.problems[0].message, /does not show the pixels its master gives, or does not carry the card text its text source gives\.$/);
    assert.deepEqual(codes(await runProve({ root })), ['output-stale']);
    await runDerive({ root, write: true });
    assert.equal((await runProve({ root, pixels: true })).exitCode, 0);
});

test('a crop that cuts the figure wrongly, a translucent master, and a card file with no card text are refused, and nothing is written', async (t) => {
    const cases = [
        [{ entry: derivedEntry({ crop: [-1, 3, 8, 9], grid: [8, 9] }) }, 'card-cut-top'],
        [{ entry: derivedEntry({ crop: [-1, -2, 8, 15], grid: [8, 15] }) }, 'card-waist'],
        [{ master: paint(8, 12, (x, y) => (x === 4 && y === 8 ? [9, 9, 9, 128] : y >= 2 && x >= 1 && x < 7 ? DRESS : CLEAR)) }, 'master-not-native'],
        [{ text: await plainPicture() }, 'card-text-invalid'],
        [{ entry: derivedEntry({ text: 'default/content/default_AssistantNone.png' }) }, 'card-text-missing'],
    ];
    for (const [setup, code] of cases) {
        const root = await cardRepo(t, setup);
        const before = readFileSync(join(root, CARD_FILE));
        const run = await quietly(() => runDerive({ root, write: true }));
        assert.deepEqual([codes(run), run.exitCode], [[code], 1], code);
        assert.ok(readFileSync(join(root, CARD_FILE)).equals(before), code);
        assert.equal(readManifest(root).manifest.assets['card-test'].outputs[0].sha256, fakeSha('d'), code);
    }
});

test('check, derive, prove, notice and bump take a card entry in place of a pinned card, and the card keeps the text it shipped with', async (t) => {
    const root = copyOfArt(t, { pinned: true });
    const output = 'default/content/default_AssistantReisen.png';
    const { read } = await loadAppCardParser();
    const shippedText = JSON.parse(read(readFileSync(join(root, output))));
    const masterBytes = await encode(sprite(), 'png');
    writeFileSync(join(root, MASTER_ROOT, 'reisen/card-reisen.png'), masterBytes);
    writeFileSync(join(root, MASTER_ROOT, 'reisen/card-reisen.provenance.json'), `${JSON.stringify({ ...sampleRecord(), file: 'card-reisen.png', sha256: sha256(masterBytes) }, null, 4)}\n`);
    const { manifest } = readManifest(root);
    const pinnedSha = manifest.assets['card-reisen'].outputs[0].sha256;
    manifest.assets['card-reisen'] = derivedEntry({ master: 'reisen/card-reisen.png', text: output, world: 'SillyBunny Lexicon', outputs: [{ path: output, encoding: 'png-card', scale: 4, sha256: pinnedSha }] });
    writeFixtureManifest(root, manifest);

    const derived = await runDerive({ root, write: true, only: ['card-reisen'] });
    assert.deepEqual([codes(derived), derived.result.written], [[], [output]]);
    assert.deepEqual(differences(shippedText, JSON.parse(read(readFileSync(join(root, output))))), [], 'the shipped card links the world already and has no book, so its text is unchanged');

    assert.equal((await runNotice({ root, write: true })).result.written, true);
    const notice = readFileSync(join(root, 'assets-src/art/NOTICE.md'), 'utf8');
    assert.ok(notice.includes('| reisen/card-reisen.png | reisen |'), 'the card master is listed with its record');
    assert.ok(!notice.includes('| card-reisen | 1 |'), 'and the card is no longer a shipped file without a master');
    const bumped = await runBump({ root, write: true, today: '2026-11-18' });
    assert.deepEqual([codes(bumped), bumped.result.bumps], [[], []], 'a card has no cache key');

    const checked = await runCheck({ root });
    assert.deepEqual(codes(checked), []);
    assert.deepEqual([checked.result.summary.derived, checked.result.summary.pinned], [38, 3]);
    assert.equal((await runProve({ root, only: ['card-reisen'] })).exitCode, 0);
});
