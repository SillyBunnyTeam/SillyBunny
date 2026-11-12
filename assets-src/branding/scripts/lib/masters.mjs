import { join, resolve } from 'node:path';
import { readLog, runningTotalUsd } from './log.mjs';
import { runGeneration, usd } from './run.mjs';

const SPEC_KEYS = new Set(['refs', 'assets']);
const ASSET_KEYS = new Set(['template', 'characters', 'size', 'aspect', 'css', 'facing', 'pose', 'expression', 'props', 'ears', 'composition', 'animated', 'refs']);
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const CHARACTERS_PER_TEMPLATE = { 'pixel-still': 1, 'pixel-scene': 2 };
const FACINGS = ['viewer', 'inline-end', 'inline-start'];
const ASPECTS = {
    '1:1': { ratio: [1, 1], canvas: 'a square canvas' },
    '3:2': { ratio: [3, 2], canvas: 'a 3:2 landscape canvas' },
    '2:1': { ratio: [2, 1], canvas: 'a wide 2:1 landscape canvas' },
};
// The approved masters were drawn at eight output pixels to the grid cell; every slot keeps that look.
const CELL = 8;
// A 3x screen shows a master 1:1 only when the master has at least that many pixels, and the export refuses to enlarge.
const LARGEST_DENSITY = 3;
const OPENAI_MULTIPLE = 16;
const REF_LABELS = { sheet: ['sheet', 'sheets'], lineup: ['line-up', 'line-ups'], sprite: ['sprite', 'sprites'] };

/** The fields whose text reaches the model; the prompt kit's name guard checks these. */
export const SENT_TEXT_FIELDS = ['pose', 'expression', 'props', 'ears', 'composition'];

const isNonEmptyText = (value) => typeof value === 'string' && value.trim().length > 0;
const isWholePositive = (value) => Number.isInteger(value) && value >= 1;

/**
 * Parses the S5 masters spec: `{ refs: { name: path }, assets: { "<id>": { template, characters, size, aspect, css, facing, pose,
 * expression, props, ears, composition, animated, refs } } }`. `refs` on an asset lists names from the top level `refs`, in the
 * order the template's reference paragraph describes the attached images.
 * @param {any} raw
 */
export function parseMastersSpec(raw) {
    for (const key of Object.keys(raw ?? {})) {
        if (!SPEC_KEYS.has(key)) {
            throw new Error(`Masters spec: unknown key "${key}". Known keys: ${[...SPEC_KEYS].join(', ')}.`);
        }
    }
    const refs = raw.refs ?? {};
    for (const [name, path] of Object.entries(refs)) {
        if (!isNonEmptyText(path)) {
            throw new Error(`Masters spec: ref "${name}" needs a file path.`);
        }
    }
    const entries = Object.entries(raw.assets ?? {});
    if (entries.length === 0) {
        throw new Error('Masters spec: assets needs at least one asset.');
    }
    return { refs, assets: entries.map(([id, asset]) => parseAsset(id, asset, refs)) };
}

