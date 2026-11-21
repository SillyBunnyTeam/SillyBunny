import { parseHex } from './github-colour.mjs';
import { CONTACT_KINDS } from './github-contact.mjs';
import { parseSubtitleAlign, parseSubtitleLines } from './github-subtitle.mjs';
import { TITLES } from './github-titles.mjs';

const ASSETS = Object.freeze(['avatar', 'social', 'banner']);
const ELEMENT_TYPES = Object.freeze(['plate', 'emblem', 'wordmark', 'title', 'subtitle', 'art', 'sparkles', 'moon', 'backdrop', 'frame', 'bar', 'icon']);
/** Elements that only decorate: they sit behind the picture and may overlap it, but not the logo or the text. */
export const DECOR_TYPES = Object.freeze(['sparkles', 'moon']);
/** Elements that are a surface the logo, the text and the art are set on, so they may lie under any of them. */
export const BACKDROP_TYPES = Object.freeze(['backdrop', 'bar']);
/** Elements that carry their own position, because they are pinned by their parts and not by an `at`. */
const SELF_PLACED_TYPES = Object.freeze(['sparkles', 'frame']);
/**
 * The smallest block of the frame and the plaques, so that they survive the downscale of a README (banners are shown at 880 pixels of
 * 2560). A social preview is 1280 pixels wide, so its decoration is drawn at half that size.
 */
export const MIN_BLOCK_UNIT = 8;
const MIN_BLOCK_UNIT_BY_ASSET = Object.freeze({ avatar: MIN_BLOCK_UNIT, banner: MIN_BLOCK_UNIT, social: MIN_BLOCK_UNIT / 2 });
/** The smallest block of a pixel icon, and the sizes of the grid that an icon is drawn from. */
export const ICON_GRID = Object.freeze({ min: 16, max: 20 });
export const MIN_ICON_UNIT = 4;
const ICON_SYMBOLS = new Set(['.', 'o', 'l', 'c', 'a']);
const SLOT_PATTERN = /^(avatar|social|banner-[a-z]+-(?:light|dark))$/;
const HORIZONTAL = ['left', 'right', 'centerX'];
const VERTICAL = ['top', 'bottom', 'centerY', 'lineY'];
const TOP_KEYS = new Set(['colours', 'sources', 'assets', 'final', 'chosen', 'layouts', 'icons', 'ornaments', 'contacts']);
const SOURCE_KEYS = new Set(['plate', 'emblem', 'art', 'placeholders', 'backdrops']);
const ASSET_KEYS = new Set(['width', 'height', 'minHeight', 'maxHeight', 'maxBytes']);
const LAYOUT_KEYS = new Set(['id', 'asset', 'note', 'background', 'width', 'height', 'elements']);
const ELEMENT_KEYS = {
    plate: new Set(['type', 'size', 'edge', 'at']),
    emblem: new Set(['type', 'height', 'edge', 'at']),
    wordmark: new Set(['type', 'size', 'colour', 'line', 'edge', 'at']),
    title: new Set(['type', 'title', 'size', 'colour', 'maxWidth', 'edge', 'at']),
    subtitle: new Set(['type', 'lines', 'size', 'colour', 'align', 'at']),
    art: new Set(['type', 'source', 'step', 'shadow', 'at', 'bleed']),
    sparkles: new Set(['type', 'colour', 'unit', 'points']),
    moon: new Set(['type', 'colour', 'unit', 'diameter', 'bite', 'lift', 'at']),
    backdrop: new Set(['type', 'source', 'step', 'mirror', 'at', 'bleed']),
    frame: new Set(['type', 'unit', 'layers', 'boss']),
    bar: new Set(['type', 'unit', 'widthCells', 'heightCells', 'layers', 'studs', 'at']),
    icon: new Set(['type', 'icon', 'palette', 'unit', 'at']),
};
/** The line of a wordmark that a `lineY` anchor pins: the middle of its capitals, or its baseline. */
const WORDMARK_LINES = Object.freeze(['capCentre', 'baseline']);
const LAYER_KEYS = new Set(['colour', 'inset', 'notch']);
const SHADOW_ART_KEYS = new Set(['tint', 'bands', 'inset', 'strengths', 'offset']);
const CONTACT_KEYS = new Set(['kind', 'x0', 'x1', 'y', 'strength']);
const STUD_KEYS = new Set(['colour', 'cells', 'inset']);
const EDGE_KEYS = new Set(['outline', 'shadow']);
const OUTLINE_KEYS = new Set(['colour', 'width']);
const SHADOW_KEYS = new Set(['colour', 'alpha', 'offset', 'step', 'steps']);
const FRAME_LAYER_KEYS = new Set(['colour', 'cells']);
const BOSS_KEYS = new Set(['cells', 'notch', 'outside', 'ornaments']);
const ORNAMENT_KEYS = new Set(['rows', 'colours']);
const ICON_KEYS = new Set(['palettes', 'shapes']);
const PALETTE_KEYS = new Set(['o', 'l', 'c']);
const SHAPE_KEYS = new Set(['rows', 'accent']);
const POINT_KEYS = new Set(['x', 'y', 'arm']);
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The kind of asset that a slot takes. @param {string} slot */
export function slotAsset(slot) {
    return slot.startsWith('banner-') ? 'banner' : slot;
}

