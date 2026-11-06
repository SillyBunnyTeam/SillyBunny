import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { buildLayout } from './github-build.mjs';
import { makePlaceholderArt, parseArt } from './github-art.mjs';
import { parseBackdrop } from './github-backdrop.mjs';
import { parseGithubConfig, slotAsset } from './github-config.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { readRaster } from './raster.mjs';

/** The slots the final files fill, which are the keys of `final`, and the kind of asset each one takes. */
export const slotsOf = (config) => Object.fromEntries(Object.keys(config.final).map((slot) => [slot, slotAsset(slot)]));

const CONFIG_FILE = 'github-config.json';

/** The config and the hash of the bytes that it was parsed from. */
function readGithubConfig(rootDir) {
    const path = join(rootDir, CONFIG_FILE);
    let bytes;
    try {
        bytes = readFileSync(path);
    } catch (error) {
        throw new Error(`The GitHub assets config could not be read from ${path}: ${error.message}`);
    }
    try {
        return { config: parseGithubConfig(JSON.parse(bytes.toString('utf8'))), sha256: sha256(bytes) };
    } catch (error) {
        throw new Error(`${path}: ${error.message}`);
    }
}

/** @param {string} rootDir */
export const loadGithubConfig = (rootDir) => readGithubConfig(rootDir).config;

/** Previews and final files go under out/, which git ignores. A path with ".." in it is checked as the place it leads to. */
export function resolveGithubOutDir(rootDir, outDir) {
    const absolute = resolve(rootDir, outDir);
    const base = resolve(rootDir, 'out');
    if (absolute !== base && !absolute.startsWith(base + sep)) {
        throw new Error(`--out-dir must be inside out/ (git-ignored); got ${outDir}.`);
    }
    return absolute;
}

/**
 * The pictures that the layouts draw from, read once. Art whose file is not there yet is replaced by its placeholder slab when the
 * config gives one, and its name is listed in `placeholders`; with no placeholder a missing file is an error. `refHashes` are the
 * hashes of the bytes that were read (the plate, the emblem, the art, the backdrops), so that a log records what was drawn from.
 */
export async function loadSources(rootDir, config) {
    const refHashes = [];
    const readSource = (path) => {
        const bytes = readFileSync(join(rootDir, path));
        refHashes.push(sha256(bytes));
        return bytes;
    };
    const plateSvg = readSource(config.sources.plate).toString('utf8');
    const emblemSvg = readSource(config.sources.emblem).toString('utf8');
    const art = {};
    const placeholders = [];
    for (const [name, path] of Object.entries(config.sources.art)) {
        const size = config.sources.placeholders[name];
        if (existsSync(join(rootDir, path))) {
            art[name] = parseArt(await readRaster(readSource(path)), path);
            continue;
        }
        if (!size) {
            throw new Error(`The art "${name}" is not at ${path}, and the config has no placeholder size for it.`);
        }
        art[name] = makePlaceholderArt(size.width, size.height);
        placeholders.push(name);
    }
    const backdrops = {};
    for (const [name, path] of Object.entries(config.sources.backdrops)) {
        backdrops[name] = parseBackdrop(await readRaster(readSource(path)), path);
    }
    return { backdrops, plateSvg, emblemSvg, art, contacts: config.contacts, placeholders, refHashes };
}

const drawsPlaceholder = (layout, sources) => layout.elements.some(({ type, source }) => type === 'art' && sources.placeholders.includes(source));

/**
 * Checks a built file against what its kind of asset allows. Returns the problems, so a run can list them all.
 * @param {import('./github-config.mjs').Layout} layout
 * @param {Buffer} png
 * @param {{ assets: Record<string, { maxBytes: number }> }} config
 * @returns {Promise<string[]>}
 */
export async function findLimitProblems(layout, png, config) {
    const picture = await readRaster(png);
    const problems = [];
    if (picture.width !== layout.width || picture.height !== layout.height) {
        problems.push(`${layout.id} is ${picture.width}x${picture.height}, not ${layout.width}x${layout.height}`);
    }
    if (png.length >= config.assets[layout.asset].maxBytes) {
        problems.push(`${layout.id} is ${png.length} bytes, which is not under ${config.assets[layout.asset].maxBytes}`);
    }
    return problems;
}

function writeAll(root, files) {
    for (const [path, bytes] of files) {
        const absolute = join(root, path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, bytes);
    }
}

/**
 * The layout for each slot of a write run: what was asked for, else what the config chose, else for a banner the layout that has the
 * slot's own id. The avatar and the social preview have several candidates, so they are never picked by default.
 */
