import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { coverBox, placeSprite, renderAvatarSheet, renderAvatars, renderCard, trimSprite } from './card-image.mjs';
import { CARD_CONFIG_FILE, loadCardConfig } from './card-config.mjs';
import { embedCard, prepareCard, verifyCard } from './card-meta.mjs';
import { sniffImage } from './images.mjs';
import { appendLogEntry, makeLogEntry, sha256 } from './log.mjs';
import { readRaster } from './raster.mjs';
import { resolveOutDir } from './run.mjs';

const PREVIEW_DIR = join('out', 'cards');
const toLogPath = (rootDir, path) => relative(rootDir, path).split(sep).join('/');
const hexOf = (rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

/**
 * Builds one card in memory: trims the art at the waist, places it on the gradient, writes the user's card into the PNG with the app's writer,
 * reads it back the way the app does and compares it with the card, and cuts the avatar previews. Nothing is written.
 */
async function buildCard({ rootDir, repoRoot, config, id, cardPath }) {
    const entry = config.cards[id];
    const artPath = resolve(rootDir, entry.art);
    if (!existsSync(cardPath)) {
        throw new Error(`${id}: the card file ${cardPath} does not exist.`);
    }
    if (!existsSync(artPath)) {
        throw new Error(`${id}: the card art ${entry.art} does not exist.`);
    }
    const artBytes = readFileSync(artPath);
    sniffImage(artBytes);
    const cardBytes = readFileSync(cardPath);
    let source;
    try {
        source = JSON.parse(cardBytes.toString('utf8'));
    } catch (error) {
        throw new Error(`${id}: the card file ${basename(cardPath)} is not JSON (${error.message}).`);
    }
    const { card, edits } = prepareCard(source, config.world);

    const trimmed = trimSprite(await readRaster(artBytes), config.sprite);
    const placement = placeSprite(trimmed.sprite, config.canvas, config.sprite);
    const { rgb, png: image } = await renderCard(trimmed.sprite, config, placement);
    const png = await embedCard(image, card);
    const readBack = await verifyCard(png, card, config.world);

    const box = coverBox(config.canvas);
    const avatars = await renderAvatars(rgb, config.canvas, box, config.avatar.sizes);
    const stem = basename(entry.output, '.png').replace(/^default_/, '');
    return {
        id,
        output: entry.output,
        outputPath: join(repoRoot, entry.output),
        png,
        art: { file: toLogPath(rootDir, artPath), sha256: sha256(artBytes) },
        cardFile: { name: basename(cardPath), sha256: sha256(cardBytes) },
        edits,
        sprite: { box: trimmed.box, cut: trimmed.cut, width: trimmed.sprite.width, height: trimmed.sprite.height },
        placement,
        avatarBox: box,
        avatars,
        sheet: await renderAvatarSheet(avatars, config.avatar),
        stem,
        chunks: readBack.chunks,
        fields: readBack.fields,
    };
}

/** The preview files of a built card, by name: the card as it ships, each avatar, and the sheet that shows them on a light and a dark backdrop. */
function previewFiles(built) {
    return [
        [basename(built.output), built.png],
        ...built.avatars.map(({ size, shape, png }) => [`${built.stem}-${size}-${shape}.png`, png]),
        [`${built.stem}-avatars.png`, built.sheet],
    ];
}

/**
 * Builds the assistant cards of card-config.json. `cardDir` holds the card files the config names. `mode` is `dry-run` (build and check in
 * memory, write nothing), `preview` (also write the card and the avatar previews under out/cards/, no log) or `build` (write
 * default/content/<card>.png, the previews, and one log line for each card as a local tool, `build-card`, with the art's sha256 in `refs`).
 * Every card is built before the first file is written, so a bad one writes nothing. An existing card in default/content/ is never replaced
 * unless `overwrite` is set, and the log line of the new card then has `vars.replaces`, the sha256 of the file it replaced. The cards are written one
 * after the other and logged after all of them are written, so if writing the second fails, the first is already in default/content/ and has no log line.
 * @param {{ rootDir: string, repoRoot: string, cardDir: string, only?: string[], mode: 'dry-run' | 'preview' | 'build', stage?: string, overwrite?: boolean, now: () => Date }} request
 */
export async function runBuildCards({ rootDir, repoRoot, cardDir, only, mode, stage, overwrite = false, now }) {
    if (mode === 'build' && !stage) {
        throw new Error('Pass --stage (such as s5) for a build that is logged, or --dry-run or --preview.');
    }
    const config = loadCardConfig(rootDir);
    const ids = only ?? Object.keys(config.cards);
    if (ids.length === 0) {
        throw new Error(`--only names no card. ${CARD_CONFIG_FILE} has: ${Object.keys(config.cards).join(', ')}.`);
    }
    const twice = ids.filter((id, at) => ids.indexOf(id) !== at);
    if (twice.length > 0) {
        throw new Error(`--only names ${[...new Set(twice)].join(', ')} more than once, which would build and log the card twice.`);
    }
    for (const id of ids) {
        if (!config.cards[id]) {
            throw new Error(`"${id}" is not a card in ${CARD_CONFIG_FILE}. It has: ${Object.keys(config.cards).join(', ')}.`);
        }
    }
    const built = [];
    for (const id of ids) {
        try {
            built.push(await buildCard({ rootDir, repoRoot, config, id, cardPath: resolve(cardDir, config.cards[id].cardFile) }));
        } catch (error) {
            const own = `${id}: `;
            throw new Error(`${id}: ${error.message.startsWith(own) ? error.message.slice(own.length) : error.message} Nothing was written.`);
        }
    }
    if (mode === 'dry-run') {
        return { built, previews: [], written: [] };
    }

    const previewDir = resolveOutDir(rootDir, PREVIEW_DIR);
    const written = [];
    // The sha256 of a card that `overwrite` replaces, kept for its log line: the log only grows, so the line of the replaced file stays and this one names it.
    const replaced = new Map();
    if (mode === 'build') {
        const existing = built.filter(({ outputPath }) => existsSync(outputPath));
        if (existing.length > 0 && !overwrite) {
            throw new Error(`${existing.map(({ output }) => output).join(', ')} already exist${existing.length === 1 ? 's' : ''}; pass --overwrite to replace ${existing.length === 1 ? 'it' : 'them'}. Nothing was written.`);
        }
        for (const one of existing) {
            replaced.set(one.id, sha256(readFileSync(one.outputPath)));
        }
        mkdirSync(join(repoRoot, 'default', 'content'), { recursive: true });
        for (const one of built) {
            writeFileSync(one.outputPath, one.png, { flag: overwrite ? 'w' : 'wx' });
            written.push(one.output);
        }
    }
    mkdirSync(previewDir, { recursive: true });
    const previews = [];
    for (const one of built) {
        for (const [name, bytes] of previewFiles(one)) {
            writeFileSync(join(previewDir, name), bytes);
            previews.push(toLogPath(rootDir, join(previewDir, name)));
        }
    }
    if (mode === 'build') {
        const configSha256 = sha256(readFileSync(join(rootDir, CARD_CONFIG_FILE)));
        for (const one of built) {
            appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), makeLogEntry({
                time: now().toISOString(),
                stage,
                provider: 'local',
                model: 'build-card',
                template: 'build-card',
                vars: {
                    id: one.id,
                    card: one.cardFile,
                    art: one.art.file,
                    config: { file: CARD_CONFIG_FILE, sha256: configSha256, background: { top: hexOf(config.background.top), bottom: hexOf(config.background.bottom) } },
                    world: config.world,
                    edits: one.edits,
                    cut: one.sprite.cut,
                    sprite: { width: one.sprite.width, height: one.sprite.height },
                    placement: one.placement,
                    chunks: one.chunks,
                    fields: one.fields,
                    ...(replaced.has(one.id) ? { replaces: replaced.get(one.id) } : {}),
                },
                refHashes: [one.art.sha256],
                size: `${config.canvas.width}x${config.canvas.height}`,
                outputs: [{ file: one.output, sha256: sha256(one.png) }],
                estimatedUsd: 0,
            }));
        }
    }
    return { built, previews, written };
}
