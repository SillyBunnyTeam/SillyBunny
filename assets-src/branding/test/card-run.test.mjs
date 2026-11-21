import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadAppCardParser, differences } from '../scripts/lib/card-meta.mjs';
import { runBuildCards } from '../scripts/lib/card-run.mjs';
import { readLog, sha256 } from '../scripts/lib/log.mjs';
import { writeRaster } from '../scripts/lib/raster.mjs';
import { fixtureCard } from '../test-support/card-fixture.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';
import { waistSprite } from '../test-support/waist-sprite.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'build-card.mjs');
const REAL_CONFIG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'card-config.json'), 'utf8'));
const NOW = () => new Date('2026-11-02T12:00:00.000Z');

/**
 * A package root with the real card-config.json (a smaller canvas, so the test is quick) and fixture art for two cards, a folder of fixture card
 * files, and a repository root with a default/content/ that already has an index.json.
 */
async function workspace() {
    const rootDir = tempDir('sb-card-');
    const repoRoot = tempDir('sb-card-repo-');
    const cardDir = tempDir('sb-card-files-');
    const config = structuredClone(REAL_CONFIG);
    config.canvas = { width: 192, height: 288 };
    config.sprite.sideMargin = 4;
    config.sprite.topMargin = 4;
    config.avatar.sizes = [32, 16];
    writeFileSync(join(rootDir, 'card-config.json'), JSON.stringify(config));
    mkdirSync(join(rootDir, 'approved'), { recursive: true });
    mkdirSync(join(repoRoot, 'default', 'content'), { recursive: true });
    writeFileSync(join(repoRoot, 'default', 'content', 'index.json'), '[{"filename":"settings.json","type":"settings"}]\n');
    const cards = { reisen: fixtureCard({ name: 'Fixture Reisen' }), tewi: fixtureCard({ name: 'Fixture Tewi', book: true }) };
    for (const [id, card] of Object.entries(cards)) {
        await writeRaster(join(rootDir, config.cards[id].art), waistSprite({ earReach: id === 'reisen' ? 30 : 12 }));
        writeFileSync(join(cardDir, config.cards[id].cardFile), JSON.stringify(card, null, 4));
    }
    return { rootDir, repoRoot, cardDir, cards, config, logPath: join(rootDir, 'log', 'generations.jsonl') };
}

const request = (space, extra = {}) => ({ rootDir: space.rootDir, repoRoot: space.repoRoot, cardDir: space.cardDir, mode: 'dry-run', now: NOW, ...extra });
const snapshot = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).sort() : []);

test('a dry run builds and checks both cards in memory and writes nothing: no card, no preview, no log', async () => {
    const space = await workspace();
    const { built, previews, written } = await runBuildCards(request(space));
    assert.deepEqual(built.map(({ id }) => id), ['reisen', 'tewi']);
    assert.deepEqual([previews, written], [[], []]);
    assert.deepEqual(snapshot(join(space.repoRoot, 'default', 'content')), ['index.json']);
    assert.equal(existsSync(join(space.rootDir, 'out')), false);
    assert.equal(existsSync(space.logPath), false);
    assert.deepEqual(built[0].chunks, ['chara', 'ccv3']);
    assert.deepEqual(built[1].edits.map(({ path }) => path), ['data.extensions.world', 'data.character_book']);
});

test('a preview writes the card and the avatar crops (square and circle, each size) under out/cards/ and logs nothing', async () => {
    const space = await workspace();
    const { previews, written } = await runBuildCards(request(space, { mode: 'preview' }));
    assert.deepEqual(written, []);
    assert.deepEqual(snapshot(join(space.repoRoot, 'default', 'content')), ['index.json'], 'default/content/ is not written by a preview');
    assert.equal(existsSync(space.logPath), false);
    const names = readdirSync(join(space.rootDir, 'out', 'cards')).sort();
    assert.deepEqual(names, [
        'AssistantReisen-16-circle.png', 'AssistantReisen-16-square.png', 'AssistantReisen-32-circle.png', 'AssistantReisen-32-square.png', 'AssistantReisen-avatars.png',
        'AssistantTewi-16-circle.png', 'AssistantTewi-16-square.png', 'AssistantTewi-32-circle.png', 'AssistantTewi-32-square.png', 'AssistantTewi-avatars.png',
        'default_AssistantReisen.png', 'default_AssistantTewi.png',
    ]);
    assert.equal(previews.length, 12);
    const circle = await sharp(join(space.rootDir, 'out', 'cards', 'AssistantReisen-32-circle.png')).metadata();
    assert.deepEqual([circle.width, circle.height, circle.hasAlpha], [32, 32, true]);
});

