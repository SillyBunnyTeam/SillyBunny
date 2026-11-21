import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../scripts/lib/config.mjs';
import { loadEnvironment } from '../scripts/lib/env.mjs';
import { buildRequest, dryRunMasters, generateMasters, formatTable, parseMastersSpec, refsLabel, summarise } from '../scripts/lib/masters.mjs';
import { composePrompt, loadPromptKit } from '../scripts/lib/prompt-kit.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const BRANDING = join(dirname(fileURLToPath(import.meta.url)), '..');
const kit = loadPromptKit(join(BRANDING, 'prompts'));
const config = loadConfig(join(BRANDING, 'config.json'));
const realSpec = parseMastersSpec(JSON.parse(readFileSync(join(BRANDING, 'prompts', 's5-masters.json'), 'utf8')));
const byId = new Map(realSpec.assets.map((asset) => [asset.id, asset]));

const REFS = { 'sheet-reisen': 'refs/a.png', 'sheet-tewi': 'refs/b.png', lineup: 'refs/l.png', 'sprite-reisen': 'refs/sa.png', 'sprite-tewi': 'refs/sb.png' };
const still = (overrides = {}) => ({
    template: 'pixel-still',
    characters: ['reisen'],
    size: '1024x1024',
    aspect: '1:1',
    css: [[96, 96]],
    facing: 'viewer',
    pose: 'standing',
    expression: 'calm',
    props: '',
    ears: 'ears up',
    animated: false,
    refs: ['sheet-reisen', 'lineup', 'sprite-reisen'],
    ...overrides,
});
const spec = (assets) => parseMastersSpec({ refs: REFS, assets });

test('a spec is checked: ids, template, the number of characters, size, aspect, css, facing, text fields and refs', () => {
    for (const [bad, message] of [
        [{ 'Gs Reisen': still() }, /id/],
        [{ a: still({ template: 'pixel-wide' }) }, /template/],
        [{ a: still({ characters: ['reisen', 'tewi'] }) }, /one character/],
        [{ a: still({ template: 'pixel-scene' }) }, /two characters/],
        [{ a: still({ size: '1000x1000' }) }, /multiple of 16/],
        [{ a: still({ size: 'big' }) }, /size/],
        [{ a: still({ aspect: '4:3' }) }, /aspect/],
        [{ a: still({ size: '1536x1024' }) }, /1:1/],
        [{ a: still({ css: [] }) }, /css/],
        [{ a: still({ css: [[96, 48]] }) }, /aspect/],
        [{ a: still({ css: [[400, 400]] }) }, /3x/],
        [{ a: still({ facing: 'left' }) }, /facing/],
        [{ a: still({ pose: '' }) }, /pose/],
        [{ a: still({ ears: 'none' }) }, /ears/],
        [{ a: still({ expression: undefined }) }, /expression/],
        [{ a: still({ refs: ['sheet-reisen', 'lineup'] }) }, /refs/],
        [{ a: still({ refs: ['lineup', 'sheet-reisen', 'sprite-reisen'] }) }, /refs/],
        [{ a: still({ refs: ['sheet-tewi', 'lineup', 'sprite-tewi'] }) }, /refs/],
        [{ a: still({ refs: ['sheet-reisen', 'lineup', 'nothing'] }) }, /nothing/],
        [{ a: still({ extra: 1 }) }, /unknown key "extra"/],
        [{ a: still({ size: '2048x1024', aspect: '2:1', css: [[640, 320]] }) }, /composition/],
        [{}, /at least one/],
    ]) {
        assert.throws(() => spec(bad), message);
    }
    assert.throws(() => parseMastersSpec({ assets: { a: still() }, other: 1, refs: REFS }), /unknown key "other"/);
});

test('a scene needs the two sheets, the line-up and the two sprite masters in that order', () => {
    const scene = { template: 'pixel-scene', characters: ['reisen', 'tewi'], refs: ['sheet-reisen', 'sheet-tewi', 'lineup', 'sprite-reisen', 'sprite-tewi'] };
    assert.equal(spec({ a: still(scene) }).assets[0].refs.length, 5);
    assert.throws(() => spec({ a: still({ ...scene, refs: ['sheet-reisen', 'lineup', 'sprite-reisen'] }) }), /refs/);
    assert.throws(() => spec({ a: still({ ...scene, refs: ['sheet-tewi', 'sheet-reisen', 'lineup', 'sprite-reisen', 'sprite-tewi'] }) }), /refs/);
});

