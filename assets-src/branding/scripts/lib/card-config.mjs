import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHexColour } from './rim-recolour.mjs';

export const CARD_CONFIG_FILE = 'card-config.json';

const fail = (message) => {
    throw new Error(`${CARD_CONFIG_FILE}: ${message}`);
};

function onlyKeys(raw, known, where) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        fail(`${where} must be an object.`);
    }
    for (const key of Object.keys(raw)) {
        if (!known.includes(key)) {
            fail(`${where}: unknown key "${key}". Known keys: ${known.join(', ')}.`);
        }
    }
}

const whole = (value, where, min = 1) => {
    if (!Number.isInteger(value) || value < min) {
        fail(`${where} must be a whole number of ${min} or more, got ${JSON.stringify(value)}.`);
    }
    return value;
};

const share = (value, where) => {
    if (!(typeof value === 'number' && value > 0 && value <= 1)) {
        fail(`${where} must be a number above 0 and at most 1, got ${JSON.stringify(value)}.`);
    }
    return value;
};

const colour = (value, where) => {
    try {
        return parseHexColour(value);
    } catch {
        return fail(`${where} must be a hex colour such as #b99bf2, got ${JSON.stringify(value)}.`);
    }
};

const text = (value, where) => {
    if (typeof value !== 'string' || value === '') {
        fail(`${where} must be a non-empty string.`);
    }
    return value;
};

function parseSticker(raw) {
    onlyKeys(raw, ['rim', 'rimTolerance', 'whiteFloor', 'rowShare', 'maxRows', 'inset'], 'sprite.sticker');
    return {
        rim: colour(raw.rim, 'sprite.sticker.rim'),
        rimTolerance: whole(raw.rimTolerance, 'sprite.sticker.rimTolerance'),
        whiteFloor: whole(raw.whiteFloor, 'sprite.sticker.whiteFloor', 1),
        rowShare: share(raw.rowShare, 'sprite.sticker.rowShare'),
        maxRows: whole(raw.maxRows, 'sprite.sticker.maxRows'),
        inset: whole(raw.inset, 'sprite.sticker.inset', 0),
    };
}

const CARD_ID = /^[\w-]+$/;

function parseCard(id, raw) {
    if (!CARD_ID.test(id)) {
        fail(`the card id ${JSON.stringify(id)} may hold letters, digits, "_" and "-" only.`);
    }
    onlyKeys(raw, ['cardFile', 'art', 'output'], `cards.${id}`);
    const output = text(raw.output, `cards.${id}.output`);
    if (!/^default\/content\/default_[\w-]+\.png$/.test(output)) {
        fail(`cards.${id}.output must be default/content/default_<Name>.png, got ${JSON.stringify(output)}.`);
    }
    return {
        id,
        cardFile: text(raw.cardFile, `cards.${id}.cardFile`),
        art: text(raw.art, `cards.${id}.art`),
        output,
    };
}

/**
 * Parses card-config.json: the card size, the gradient, how the sprite is trimmed and placed, the sizes of the avatar previews, the `world` every
 * assistant card is set to, and, for each card id, its art, its card file name and its output under default/content/. Colours become
 * [r, g, b]. Anything wrong fails here, before a picture is read.
 * @param {any} raw
 */
export function parseCardConfig(raw) {
    onlyKeys(raw, ['canvas', 'background', 'sprite', 'avatar', 'world', 'cards'], 'the file');
    onlyKeys(raw.canvas, ['width', 'height'], 'canvas');
    onlyKeys(raw.background, ['top', 'bottom'], 'background');
    onlyKeys(raw.sprite, ['alphaThreshold', 'solidAlpha', 'sideMargin', 'topMargin', 'sticker'], 'sprite');
    onlyKeys(raw.avatar, ['sizes', 'lightBackdrop', 'darkBackdrop'], 'avatar');
    const canvas = { width: whole(raw.canvas.width, 'canvas.width', 16), height: whole(raw.canvas.height, 'canvas.height', 16) };
    const sprite = {
        alphaThreshold: whole(raw.sprite.alphaThreshold, 'sprite.alphaThreshold'),
        solidAlpha: whole(raw.sprite.solidAlpha, 'sprite.solidAlpha'),
        sideMargin: whole(raw.sprite.sideMargin, 'sprite.sideMargin', 0),
        topMargin: whole(raw.sprite.topMargin, 'sprite.topMargin', 0),
        sticker: parseSticker(raw.sprite.sticker),
    };
    if (2 * sprite.sideMargin >= canvas.width || sprite.topMargin >= canvas.height) {
        fail('the margins leave no room for the sprite on the canvas.');
    }
    if (!Array.isArray(raw.avatar.sizes) || raw.avatar.sizes.length === 0) {
        fail('avatar.sizes must list at least one size in pixels.');
    }
    const avatar = {
        sizes: raw.avatar.sizes.map((size, index) => whole(size, `avatar.sizes[${index}]`, 8)),
        lightBackdrop: colour(raw.avatar.lightBackdrop, 'avatar.lightBackdrop'),
        darkBackdrop: colour(raw.avatar.darkBackdrop, 'avatar.darkBackdrop'),
    };
    const ids = Object.keys(raw.cards ?? {});
    if (ids.length === 0) {
        fail('cards needs at least one card.');
    }
    return {
        canvas,
        background: { top: colour(raw.background.top, 'background.top'), bottom: colour(raw.background.bottom, 'background.bottom') },
        sprite,
        avatar,
        world: text(raw.world, 'world'),
        cards: Object.fromEntries(ids.map((id) => [id, parseCard(id, raw.cards[id])])),
    };
}

/** Reads and parses card-config.json from the package root. */
export function loadCardConfig(rootDir) {
    const path = join(rootDir, CARD_CONFIG_FILE);
    if (!existsSync(path)) {
        throw new Error(`${path} does not exist.`);
    }
    return parseCardConfig(JSON.parse(readFileSync(path, 'utf8')));
}