export function chooseLayouts(config, requested = {}) {
    const slots = slotsOf(config);
    const unknown = Object.keys(requested).filter((slot) => !Object.hasOwn(slots, slot));
    if (unknown.length > 0) {
        throw new Error(`--choose names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a slot' : 'are not slots'}. The slots are ${Object.keys(slots).join(', ')}.`);
    }
    const choice = Object.fromEntries(Object.entries(slots).map(([slot, asset]) => {
        const byId = asset === 'banner' && config.layouts.some(({ id }) => id === slot) ? slot : undefined;
        return [slot, requested[slot] ?? config.chosen?.[slot] ?? byId];
    }));
    const missing = Object.keys(slots).filter((slot) => !choice[slot]);
    if (missing.length > 0) {
        throw new Error(`A write run needs a layout for ${missing.join(', ')}: set "chosen" in github-config.json or pass --choose slot=layout.`);
    }
    return Object.fromEntries(Object.entries(slots).map(([slot, asset]) => {
        const layout = config.layouts.find(({ id }) => id === choice[slot]);
        if (!layout || layout.asset !== asset) {
            throw new Error(`${slot} must be ${asset === 'avatar' ? 'an' : 'a'} ${asset} layout, and "${choice[slot]}" is ${layout ? `a ${layout.asset} layout` : 'not a layout'}.`);
        }
        return [slot, layout];
    }));
}

/**
 * Builds every layout of the config into `outDir` (previews, one PNG per layout). Only a `write` run also writes the chosen layouts
 * under their final names into `outDir/final/` and appends a line to the log; without it nothing but out/ changes.
 * @param {{ rootDir: string, outDir: string, write?: boolean, choose?: Record<string, string>, now?: () => Date, sheet?: (built: Map<string, { layout: object, png: Buffer }>, config: object) => Promise<Map<string, Buffer>> }} request
 */
export async function runGithubAssets({ rootDir, outDir, write = false, choose = {}, now = () => new Date(), sheet }) {
    const out = resolveGithubOutDir(rootDir, outDir);
    const { config, sha256: configHash } = readGithubConfig(rootDir);
    const chosen = write ? chooseLayouts(config, choose) : null;
    const sources = await loadSources(rootDir, config);
    const unfinished = chosen ? Object.entries(chosen).filter(([, layout]) => drawsPlaceholder(layout, sources)) : [];
    if (unfinished.length > 0) {
        throw new Error(`A write run cannot ship a stand-in: ${unfinished.map(([slot, layout]) => `${slot} (${layout.id})`).join(', ')} draw art that is not in the package yet (${sources.placeholders.join(', ')}).`);
    }

    const built = new Map();
    const problems = [];
    for (const layout of config.layouts) {
        const { png, placements, placeholders } = await buildLayout(layout, { colours: config.colours, sources, icons: config.icons, ornaments: config.ornaments });
        problems.push(...await findLimitProblems(layout, png, config));
        built.set(layout.id, { layout, png, placements, placeholders });
    }
    if (problems.length > 0) {
        throw new Error(`The assets break their limits:\n${problems.map((line) => `  ${line}`).join('\n')}`);
    }

    writeAll(out, [...built].map(([id, { png }]) => [`${id}.png`, png]));
    const sheets = sheet ? await sheet(built, config) : new Map();
    writeAll(out, [...sheets].map(([name, bytes]) => [join('sheets', name), bytes]));

    const finals = chosen ? Object.entries(chosen).map(([slot, layout]) => [config.final[slot], built.get(layout.id).png, layout.id]) : [];
    if (write) {
        writeAll(join(out, 'final'), finals.map(([name, bytes]) => [name, bytes]));
        appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
            time: now().toISOString(),
            stage: 's8',
            provider: 'local',
            model: 'github-assets',
            template: 'github-assets',
            vars: { layouts: Object.fromEntries(Object.entries(chosen).map(([slot, layout]) => [slot, layout.id])), config: { file: CONFIG_FILE, sha256: configHash } },
            refHashes: sources.refHashes,
            size: '500-2560',
            outputs: finals.map(([name, bytes]) => ({ file: relative(rootDir, join(out, 'final', name)).split(sep).join('/'), sha256: sha256(bytes) })),
            estimatedUsd: 0,
        }));
    }
    return {
        files: [...built].map(([id, { layout, png, placements, placeholders }]) => ({ id, asset: layout.asset, width: layout.width, height: layout.height, bytes: png.length, placements, placeholders })),
        sheets: [...sheets.keys()],
        finals: finals.map(([name, , id]) => ({ name, layout: id })),
        wrote: write,
    };
}