function assertObject(value, where) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${where} must be an object.`);
    }
}

function assertKeys(object, allowed, where) {
    assertObject(object, where);
    for (const key of Object.keys(object)) {
        if (!allowed.has(key)) {
            throw new Error(`${where} has an unknown key "${key}". Known keys: ${[...allowed].join(', ')}.`);
        }
    }
}

function assertWhole(value, where, minimum = 1) {
    if (!Number.isInteger(value) || value < minimum) {
        throw new Error(`${where} must be a whole number of ${minimum} or more, got ${JSON.stringify(value)}.`);
    }
}

function parseAt(at, where) {
    assertKeys(at, new Set([...HORIZONTAL, ...VERTICAL]), `${where}.at`);
    const keys = Object.keys(at);
    if (keys.filter((key) => HORIZONTAL.includes(key)).length !== 1 || keys.filter((key) => VERTICAL.includes(key)).length !== 1) {
        throw new Error(`${where}.at needs exactly one of ${HORIZONTAL.join(', ')} and exactly one of ${VERTICAL.join(', ')}, got ${keys.join(', ') || 'none'}.`);
    }
    for (const key of keys) {
        assertWhole(at[key], `${where}.at.${key}`, Number.MIN_SAFE_INTEGER);
    }
    return Object.freeze({ ...at });
}

function assertColourName(name, colours, where) {
    if (!Object.hasOwn(colours, name)) {
        throw new Error(`${where} "${name}" is not one of the colours: ${Object.keys(colours).join(', ')}.`);
    }
}

function assertBlockUnit(unit, where, minimum) {
    assertWhole(unit, `${where}.unit`);
    if (unit < minimum) {
        throw new Error(`${where}.unit is ${unit}; decoration is built of blocks of ${minimum} pixels or more, so that it survives the downscale of a README.`);
    }
}

function parseLayers(layers, where, colours) {
    if (!Array.isArray(layers) || layers.length < 2) {
        throw new Error(`${where}.layers must be a list of at least two layers: a line and a fill.`);
    }
    return layers.map((layer, at) => {
        assertKeys(layer, LAYER_KEYS, `${where}.layers[${at}]`);
        assertColourName(layer.colour, colours, `${where}.layers[${at}].colour`);
        assertWhole(layer.inset, `${where}.layers[${at}].inset`, 0);
        assertWhole(layer.notch, `${where}.layers[${at}].notch`, 0);
        return Object.freeze({ ...layer });
    });
}

/** The layers of a frame, outermost first: each a colour and a number of blocks. */
function parseFrameLayers(layers, where, colours) {
    if (!Array.isArray(layers) || layers.length < 2) {
        throw new Error(`${where}.layers must be a list of at least two layers.`);
    }
    return layers.map((layer, at) => {
        assertKeys(layer, FRAME_LAYER_KEYS, `${where}.layers[${at}]`);
        assertColourName(layer.colour, colours, `${where}.layers[${at}].colour`);
        assertWhole(layer.cells, `${where}.layers[${at}].cells`);
        return Object.freeze({ ...layer });
    });
}

/** The corner ornaments: a small grid of symbols, each symbol but "." with a colour, drawn in the space inside a frame boss. */
function parseOrnaments(raw, colours) {
    assertObject(raw, 'ornaments');
    for (const [name, ornament] of Object.entries(raw)) {
        const where = `ornaments.${name}`;
        assertKeys(ornament, ORNAMENT_KEYS, where);
        const { rows } = ornament;
        if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => typeof row !== 'string' || row.length !== rows.length)) {
            throw new Error(`${where}.rows must be a square grid of symbols: as many rows as each row is long.`);
        }
        const symbols = new Set(rows.join('').replaceAll('.', ''));
        for (const symbol of symbols) {
            if (!Object.hasOwn(ornament.colours ?? {}, symbol)) {
                throw new Error(`${where}.colours has no colour for the symbol "${symbol}".`);
            }
        }
        for (const [symbol, name] of Object.entries(ornament.colours ?? {})) {
            assertColourName(name, colours, `${where}.colours.${symbol}`);
        }
    }
    return Object.freeze({ ...raw });
}

/** The pixel icons: palettes for the three symbols every icon shares, and the grids with their one accent colour each. */
function parseIcons(raw, colours) {
    assertKeys(raw, ICON_KEYS, 'icons');
    const palettes = raw.palettes ?? {};
    for (const [name, palette] of Object.entries(palettes)) {
        assertKeys(palette, PALETTE_KEYS, `icons.palettes.${name}`);
        for (const symbol of PALETTE_KEYS) {
            assertColourName(palette[symbol], colours, `icons.palettes.${name}.${symbol}`);
        }
    }
    const shapes = raw.shapes ?? {};
    for (const [name, shape] of Object.entries(shapes)) {
        const where = `icons.shapes.${name}`;
        assertKeys(shape, SHAPE_KEYS, where);
        const { rows } = shape;
        const width = rows?.[0]?.length;
        const sizeFits = (size) => Number.isInteger(size) && size >= ICON_GRID.min && size <= ICON_GRID.max;
        if (!Array.isArray(rows) || !sizeFits(rows.length) || !sizeFits(width) || rows.some((row) => typeof row !== 'string' || row.length !== width)) {
            throw new Error(`${where}.rows must be ${ICON_GRID.min} to ${ICON_GRID.max} rows of the same length, ${ICON_GRID.min} to ${ICON_GRID.max} symbols wide.`);
        }
        const used = new Set(rows.join(''));
        const stray = [...used].find((symbol) => !ICON_SYMBOLS.has(symbol));
        if (stray) {
            throw new Error(`${where}.rows uses the symbol "${stray}"; the symbols are ${[...ICON_SYMBOLS].join(' ')}.`);
        }
        if (used.has('a') !== ('accent' in shape)) {
            throw new Error(`${where} needs an accent colour exactly when its grid uses the accent symbol "a".`);
        }
        if ('accent' in shape) {
            assertColourName(shape.accent, colours, `${where}.accent`);
        }
    }
    return Object.freeze({ palettes: Object.freeze({ ...palettes }), shapes: Object.freeze({ ...shapes }) });
}

/** The outline and the stepped shadow of a logo or a text: colours by name, sizes in whole pixels. */
function parseEdge(edge, where, colours) {
    assertKeys(edge, EDGE_KEYS, `${where}.edge`);
    if (!('outline' in edge) && !('shadow' in edge)) {
        throw new Error(`${where}.edge needs an outline, a shadow, or both.`);
    }
    if ('outline' in edge) {
        assertKeys(edge.outline, OUTLINE_KEYS, `${where}.edge.outline`);
        assertColourName(edge.outline.colour, colours, `${where}.edge.outline.colour`);
        assertWhole(edge.outline.width, `${where}.edge.outline.width`);
    }
    if ('shadow' in edge) {
        const { shadow } = edge;
        assertKeys(shadow, SHADOW_KEYS, `${where}.edge.shadow`);
        assertColourName(shadow.colour, colours, `${where}.edge.shadow.colour`);
        assertWhole(shadow.step, `${where}.edge.shadow.step`);
        assertWhole(shadow.steps, `${where}.edge.shadow.steps`);
        if (typeof shadow.alpha !== 'number' || !(shadow.alpha > 0 && shadow.alpha <= 1)) {
            throw new Error(`${where}.edge.shadow.alpha must be above 0 and at most 1, got ${JSON.stringify(shadow.alpha)}.`);
        }
        assertKeys(shadow.offset, new Set(['x', 'y']), `${where}.edge.shadow.offset`);
        assertWhole(shadow.offset.x, `${where}.edge.shadow.offset.x`, Number.MIN_SAFE_INTEGER);
        assertWhole(shadow.offset.y, `${where}.edge.shadow.offset.y`, Number.MIN_SAFE_INTEGER);
    }
}

function assertStrength(value, where) {
    if (typeof value !== 'number' || !(value > 0 && value <= 1)) {
        throw new Error(`${where} must be above 0 and at most 1, got ${JSON.stringify(value)}.`);
    }
}

/**
 * The look of the contact shadows of an art element: the ground tint, the bands, and one strength for each kind of shadow, with a
 * contact the darkest. A raised part is fainter than a contact, and so is a footprint.
 */
function parseArtShadow(shadow, where, colours) {
    assertKeys(shadow, SHADOW_ART_KEYS, `${where}.shadow`);
    assertColourName(shadow.tint, colours, `${where}.shadow.tint`);
    assertWhole(shadow.bands, `${where}.shadow.bands`);
    assertWhole(shadow.inset, `${where}.shadow.inset`, 0);
    assertKeys(shadow.strengths, new Set(CONTACT_KINDS), `${where}.shadow.strengths`);
    for (const kind of CONTACT_KINDS) {
        assertStrength(shadow.strengths[kind], `${where}.shadow.strengths.${kind}`);
    }
    for (const fainter of ['footprint', 'raised']) {
        if (shadow.strengths[fainter] >= shadow.strengths.contact) {
            throw new Error(`${where}.shadow.strengths.${fainter} (${shadow.strengths[fainter]}) must be below the strength of a contact (${shadow.strengths.contact}).`);
        }
    }
    assertKeys(shadow.offset, new Set(['x', 'y']), `${where}.shadow.offset`);
    assertWhole(shadow.offset.x, `${where}.shadow.offset.x`, Number.MIN_SAFE_INTEGER);
    assertWhole(shadow.offset.y, `${where}.shadow.offset.y`, Number.MIN_SAFE_INTEGER);
}

/**
 * Where each scene touches the ground, by art name: runs of columns of the art and the row of art pixels that is the ground under them,
 * each of a kind, and a scene with at least one contact, because the lowest pixel of a picture is not the ground: it may be a foot in
 * the air. A scene that casts a shadow must list its contacts (checked with the layouts, by `assertShadowsHaveContacts`).
 */
function parseContacts(contacts, artNames) {
    assertKeys(contacts, new Set(artNames), 'contacts');
    return Object.fromEntries(Object.entries(contacts).map(([name, entries]) => {
        if (!Array.isArray(entries) || entries.length === 0) {
            throw new Error(`contacts.${name} must be a list of where the scene touches the ground.`);
        }
        const parsed = entries.map((entry, at) => {
            const where = `contacts.${name}[${at}]`;
            assertKeys(entry, CONTACT_KEYS, where);
            if (!CONTACT_KINDS.includes(entry.kind)) {
                throw new Error(`${where}.kind must be one of ${CONTACT_KINDS.join(', ')}, got ${JSON.stringify(entry.kind)}.`);
            }
            assertWhole(entry.x0, `${where}.x0`, 0);
            assertWhole(entry.x1, `${where}.x1`, entry.x0);
            assertWhole(entry.y, `${where}.y`, 0);
            if ('strength' in entry) {
                assertStrength(entry.strength, `${where}.strength`);
            }
            return Object.freeze({ ...entry });
        });
        if (!parsed.some(({ kind }) => kind === 'contact')) {
            throw new Error(`contacts.${name} has no contact: something in the scene touches the ground.`);
        }
        return [name, Object.freeze(parsed)];
    }));
}

/**
 * The art that casts a shadow needs the contacts of its scene, and an entry that is fainter by kind must stay fainter than the contact of
 * the element that casts it, however it is set.
 */
function assertShadowsHaveContacts(layouts, contacts) {
    for (const layout of layouts) {
        for (const element of layout.elements.filter(({ type, shadow }) => type === 'art' && shadow)) {
            if (!Object.hasOwn(contacts, element.source)) {
                throw new Error(`Layout "${layout.id}" casts a contact shadow for the art "${element.source}", but contacts lists nothing for it; a scene needs its contacts, placed by eye.`);
            }
            contacts[element.source].forEach((entry, at) => {
                if (entry.kind !== 'contact' && 'strength' in entry && entry.strength >= element.shadow.strengths.contact) {
                    throw new Error(`contacts.${element.source}[${at}] is a ${entry.kind} with the strength ${entry.strength}, which is not below the strength of a contact (${element.shadow.strengths.contact}) in layout "${layout.id}".`);
                }
            });
        }
    }
}

function parseElement(element, index, layoutId, { colours, artNames, backdropNames, icons, ornaments, asset }) {
    const minUnit = MIN_BLOCK_UNIT_BY_ASSET[asset];
    const where = `Layout "${layoutId}" element ${index}`;
    assertObject(element, where);
    if (!ELEMENT_TYPES.includes(element.type)) {
        throw new Error(`${where} has the type ${JSON.stringify(element.type)}; it must be one of ${ELEMENT_TYPES.join(', ')}.`);
    }
    assertKeys(element, ELEMENT_KEYS[element.type], where);
    const at = SELF_PLACED_TYPES.includes(element.type) ? undefined : parseAt(element.at, where);
    if ('bleed' in element && typeof element.bleed !== 'boolean') {
        throw new Error(`${where}.bleed must be true or false.`);
    }
    if (element.type === 'title') {
        if (!Object.hasOwn(TITLES, element.title)) {
            throw new Error(`${where}.title "${element.title}" is not a section title. The titles are: ${Object.keys(TITLES).join(', ')}.`);
        }
        assertWhole(element.size, `${where}.size`);
        if ('maxWidth' in element) {
            assertWhole(element.maxWidth, `${where}.maxWidth`);
        }
        assertColourName(element.colour, colours, `${where}.colour`);
    }
    if ('edge' in element) {
        parseEdge(element.edge, where, colours);
    }
    if (DECOR_TYPES.includes(element.type)) {
        assertWhole(element.unit, `${where}.unit`);
        assertColourName(element.colour, colours, `${where}.colour`);
    }
    if (element.type === 'sparkles') {
        if (!Array.isArray(element.points) || element.points.length === 0) {
            throw new Error(`${where}.points must be a list of stars.`);
        }
        element.points.forEach((point, at) => {
            assertKeys(point, POINT_KEYS, `${where}.points[${at}]`);
            assertWhole(point.x, `${where}.points[${at}].x`, 0);
            assertWhole(point.y, `${where}.points[${at}].y`, 0);
            assertWhole(point.arm, `${where}.points[${at}].arm`, 1);
        });
    }
    if (element.type === 'backdrop') {
        if (!backdropNames.includes(element.source)) {
            throw new Error(`${where}.source "${element.source}" is not one of the backdrops: ${backdropNames.join(', ') || 'none'}.`);
        }
        assertWhole(element.step, `${where}.step`);
        if ('mirror' in element && typeof element.mirror !== 'boolean') {
            throw new Error(`${where}.mirror must be true or false.`);
        }
    }
    if (element.type === 'frame') {
        assertBlockUnit(element.unit, where, minUnit);
        const layers = parseFrameLayers(element.layers, where, colours);
        assertKeys(element.boss, BOSS_KEYS, `${where}.boss`);
        assertWhole(element.boss.cells, `${where}.boss.cells`, 3);
        assertWhole(element.boss.notch, `${where}.boss.notch`, 0);
        assertColourName(element.boss.outside, colours, `${where}.boss.outside`);
        const inner = element.boss.cells - 2 * layers.reduce((sum, layer) => sum + layer.cells, 0);
        const wanted = element.boss.ornaments;
        if (!Array.isArray(wanted) || wanted.length !== 4) {
            throw new Error(`${where}.boss.ornaments must name four ornaments: top left, top right, bottom left, bottom right.`);
        }
        for (const name of wanted) {
            if (!Object.hasOwn(ornaments, name)) {
                throw new Error(`${where}.boss.ornaments names "${name}", which is not an ornament. The ornaments are: ${Object.keys(ornaments).join(', ') || 'none'}.`);
            }
            if (ornaments[name].rows.length !== inner) {
                throw new Error(`${where}.boss.ornaments: "${name}" is ${ornaments[name].rows.length} blocks across, but the space inside the boss is ${inner}.`);
            }
        }
    }
    if (element.type === 'bar') {
        assertBlockUnit(element.unit, where, minUnit);
        parseLayers(element.layers, where, colours);
        assertWhole(element.widthCells, `${where}.widthCells`, 3);
        assertWhole(element.heightCells, `${where}.heightCells`, 3);
        if ('studs' in element) {
            assertKeys(element.studs, STUD_KEYS, `${where}.studs`);
            assertColourName(element.studs.colour, colours, `${where}.studs.colour`);
            assertWhole(element.studs.cells, `${where}.studs.cells`);
            assertWhole(element.studs.inset, `${where}.studs.inset`, 0);
        }
    }
    if (element.type === 'icon') {
        assertWhole(element.unit, `${where}.unit`, MIN_ICON_UNIT);
        if (!Object.hasOwn(icons.shapes, element.icon)) {
            throw new Error(`${where}.icon "${element.icon}" is not an icon. The icons are: ${Object.keys(icons.shapes).join(', ') || 'none'}.`);
        }
        if (!Object.hasOwn(icons.palettes, element.palette)) {
            throw new Error(`${where}.palette "${element.palette}" is not an icon palette. The palettes are: ${Object.keys(icons.palettes).join(', ') || 'none'}.`);
        }
    }
    if (element.type === 'moon') {
        assertWhole(element.diameter, `${where}.diameter`, 3);
        assertWhole(element.bite, `${where}.bite`, 1);
        if ('lift' in element) {
            assertWhole(element.lift, `${where}.lift`, Number.MIN_SAFE_INTEGER);
        }
    }
    if (element.type === 'plate') {
        assertWhole(element.size, `${where}.size`);
    }
    if (element.type === 'emblem') {
        assertWhole(element.height, `${where}.height`);
    }
    if (element.type === 'subtitle') {
        parseSubtitleLines(element.lines, where);
        parseSubtitleAlign(element.align, where);
    }
    if (element.type === 'wordmark' && 'line' in element && !WORDMARK_LINES.includes(element.line)) {
        throw new Error(`${where}.line must be one of ${WORDMARK_LINES.join(', ')}, got ${JSON.stringify(element.line)}.`);
    }
    if (element.type === 'wordmark' || element.type === 'subtitle') {
        assertWhole(element.size, `${where}.size`);
        assertColourName(element.colour, colours, `${where}.colour`);
    }
    if (element.type === 'art') {
        if (!artNames.includes(element.source)) {
            throw new Error(`${where}.source "${element.source}" is not one of the art sources: ${artNames.join(', ')}.`);
        }
        assertWhole(element.step, `${where}.step`);
        if ('shadow' in element) {
            parseArtShadow(element.shadow, where, colours);
        }
    }
    return Object.freeze({ ...element, ...(at ? { at } : {}), bleed: element.bleed === true });
}

/**
 * The config of the GitHub assets, checked: the colours, the picture sources, the size limits of each kind of asset, the names the
 * chosen layouts are written under, and every layout. Nothing in it is looked up later without having been checked here.
 * @param {unknown} raw
 */
export function parseGithubConfig(raw) {
    assertKeys(raw, TOP_KEYS, 'The GitHub assets config');
    const colours = raw.colours ?? {};
    assertObject(colours, 'colours');
    for (const [name, hex] of Object.entries(colours)) {
        try {
            parseHex(hex);
        } catch (error) {
            throw new Error(`Colour "${name}": ${error.message}`);
        }
    }
    for (const required of ['lavender', 'logo']) {
        if (!Object.hasOwn(colours, required)) {
            throw new Error(`colours needs "${required}", the brand colour that the checks and the layouts start from.`);
        }
    }
    const sources = raw.sources ?? {};
    assertKeys(sources, SOURCE_KEYS, 'sources');
    for (const key of ['plate', 'emblem']) {
        if (typeof sources[key] !== 'string') {
            throw new Error(`sources.${key} must be the path of an approved SVG.`);
        }
    }
    const artNames = Object.keys(sources.art ?? {});
    if (artNames.length === 0 || artNames.some((name) => !ID_PATTERN.test(name) || typeof sources.art[name] !== 'string')) {
        throw new Error('sources.art must map each art name (lower case letters, digits and dashes) to the path of a snapped picture.');
    }

    const icons = parseIcons(raw.icons ?? {}, colours);
    const ornaments = parseOrnaments(raw.ornaments ?? {}, colours);

    const backdrops = sources.backdrops ?? {};
    assertObject(backdrops, 'sources.backdrops');
    for (const [name, path] of Object.entries(backdrops)) {
        if (!ID_PATTERN.test(name) || typeof path !== 'string') {
            throw new Error('sources.backdrops must map each backdrop name (lower case letters, digits and dashes) to the path of a snapped plate.');
        }
    }

    const placeholders = sources.placeholders ?? {};
    assertObject(placeholders, 'sources.placeholders');
    for (const [name, size] of Object.entries(placeholders)) {
        if (!artNames.includes(name)) {
            throw new Error(`sources.placeholders.${name} is not an art source.`);
        }
        assertKeys(size, new Set(['width', 'height']), `sources.placeholders.${name}`);
        assertWhole(size.width, `sources.placeholders.${name}.width`, 24);
        assertWhole(size.height, `sources.placeholders.${name}.height`, 24);
    }

    const assets = raw.assets ?? {};
    assertKeys(assets, new Set(ASSETS), 'assets');
    for (const asset of ASSETS) {
        assertKeys(assets[asset], ASSET_KEYS, `assets.${asset}`);
        assertWhole(assets[asset].width, `assets.${asset}.width`);
        assertWhole(assets[asset].maxBytes, `assets.${asset}.maxBytes`);
        for (const key of ['height', 'minHeight', 'maxHeight']) {
            if (key in assets[asset]) {
                assertWhole(assets[asset][key], `assets.${asset}.${key}`);
            }
        }
        if (!('height' in assets[asset]) && !('minHeight' in assets[asset] && 'maxHeight' in assets[asset])) {
            throw new Error(`assets.${asset} needs a height, or a minHeight and a maxHeight.`);
        }
    }

    const contacts = parseContacts(raw.contacts ?? {}, artNames);

    const layoutIds = new Set();
    const rawLayouts = raw.layouts ?? [];
    if (!Array.isArray(rawLayouts)) {
        throw new Error('layouts must be a list of layouts.');
    }
    const layouts = rawLayouts.map((layout, position) => {
        assertKeys(layout, LAYOUT_KEYS, `layouts[${position}]`);
        if (typeof layout.id !== 'string' || !ID_PATTERN.test(layout.id) || layoutIds.has(layout.id)) {
            throw new Error(`layouts[${position}].id must be unique and made of lower case letters, digits and dashes, got ${JSON.stringify(layout.id)}.`);
        }
        layoutIds.add(layout.id);
        if ('note' in layout && typeof layout.note !== 'string') {
            throw new Error(`Layout "${layout.id}" note must be a string, got ${JSON.stringify(layout.note)}.`);
        }
        if (!ASSETS.includes(layout.asset)) {
            throw new Error(`Layout "${layout.id}" has the asset ${JSON.stringify(layout.asset)}; it must be one of ${ASSETS.join(', ')}.`);
        }
        const limits = assets[layout.asset];
        const width = layout.width ?? limits.width;
        const height = layout.height ?? limits.height;
        assertWhole(height, `Layout "${layout.id}" height`);
        const heightFits = 'height' in limits ? height === limits.height : height >= limits.minHeight && height <= limits.maxHeight;
        if (width !== limits.width || !heightFits) {
            throw new Error(`Layout "${layout.id}" is ${width}x${height}, which is not a size that the ${layout.asset} asset may have.`);
        }
        if (layout.background !== null && !Object.hasOwn(colours, layout.background)) {
            throw new Error(`Layout "${layout.id}" background ${JSON.stringify(layout.background)} must be null or one of the colours: ${Object.keys(colours).join(', ')}.`);
        }
        if (layout.background === null && layout.asset !== 'avatar') {
            throw new Error(`Layout "${layout.id}" has no background, but only an avatar may be transparent: the others need a solid background.`);
        }
        if (!Array.isArray(layout.elements) || layout.elements.length === 0) {
            throw new Error(`Layout "${layout.id}" needs a list of elements.`);
        }
        const elements = layout.elements.map((element, index) => parseElement(element, index, layout.id, { colours, artNames, backdropNames: Object.keys(sources.backdrops ?? {}), icons, ornaments, asset: layout.asset }));
        return Object.freeze({ id: layout.id, asset: layout.asset, note: layout.note ?? '', background: layout.background, width, height, elements });
    });
    assertShadowsHaveContacts(layouts, contacts);

    const final = raw.final ?? {};
    assertObject(final, 'final');
    for (const [slot, name] of Object.entries(final)) {
        if (!SLOT_PATTERN.test(slot)) {
            throw new Error(`final.${slot} is not a slot. A slot is avatar, social, or banner-<section>-light or banner-<section>-dark.`);
        }
        if (!/^[a-z0-9-]+\.png$/.test(name)) {
            throw new Error(`final.${slot} must be a PNG file name, got ${JSON.stringify(name)}.`);
        }
    }
    const finalNames = Object.values(final);
    const repeated = finalNames.find((name, at) => finalNames.indexOf(name) !== at);
    if (repeated) {
        throw new Error(`final names two slots ${repeated}; each slot needs a file of its own.`);
    }
    const chosen = raw.chosen ?? null;
    if (chosen !== null) {
        assertKeys(chosen, new Set(Object.keys(final)), 'chosen');
        for (const [slot, id] of Object.entries(chosen)) {
            const layout = layouts.find((candidate) => candidate.id === id);
            if (!layout) {
                throw new Error(`chosen.${slot} names "${id}", which is not a layout.`);
            }
            if (layout.asset !== slotAsset(slot)) {
                throw new Error(`chosen.${slot} names "${id}", which is a ${layout.asset} layout, not a ${slotAsset(slot)} one.`);
            }
        }
    }
    return Object.freeze({ colours: Object.freeze({ ...colours }), sources: Object.freeze({ ...sources, placeholders, backdrops: sources.backdrops ?? {} }), assets, final, chosen, icons, ornaments, contacts, layouts: Object.freeze(layouts) });
}