function parseAsset(id, asset, refRegistry) {
    const fail = (message) => {
        throw new Error(`Masters spec, asset "${id}": ${message}`);
    };
    if (!ID_PATTERN.test(id)) {
        throw new Error(`Masters spec: asset id "${id}" must be lowercase letters, digits and hyphens.`);
    }
    for (const key of Object.keys(asset)) {
        if (!ASSET_KEYS.has(key)) {
            fail(`unknown key "${key}". Known keys: ${[...ASSET_KEYS].join(', ')}.`);
        }
    }
    const expected = CHARACTERS_PER_TEMPLATE[asset.template];
    if (!expected) {
        fail(`template must be one of ${Object.keys(CHARACTERS_PER_TEMPLATE).join(', ')}, got "${asset.template}".`);
    }
    if (!Array.isArray(asset.characters) || asset.characters.length !== expected) {
        fail(`${asset.template} needs ${expected === 1 ? 'one character' : 'two characters'}.`);
    }

    const { width, height } = parseSize(asset.size, fail);
    const shape = ASPECTS[asset.aspect];
    if (!shape) {
        fail(`aspect must be one of ${Object.keys(ASPECTS).join(', ')}, got "${asset.aspect}".`);
    }
    const hasShape = (w, h) => w * shape.ratio[1] === h * shape.ratio[0];
    if (!hasShape(width, height)) {
        fail(`size ${asset.size} is not ${asset.aspect}.`);
    }
    const css = parseCss(asset.css, { hasShape, aspect: asset.aspect, width, fail });

    if (!FACINGS.includes(asset.facing)) {
        fail(`facing must be one of ${FACINGS.join(', ')}, got "${asset.facing}".`);
    }
    for (const field of ['pose', 'expression', 'ears']) {
        if (!isNonEmptyText(asset[field])) {
            fail(`${field} is required.`);
        }
    }
    if (!/ear/i.test(asset.ears)) {
        fail('the ears line must describe the ears.');
    }
    if (asset.aspect !== '1:1' && !isNonEmptyText(asset.composition)) {
        fail(`a ${asset.aspect} canvas needs a composition line.`);
    }
    if (typeof asset.animated !== 'boolean') {
        fail('animated must be true or false.');
    }
    const needed = expectedRefs(asset.template, asset.characters);
    const refs = asset.refs ?? [];
    for (const name of refs) {
        if (!(name in refRegistry)) {
            fail(`ref "${name}" is not in the top level refs.`);
        }
    }
    if (refs.join() !== needed.join()) {
        fail(`refs must be ${needed.join(', ')} in that order, got ${refs.join(', ') || 'none'}.`);
    }
    return {
        id,
        template: asset.template,
        characters: asset.characters,
        size: asset.size,
        width,
        height,
        aspect: asset.aspect,
        grid: `${width / CELL}x${height / CELL}`,
        css,
        facing: asset.facing,
        pose: asset.pose,
        expression: asset.expression,
        props: asset.props ?? '',
        ears: asset.ears,
        composition: asset.composition ?? '',
        animated: asset.animated,
        refs,
    };
}

function parseSize(size, fail) {
    const match = /^(\d+)x(\d+)$/.exec(String(size));
    if (!match) {
        fail(`size must read WIDTHxHEIGHT, got "${size}".`);
    }
    const [width, height] = [Number(match[1]), Number(match[2])];
    if (width % OPENAI_MULTIPLE || height % OPENAI_MULTIPLE) {
        fail(`size ${size}: width and height must each be a multiple of ${OPENAI_MULTIPLE}.`);
    }
    return { width, height };
}

function parseCss(css, { hasShape, aspect, width, fail }) {
    if (!Array.isArray(css) || css.length === 0 || !css.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every(isWholePositive))) {
        fail('css must be a list of [width, height] CSS sizes, such as [[96, 96]].');
    }
    return css.map(([cssWidth, cssHeight]) => {
        if (!hasShape(cssWidth, cssHeight)) {
            fail(`css size ${cssWidth}x${cssHeight} does not have the asset's aspect ${aspect}.`);
        }
        if (cssWidth * LARGEST_DENSITY > width) {
            fail(`css width ${cssWidth} at ${LARGEST_DENSITY}x needs ${cssWidth * LARGEST_DENSITY} pixels but the master is ${width} wide.`);
        }
        return { width: cssWidth, height: cssHeight };
    });
}

/** The attached images each template describes, in order. */
function expectedRefs(template, characters) {
    const [first, second] = characters;
    return template === 'pixel-still'
        ? [`sheet-${first}`, 'lineup', `sprite-${first}`]
        : [`sheet-${first}`, `sheet-${second}`, 'lineup', `sprite-${first}`, `sprite-${second}`];
}