test('a build writes default/content/default_Assistant<Name>.png that the app\'s parser reads field for field, and leaves index.json alone', async () => {
    const space = await workspace();
    const indexBefore = readFileSync(join(space.repoRoot, 'default', 'content', 'index.json'));
    const { written } = await runBuildCards(request(space, { mode: 'build', stage: 's5' }));
    assert.deepEqual(written, ['default/content/default_AssistantReisen.png', 'default/content/default_AssistantTewi.png']);
    assert.deepEqual(snapshot(join(space.repoRoot, 'default', 'content')), ['default_AssistantReisen.png', 'default_AssistantTewi.png', 'index.json']);
    assert.ok(readFileSync(join(space.repoRoot, 'default', 'content', 'index.json')).equals(indexBefore));
    const { read } = await loadAppCardParser();
    for (const [id, file] of [['reisen', 'default_AssistantReisen.png'], ['tewi', 'default_AssistantTewi.png']]) {
        const bytes = readFileSync(join(space.repoRoot, 'default', 'content', file));
        const parsed = JSON.parse(read(bytes));
        const source = space.cards[id];
        const changed = differences(source, parsed).map(({ path }) => path).filter((path) => !path.startsWith('data.character_book'));
        assert.deepEqual(changed, ['data.extensions.world'], 'only world differs from the card file');
        assert.equal(parsed.data.extensions.world, 'SillyBunny Lexicon');
        assert.equal('character_book' in parsed.data, false);
        assert.equal(JSON.stringify(parsed.data.description), JSON.stringify(source.data.description));
        const meta = await sharp(bytes).metadata();
        assert.deepEqual([meta.width, meta.height, meta.hasAlpha], [192, 288, false]);
    }
});

test('a build logs one local build-card line per card with the art\'s sha256 in refs, and never the card text or its folder', async () => {
    const space = await workspace();
    await runBuildCards(request(space, { mode: 'build', stage: 's5' }));
    const entries = readLog(space.logPath);
    assert.equal(entries.length, 2);
    const [reisen] = entries;
    assert.deepEqual([reisen.provider, reisen.model, reisen.template, reisen.stage, reisen.estimatedUsd, reisen.approved], ['local', 'build-card', 'build-card', 's5', 0, false]);
    assert.deepEqual(reisen.refs, [sha256(readFileSync(join(space.rootDir, 'approved', 'card-reisen.png')))]);
    assert.equal(reisen.size, '192x288');
    assert.deepEqual(reisen.outputs, [{ file: 'default/content/default_AssistantReisen.png', sha256: sha256(readFileSync(join(space.repoRoot, 'default', 'content', 'default_AssistantReisen.png'))) }]);
    assert.equal(reisen.vars.card.name, 'Assistant Reisen.json');
    assert.equal(reisen.vars.card.sha256, sha256(readFileSync(join(space.cardDir, 'Assistant Reisen.json'))));
    assert.equal(reisen.vars.world, 'SillyBunny Lexicon');
    assert.deepEqual(reisen.vars.chunks, ['chara', 'ccv3']);
    assert.equal(reisen.vars.art, 'approved/card-reisen.png');
    const line = readFileSync(space.logPath, 'utf8');
    assert.ok(!line.includes('Fixture Reisen') && !line.includes('test rabbit') && !line.includes(space.cardDir), 'no card text and no private folder reaches the log');
});

test('a build with no stage, an unknown card, a missing card file or art, or a card that is not V3 writes nothing', async () => {
    const space = await workspace();
    await assert.rejects(runBuildCards(request(space, { mode: 'build' })), /Pass --stage/);
    await assert.rejects(runBuildCards(request(space, { mode: 'build', stage: 's5', only: ['nahida'] })), /"nahida" is not a card in card-config\.json\. It has: reisen, tewi/);
    writeFileSync(join(space.cardDir, 'Assistant Tewi.json'), JSON.stringify({ ...space.cards.tewi, spec: 'chara_card_v2' }));
    await assert.rejects(runBuildCards(request(space, { mode: 'build', stage: 's5' })), /tewi: The card file is not a V3 card.* Nothing was written\./);
    writeFileSync(join(space.cardDir, 'Assistant Tewi.json'), '{ not json');
    await assert.rejects(runBuildCards(request(space, { mode: 'build', stage: 's5' })), /tewi: the card file Assistant Tewi\.json is not JSON/);
    writeFileSync(join(space.cardDir, 'Assistant Tewi.json'), JSON.stringify(space.cards.tewi));
    await assert.rejects(runBuildCards(request(space, { mode: 'build', stage: 's5', cardDir: join(space.cardDir, 'nowhere') })), /the card file .* does not exist/);
    mkdirSync(join(space.rootDir, 'approved'), { recursive: true });
    writeFileSync(join(space.rootDir, 'approved', 'card-tewi.png'), 'not a png');
    await assert.rejects(runBuildCards(request(space, { mode: 'build', stage: 's5' })), /not a PNG, JPEG or WebP/);
    assert.deepEqual(snapshot(join(space.repoRoot, 'default', 'content')), ['index.json'], 'the good card (reisen) was not written either');
    assert.equal(existsSync(space.logPath), false);
    assert.equal(existsSync(join(space.rootDir, 'out')), false);
});