test('a parsed asset has pixel sizes, css sizes and a grid at eight pixels to the cell', () => {
    const [asset] = spec({ a: still({ size: '2048x1024', aspect: '2:1', css: [[640, 320], [320, 160]], composition: 'centred' }) }).assets;
    assert.deepEqual([asset.width, asset.height], [2048, 1024]);
    assert.deepEqual(asset.css, [{ width: 640, height: 320 }, { width: 320, height: 160 }]);
    assert.equal(asset.grid, '256x128');
});

test('the request is the same shape generate.mjs makes: the template, vars, refs, a size and a transparent background', () => {
    const [asset] = spec({ a: still({ props: 'a gift box', composition: '' }) }).assets;
    const request = buildRequest(asset, { rootDir: '/pkg', refs: REFS, n: 2, dryRun: true });
    assert.equal(request.template, 'pixel-still');
    assert.deepEqual(request.characters, ['reisen']);
    assert.deepEqual(request.refPaths, ['/pkg/refs/a.png', '/pkg/refs/l.png', '/pkg/refs/sa.png']);
    assert.equal(request.size, '1024x1024');
    assert.equal(request.aspect, undefined, 'OpenAI takes the shape from the size');
    assert.equal(request.n, 2);
    assert.equal(request.outDir, 'raw/s5/a');
    assert.equal(request.stage, 's5');
    assert.equal(request.background, 'transparent');
    assert.equal(request.dryRun, true);
    assert.deepEqual(request.vars, { pose: 'standing', expression: 'calm', props: 'a gift box', ears: 'ears up', composition: '', direction: 'viewer', grid: '128x128', canvas: 'a square canvas' });
});

test('refs are labelled by kind', () => {
    assert.equal(refsLabel(['sheet-reisen', 'lineup', 'sprite-reisen']), '3: sheet, line-up, sprite');
    assert.equal(refsLabel(['sheet-reisen', 'sheet-tewi', 'lineup', 'sprite-reisen', 'sprite-tewi']), '5: 2 sheets, line-up, 2 sprites');
});

test('the shipped spec has exactly the seventeen slots that still need a master, and not the removed or the finished ones', () => {
    assert.deepEqual([...byId.keys()].sort(), [
        'about-reisen', 'about-tewi', 'empty-tewi', 'extras-tewi', 'gs-reisen', 'gs-reisen-done', 'help-reisen', 'hero-duo', 'hero-duo-night',
        'shortcuts-tewi', 'splash-both', 'splash-reisen', 'splash-tewi', 'troubleshooting-reisen', 'welcome-both', 'welcome-next-reisen', 'welcome-persona-tewi',
    ]);
});

