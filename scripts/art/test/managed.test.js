import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadAppCardParser } from '../lib/card.js';
import { encode } from '../lib/codec.js';
import { runBump, runCheck, runDerive, runProve } from '../lib/commands.js';
import { managedItemsOf, managedProblems } from '../lib/managed.js';
import { MANIFEST_PATH, MASTER_ROOT, readManifest } from '../lib/manifest.js';
import { sha256 } from '../lib/raster.js';
import { REISEN_CARD, cardSprite, copyWithDerivedCard } from '../test-support/card-copy.js';
import { REPO_ROOT } from '../test-support/pictures.js';

const MANAGED = 'default/content/sillybunny-managed.json';
const APP_MANAGED = new URL('../../../src/sillybunny-managed-content.js', import.meta.url);
const codes = (run) => run.result.problems.map(({ code }) => code);
const managedCodes = (run) => codes(run).filter((code) => code.startsWith('managed-'));
const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const itemOf = (managed, filename) => managed.items.find((item) => item.filename === filename);

test('the art of the checkout ships no managed item from a derived entry, so check and bump leave the managed content alone', async () => {
    const { manifest } = readManifest(REPO_ROOT);

    assert.deepEqual(managedItemsOf(manifest), []);
    assert.deepEqual(await managedProblems(REPO_ROOT, manifest), []);
    assert.deepEqual((await runBump({ root: REPO_ROOT })).result.managed, []);
});

test('a derived card that changed is a problem for check, and bump --write raises its version by the app\'s own rules and writes it into the card', async (t) => {
    const root = await copyWithDerivedCard(t);
    const before = readJson(root, MANAGED);
    assert.deepEqual(managedCodes(await runCheck({ root })), [], 'the card file is still the shipped one');

    await runDerive({ root, write: true, only: ['card-reisen'] });

    const stale = (await runCheck({ root })).result.problems.filter(({ code }) => code.startsWith('managed-'));
    assert.deepEqual(stale.map(({ code, asset, path }) => [code, asset, path]), [['managed-stale', 'card-reisen', REISEN_CARD]]);
    assert.match(stale[0].message, /^default\/content\/sillybunny-managed\.json records version 1 of default_AssistantReisen\.png with another fingerprint than the file has now, so installs that hold version 1 would never get this one\. Run node scripts\/art\/cli\.js bump --write, which raises it to version 2 and writes that version into the card's character_version\.$/);
    const planned = await runBump({ root });
    assert.deepEqual([codes(planned), planned.result.managed], [[], [{ asset: 'card-reisen', item: 'default_AssistantReisen.png', type: 'character', from: 1, to: 2 }]]);
    assert.deepEqual(readJson(root, MANAGED), before, 'a bump without --write writes nothing');

    const bumped = await runBump({ root, write: true });

    assert.deepEqual([codes(bumped), bumped.result.written], [[], [REISEN_CARD, MANAGED]]);
    const after = readJson(root, MANAGED);
    const [was, now] = [itemOf(before, 'default_AssistantReisen.png'), itemOf(after, 'default_AssistantReisen.png')];
    assert.deepEqual([now.version, now.previousFingerprints], [2, [was.fingerprint, ...was.previousFingerprints]], 'the earlier fingerprint is kept, so an untouched copy of version 1 is updated');
    assert.notEqual(now.fingerprint, was.fingerprint);
    assert.deepEqual(after.items.filter(({ filename }) => filename !== now.filename), before.items.filter(({ filename }) => filename !== now.filename));
    const { read } = await loadAppCardParser();
    assert.equal(JSON.parse(read(readFileSync(join(root, REISEN_CARD)))).data.character_version, '2.0');
    const app = await import(APP_MANAGED.href);
    const folder = join(root, 'default/content');
    const recorded = app.readManifest(folder);
    assert.deepEqual(app.buildManifest({ bundledDirectory: folder, entries: recorded.items.map(({ filename, type }) => ({ filename, type })), previous: recorded }), recorded, 'the app\'s own build changes nothing, as its shipped-content test requires');
    assert.equal(readManifest(root).manifest.assets['card-reisen'].outputs[0].sha256, sha256(readFileSync(join(root, REISEN_CARD))), 'the art manifest records the card with its new version');

    assert.deepEqual((await runDerive({ root, write: true, only: ['card-reisen'] })).result.written, [], 'the derive gives the card with its new version');
    assert.equal((await runProve({ root, only: ['card-reisen'] })).exitCode, 0);
    assert.equal((await runProve({ root, only: ['card-reisen'], pixels: true })).exitCode, 0);
    assert.deepEqual(managedCodes(await runCheck({ root })), []);
    assert.deepEqual((await runBump({ root })).result.managed, [], 'a second bump has nothing to raise');
});

test('bump --write refuses a card file that its entry does not derive, and a changed item that the art manifest does not ship, and writes nothing', async (t) => {
    const underived = await copyWithDerivedCard(t);
    await runDerive({ root: underived, write: true, only: ['card-reisen'] });
    writeFileSync(join(underived, MASTER_ROOT, 'reisen/card-reisen.png'), await encode(cardSprite([30, 30, 90, 255]), 'png'));
    const unchanged = [readFileSync(join(underived, REISEN_CARD)), readFileSync(join(underived, MANAGED))];

    const refused = await runBump({ root: underived, write: true });

    assert.deepEqual(codes(refused), ['managed-underived']);
    assert.match(refused.result.problems[0].message, /is not the file its entry derives, so its new version cannot be written into it\. Run node scripts\/art\/cli\.js derive --write first\.$/);
    assert.ok(readFileSync(join(underived, REISEN_CARD)).equals(unchanged[0]) && readFileSync(join(underived, MANAGED)).equals(unchanged[1]));

    const unrelated = await copyWithDerivedCard(t);
    await runDerive({ root: unrelated, write: true, only: ['card-reisen'] });
    const sprite = join(unrelated, 'default/content/Assistant Tewi/joy.webp');
    writeFileSync(sprite, Buffer.concat([readFileSync(sprite), Buffer.from([0])]));
    const card = readFileSync(join(unrelated, REISEN_CARD));
    const manifestText = readFileSync(join(unrelated, MANIFEST_PATH));

    const mixed = await runBump({ root: unrelated, write: true });

    assert.deepEqual(codes(mixed), ['managed-unrelated']);
    assert.match(mixed.result.problems[0].message, /^Assistant Tewi changed since the versions default\/content\/sillybunny-managed\.json records, and the art manifest does not ship them\./);
    assert.ok(readFileSync(join(unrelated, REISEN_CARD)).equals(card), 'the card file is put back');
    assert.ok(readFileSync(join(unrelated, MANIFEST_PATH)).equals(manifestText));
});

test('a derived card that the managed manifest does not hold is a problem that says how to add it', async (t) => {
    const root = await copyWithDerivedCard(t);
    const managed = readJson(root, MANAGED);
    managed.items = managed.items.filter(({ filename }) => filename !== 'default_AssistantReisen.png');
    writeFileSync(join(root, MANAGED), `${JSON.stringify(managed, null, 4)}\n`);

    const problems = (await runCheck({ root })).result.problems.filter(({ code }) => code.startsWith('managed-'));

    assert.deepEqual(problems.map(({ code }) => code), ['managed-missing']);
    assert.match(problems[0].message, /does not manage it as a character\. Add it with node scripts\/build-managed-manifest\.js default\/content character:default_AssistantReisen\.png, and seed it in default\/content\/index\.json\.$/);
    assert.deepEqual(codes(await runBump({ root, write: true })), ['managed-missing']);
});