/** @returns {import('./run.mjs').GenerationRequest} */
export function buildRequest(asset, { rootDir, refs, n, dryRun }) {
    return {
        template: asset.template,
        characters: asset.characters,
        vars: {
            pose: asset.pose,
            expression: asset.expression,
            props: asset.props,
            ears: asset.ears,
            composition: asset.composition,
            direction: asset.facing,
            grid: asset.grid,
            canvas: ASPECTS[asset.aspect].canvas,
        },
        refPaths: asset.refs.map((name) => resolve(rootDir, refs[name])),
        size: asset.size,
        n,
        outDir: join('raw', 's5', asset.id),
        stage: 's5',
        background: 'transparent',
        dryRun,
        yes: false,
        allowStub: false,
        allowUnlocked: false,
        balance: false,
    };
}

function chooseAssets(spec, only) {
    for (const id of only ?? []) {
        if (!spec.assets.some((asset) => asset.id === id)) {
            throw new Error(`"${id}" is not in the spec. It has: ${spec.assets.map((asset) => asset.id).join(', ')}.`);
        }
    }
    return only ? spec.assets.filter((asset) => only.includes(asset.id)) : spec.assets;
}

/**
 * Prices and composes every chosen slot with the real run in dry-run mode: nothing is sent, saved or logged.
 * @param {{ spec: ReturnType<typeof parseMastersSpec>, deps: import('./run.mjs').RunDeps, only?: string[], n?: number }} options
 */
export async function dryRunMasters({ spec, deps, only, n = 1 }) {
    const rows = [];
    for (const asset of chooseAssets(spec, only)) {
        const request = buildRequest(asset, { rootDir: deps.rootDir, refs: spec.refs, n, dryRun: true });
        const outcome = await runGeneration(request, { ...deps, print: () => {} });
        rows.push({ id: asset.id, size: asset.size, aspect: asset.aspect, refs: asset.refs, perImageUsd: outcome.batch.perImageUsd, prompt: outcome.prompt });
    }
    return rows;
}

/** Sends the chosen slots one after another through the usual run, which asks before each batch and stops at the cap. */
export async function generateMasters({ spec, deps, only, n, yes }) {
    for (const asset of chooseAssets(spec, only)) {
        const request = buildRequest(asset, { rootDir: deps.rootDir, refs: spec.refs, n, dryRun: false });
        const outcome = await runGeneration({ ...request, yes }, deps);
        if (outcome.partial) {
            throw new Error(`${asset.id} stopped early; the remaining slots were not started.`);
        }
    }
}

const roundUsd = (value) => Math.round(value * 1e6) / 1e6;

/** Totals for one image and for two images per slot, with whether the whole batch fits under the cost cap. */
export function summarise(rows, { runningUsd, capUsd }) {
    const perRoundUsd = rows.reduce((sum, row) => sum + row.perImageUsd, 0);
    const price = (count) => {
        const totalUsd = roundUsd(perRoundUsd * count);
        const projectedUsd = roundUsd(runningUsd + totalUsd);
        return { totalUsd, projectedUsd, withinCap: projectedUsd <= capUsd };
    };
    return { oneEach: price(1), twoEach: price(2), runningUsd, capUsd };
}

export function loggedUsd(rootDir) {
    return runningTotalUsd(readLog(join(rootDir, 'log', 'generations.jsonl')));
}

/** "3: sheet, line-up, sprite", with a count in front of any kind there are two of. */
export function refsLabel(names) {
    const counts = new Map();
    for (const name of names) {
        const kind = name.split('-')[0];
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const parts = [...counts].map(([kind, count]) => (count === 1 ? REF_LABELS[kind][0] : `${count} ${REF_LABELS[kind][1]}`));
    return `${names.length}: ${parts.join(', ')}`;
}

/** The summary table as lines of text: id, size requested, aspect, refs and the cost of one image. */
export function formatTable(rows) {
    const cells = [['id', 'size', 'aspect', 'refs', 'cost'], ...rows.map((row) => [row.id, row.size, row.aspect, refsLabel(row.refs), usd(row.perImageUsd)])];
    const widths = cells[0].map((_, column) => Math.max(...cells.map((line) => line[column].length)));
    const render = (line) => line.map((cell, column) => (column === line.length - 1 ? cell : cell.padEnd(widths[column]))).join('  ');
    return [render(cells[0]), widths.map((width) => '-'.repeat(width)).join('  '), ...cells.slice(1).map(render)];
}