test('every ref of the shipped spec is a file in refs/, and Reisen\'s sprite master is the A concept', () => {
    for (const [name, path] of Object.entries(realSpec.refs)) {
        assert.ok(existsSync(join(BRANDING, path)), `${name}: ${path}`);
        assert.match(path, /^refs\//);
    }
    assert.equal(realSpec.refs['sprite-reisen'], 'refs/reisen-sprite-a.png');
    assert.equal(realSpec.refs['sprite-tewi'], 'refs/tewi-sprite.png');
});

test('the refs are the same pictures as the approved ones, so a ref can never drift from its master', () => {
    for (const name of ['reisen-sprite-a.png', 'reisen-portrait-a.png', 'tewi-sprite.png', 'tewi-portrait.png']) {
        assert.ok(readFileSync(join(BRANDING, 'refs', name)).equals(readFileSync(join(BRANDING, 'approved', name))), name);
    }
});

test('the shapes follow the plan: the hero 2:1, the pairs 3:2, the rest square, and each at 3x of its biggest css size or more', () => {
    const shape = (id) => [byId.get(id).aspect, byId.get(id).size, byId.get(id).css.map(({ width, height }) => `${width}x${height}`).join(',')].join(' ');
    for (const id of ['hero-duo', 'hero-duo-night']) {
        assert.equal(shape(id), '2:1 2048x1024 640x320,320x160');
    }
    for (const id of ['splash-both', 'welcome-both']) {
        assert.equal(shape(id), '3:2 1536x1024 192x128');
    }
    for (const id of ['splash-reisen', 'splash-tewi', 'welcome-persona-tewi', 'welcome-next-reisen']) {
        assert.equal(shape(id), '1:1 1024x1024 128x128');
    }
    for (const id of ['gs-reisen', 'gs-reisen-done', 'help-reisen', 'extras-tewi', 'shortcuts-tewi', 'about-reisen', 'about-tewi', 'troubleshooting-reisen', 'empty-tewi']) {
        assert.equal(shape(id), '1:1 1024x1024 96x96');
    }
});

test('two character slots use pixel-scene and one character slots use pixel-still with the right character', () => {
    for (const id of ['hero-duo', 'hero-duo-night', 'splash-both', 'welcome-both']) {
        assert.equal(byId.get(id).template, 'pixel-scene');
        assert.deepEqual(byId.get(id).characters, ['reisen', 'tewi']);
    }
    for (const asset of realSpec.assets.filter(({ template }) => template === 'pixel-still')) {
        assert.equal(asset.characters.length, 1);
        assert.ok(asset.id.includes(asset.characters[0]), `${asset.id} is drawn as ${asset.characters[0]}`);
    }
});

test('all intro art faces the inline end, the about pair faces the logo between them, and the others face the viewer', () => {
    const inlineEnd = ['welcome-both', 'welcome-persona-tewi', 'welcome-next-reisen', 'gs-reisen', 'gs-reisen-done', 'help-reisen', 'extras-tewi', 'shortcuts-tewi', 'troubleshooting-reisen', 'about-reisen'];
    for (const id of inlineEnd) {
        assert.equal(byId.get(id).facing, 'inline-end', id);
    }
    assert.equal(byId.get('about-tewi').facing, 'inline-start');
    for (const id of ['splash-reisen', 'splash-tewi', 'splash-both', 'hero-duo', 'hero-duo-night', 'empty-tewi']) {
        assert.equal(byId.get(id).facing, 'viewer', id);
    }
});

test('the slots with a named prop or pose have it', () => {
    assert.match(byId.get('hero-duo').pose, /down/);
    assert.match(byId.get('hero-duo-night').pose, /looks up at the moon/);
    assert.match(byId.get('hero-duo-night').props, /full moon/);
    assert.ok(!/moon/i.test(byId.get('hero-duo').props + byId.get('hero-duo').pose), 'the day hero has no moon');
    assert.match(byId.get('troubleshooting-reisen').props, /medicine box/);
    assert.match(byId.get('gs-reisen-done').pose, /cheer|arms raised|victory/i);
    assert.match(byId.get('about-reisen').pose, /right side of the picture/);
    assert.match(byId.get('about-tewi').pose, /left side of the picture/);
});

test('animated slots are the splash, the welcome pair and the heroes, and are stills for now', () => {
    const animated = realSpec.assets.filter(({ animated }) => animated).map(({ id }) => id).sort();
    assert.deepEqual(animated, ['hero-duo', 'hero-duo-night', 'splash-both', 'splash-reisen', 'splash-tewi', 'welcome-both']);
});

test('every slot has a pose and an ears line that keeps the ears expressive', () => {
    for (const { id, pose, ears } of realSpec.assets) {
        assert.ok(pose.length > 40, `${id} pose`);
        assert.match(ears, /ear/i, id);
        assert.ok(ears.length > 40, `${id} ears`);
    }
});

test('every slot composes into a prompt that states its canvas shape and grid, and no unresolved placeholder', () => {
    const shapes = { '1:1': /a square canvas/, '3:2': /a 3:2 landscape canvas/, '2:1': /a wide 2:1 landscape canvas/ };
    for (const asset of realSpec.assets) {
        const request = buildRequest(asset, { rootDir: BRANDING, refs: realSpec.refs, n: 1, dryRun: true });
        const { prompt, status } = composePrompt(kit, request.template, { vars: request.vars, characters: request.characters, refCount: request.refPaths.length });
        assert.equal(status, 'ready');
        assert.ok(!/\{[a-z_]+\}/.test(prompt), asset.id);
        assert.match(prompt, shapes[asset.aspect], asset.id);
        assert.ok(prompt.includes(`${asset.grid} pixel grid`), asset.id);
        assert.match(prompt, /centred and fills most of the canvas|Composition: /, asset.id);
    }
});

test('prompts for non square slots carry a composition line, and square ones need none', () => {
    for (const asset of realSpec.assets.filter(({ aspect }) => aspect !== '1:1')) {
        assert.ok(asset.composition.length > 40, asset.id);
    }
});

test('the dry run covers every slot, prices them from the config, sends nothing, writes nothing, and returns the prompts', async () => {
    const lines = [];
    const deps = {
        rootDir: BRANDING,
        config,
        kit,
        env: loadEnvironment({ env: {} }),
        fetchImpl: async () => {
            throw new Error('a dry run must not touch the network');
        },
        print: (line) => lines.push(line),
        confirm: async () => false,
        now: () => new Date('2026-11-01T12:00:00.000Z'),
    };
    const rows = await dryRunMasters({ spec: realSpec, deps, only: undefined });
    assert.equal(rows.length, 17);
    assert.ok(rows.every((row) => row.perImageUsd === 0.2));
    assert.ok(rows.every((row) => row.prompt.includes('Sticker edge')));
    assert.equal(lines.length, 0, 'the dry run prints through the caller, not the deps');
    const hero = rows.find(({ id }) => id === 'hero-duo');
    assert.equal(hero.size, '2048x1024');
    assert.match(hero.prompt, /256x128 pixel grid/);
    const only = await dryRunMasters({ spec: realSpec, deps, only: ['empty-tewi'] });
    assert.deepEqual(only.map(({ id }) => id), ['empty-tewi']);
    await assert.rejects(dryRunMasters({ spec: realSpec, deps, only: ['row-nahida'] }), /row-nahida/);
});

test('the summary totals one image and two images per slot, and says whether the batch passes the cap', () => {
    const rows = [{ perImageUsd: 0.2 }, { perImageUsd: 0.2 }, { perImageUsd: 0.2 }];
    const result = summarise(rows, { runningUsd: 13.8454, capUsd: 20 });
    assert.deepEqual([result.oneEach.totalUsd, result.twoEach.totalUsd], [0.6, 1.2]);
    assert.equal(result.oneEach.withinCap, true);
    assert.equal(result.twoEach.projectedUsd, 15.0454);
    const tight = summarise(rows, { runningUsd: 19.0, capUsd: 20 });
    assert.deepEqual([tight.oneEach.withinCap, tight.twoEach.withinCap], [true, false]);
});

test('the table has one line per slot with id, size, aspect, refs and cost', () => {
    const rows = [
        { id: 'a', size: '1024x1024', aspect: '1:1', refs: ['sheet-reisen', 'lineup', 'sprite-reisen'], perImageUsd: 0.2 },
        { id: 'hero', size: '2048x1024', aspect: '2:1', refs: ['sheet-reisen', 'sheet-tewi', 'lineup', 'sprite-reisen', 'sprite-tewi'], perImageUsd: 0.2 },
    ];
    const lines = formatTable(rows);
    assert.match(lines[0], /id\s+size\s+aspect\s+refs\s+cost/);
    assert.match(lines.at(-2), /^a\s+1024x1024\s+1:1\s+3: sheet, line-up, sprite\s+\$0\.20$/);
    assert.match(lines.at(-1), /^hero\s+2048x1024\s+2:1\s+5: 2 sheets, line-up, 2 sprites\s+\$0\.20$/);
});

const KEY = 'sk-test-0123456789abcdefABCDEF';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('a real run sends one request per slot through the usual run, logs it under stage s5, and saves under raw/s5/<id>/', async () => {
    const root = tempDir('sb-masters-');
    mkdirSync(join(root, 'log'));
    mkdirSync(join(root, 'refs'));
    for (const path of Object.values(REFS)) {
        writeFileSync(join(root, path), PNG);
    }
    const calls = [];
    const deps = {
        rootDir: root,
        config,
        kit,
        env: loadEnvironment({ env: { OPENAI_API_KEY: KEY } }),
        fetchImpl: async (url, init) => {
            calls.push({ url: String(url), init });
            return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
        },
        print: () => {},
        confirm: async () => false,
        now: () => new Date('2026-11-01T12:00:00.000Z'),
    };
    await generateMasters({ spec: spec({ a: still(), b: still({ pose: 'sitting' }) }), deps, only: ['a'], n: 1, yes: true });
    assert.equal(calls.length, 1);
    const [entry] = readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entry.stage, 's5');
    assert.equal(entry.template, 'pixel-still');
    assert.equal(entry.refs.length, 3);
    assert.equal(readdirSync(join(root, 'raw', 's5', 'a')).filter((name) => name.endsWith('.png')).length, 1);
    await assert.rejects(generateMasters({ spec: spec({ a: still() }), deps, only: ['b'], n: 1, yes: true }), /"b" is not in the spec/);
});