test('--only with no card, or with a card twice, is refused before anything is built, written or logged', async () => {
    const space = await workspace();
    await assert.rejects(runBuildCards(request(space, { mode: 'build', stage: 's5', only: [] })), /--only names no card\. card-config\.json has: reisen, tewi/);
    await assert.rejects(runBuildCards(request(space, { mode: 'build', stage: 's5', only: ['reisen', 'tewi', 'reisen'] })), /--only names reisen more than once, which would build and log the card twice/);
    assert.deepEqual(snapshot(join(space.repoRoot, 'default', 'content')), ['index.json']);
    assert.equal(existsSync(space.logPath), false);
});

test('a card file without the root-level fields the app mirrors from data is refused, because the app adds them and the card would not read back as the file', async () => {
    const space = await workspace();
    const { spec, spec_version: version, data } = space.cards.reisen;
    writeFileSync(join(space.cardDir, 'Assistant Reisen.json'), JSON.stringify({ spec, spec_version: version, data }));
    await assert.rejects(runBuildCards(request(space, { mode: 'build', stage: 's5', only: ['reisen'] })), /reisen: The built card does not read back as the card it was made from:[\s\S]*ccv3 chunk: name is "Fixture Reisen", expected undefined[\s\S]*Nothing was written\./);
    assert.deepEqual(snapshot(join(space.repoRoot, 'default', 'content')), ['index.json']);
    assert.equal(existsSync(space.logPath), false);
});

test('an existing card in default/content/ is never replaced unless --overwrite is passed, and then nothing is half written', async () => {
    const space = await workspace();
    await runBuildCards(request(space, { mode: 'build', stage: 's5', only: ['reisen'] }));
    const first = readFileSync(join(space.repoRoot, 'default', 'content', 'default_AssistantReisen.png'));
    await assert.rejects(runBuildCards(request(space, { mode: 'build', stage: 's5' })), /default\/content\/default_AssistantReisen\.png already exists; pass --overwrite to replace it\. Nothing was written\./);
    assert.equal(existsSync(join(space.repoRoot, 'default', 'content', 'default_AssistantTewi.png')), false, 'tewi was not written beside the refused reisen');
    assert.equal(readLog(space.logPath).length, 1);
    writeFileSync(join(space.cardDir, 'Assistant Reisen.json'), JSON.stringify({ ...space.cards.reisen, data: { ...space.cards.reisen.data, nickname: 'Changed' } }));
    await runBuildCards(request(space, { mode: 'build', stage: 's5', overwrite: true }));
    assert.ok(!readFileSync(join(space.repoRoot, 'default', 'content', 'default_AssistantReisen.png')).equals(first));
    const lines = readLog(space.logPath);
    assert.deepEqual(lines.map(({ vars }) => vars.id), ['reisen', 'reisen', 'tewi']);
    assert.equal(lines[0].vars.replaces, undefined, 'a first build replaces nothing');
    assert.equal(lines[1].vars.replaces, sha256(first), 'the new line names the file it replaced');
    assert.equal(lines[2].vars.replaces, undefined, 'tewi was new');
});

test('building the same inputs again gives the same bytes', async () => {
    const space = await workspace();
    const one = await runBuildCards(request(space));
    const two = await runBuildCards(request(space));
    assert.ok(one.built.every(({ png }, index) => png.equals(two.built[index].png)));
});

test('build-card.mjs refuses a call with no folder, with no mode or with two, and names a missing card file, writing nothing', () => {
    const run = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    assert.match(run().stderr, /Usage: build-card\.mjs --card-dir/);
    assert.match(run('--card-dir', '/nonexistent-card-folder').stderr, /Pass one of --dry-run, --preview and --stage/);
    assert.match(run('--card-dir', '/nonexistent-card-folder', '--dry-run', '--preview').stderr, /Pass one of/);
    const missing = run('--card-dir', '/nonexistent-card-folder', '--dry-run', '--only', 'reisen');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /reisen: the card file .*Assistant Reisen\.json does not exist\. Nothing was written\./);
    for (const mode of ['--dry-run', '--preview']) {
        const replacing = run('--card-dir', '/nonexistent-card-folder', mode, '--overwrite');
        assert.notEqual(replacing.status, 0);
        assert.match(replacing.stderr, /--overwrite replaces a card in default\/content\/, which only a build \(--stage\) writes/, mode);
    }
    for (const stage of ['five', 's', 's5/../x', '5']) {
        assert.match(run('--card-dir', '/nonexistent-card-folder', '--stage', stage).stderr, new RegExp(`--stage must be a stage such as s5, got "${stage.replace(/[./]/g, '\\$&')}"`));
    }
});
