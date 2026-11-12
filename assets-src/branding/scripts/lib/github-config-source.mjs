import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadArt } from './github-art.mjs';
import { PLATE_LETTERING_BASELINE, wordmarkBaseline } from './github-align.mjs';
import { backdropName, loadBackdropConfig, resolvePlate } from './github-backdrop-run.mjs';
import { subtitleSize } from './github-subtitle.mjs';
import { titleSize } from './github-text.mjs';
import { wordmarkSize } from './github-vector.mjs';

/**
 * The source of github-config.json. The config holds the position of every element of the layouts, which follows from the size of the
 * wordmark, the titles and the subtitle as they are drawn, from the size of each scene and from where each scene touches the ground, so it
 * is generated: `scripts/github-config-emit.mjs` writes it, and test/github-config-source.test.mjs holds the committed file to this module.
 *
 * What is edited by hand lives in three files beside the config: github-parts.json (colours, icons, ornaments and the avatar layouts),
 * github-contacts.json (where each scene touches the ground, placed by eye) and github-backdrops.json (the light of each plate, and the step,
 * the place and the bleed of each crop of it). Everything else, the sizes and the structure of the layouts, is in this module.
 */

const BANNER = Object.freeze({ width: 2560, height: 800, unit: 8, frame: 24, ground: 24, outer: 120, artEdge: 160, padX: 64, padY: 48, iconGap: 28, iconUnit: 4, titleSize: 112 });
/**
 * A section title taller than this has been wrapped onto more than one line. Its icon is then drawn at the larger unit and centred on the
 * plaque, because there is no single line of text for it to sit on.
 */
const MULTILINE_TITLE_HEIGHT = 150;
const MULTILINE_ICON_UNIT = 8;
const SOCIAL = Object.freeze({ width: 1280, height: 640, unit: 4, frame: 12, ground: 12, artRight: 56 });
const MAIN_PLATE = 280;
const MAIN_WORDMARK = 140;
const SOCIAL_PLATE = 150;
const SOCIAL_WORDMARK = 84;
const MAIN_SUBTITLE = 42;
const SOCIAL_SUBTITLE = 34;
const SUBTITLE_LINES = Object.freeze(['A SillyTavern fork with a Bun runtime,', 'detailed human interface guidelines,', 'and modernised features!']);
const SUBTITLE_INK = Object.freeze({ light: 'quietPlum', dark: 'quietPale' });
/** The sections in the order of the README: the side of the banner that the pair stands on, and the width a long title wraps at. */
const SECTIONS = Object.freeze([
    { slot: 'main', side: 'right' },
    { slot: 'features', side: 'left', maxWidth: 1100 },
    { slot: 'install', side: 'right', maxWidth: 900 },
    { slot: 'contributing', side: 'left' },
    { slot: 'credits', side: 'right' },
    { slot: 'community', side: 'left', maxWidth: 800 },
]);
const THEMES = Object.freeze({
    light: {
        plate: 'mansion-day',
        ink: 'plum',
        page: 'pale',
        icons: 'light',
        moon: 'moon',
        frame: [['plum', 1], ['lavender', 1], ['pale', 1]],
        plaque: [['plum', 0, 2], ['lavender', 1, 1], ['pale', 2, 0], ['cream', 3, 0]],
    },
    dark: {
        plate: 'mansion-night',
        ink: 'pale',
        page: 'night',
        icons: 'dark',
        moon: 'moon-dark',
        frame: [['lavender', 1], ['logo', 1], ['panelDark', 1]],
        plaque: [['lavender', 0, 2], ['logo', 1, 1], ['panelDark', 2, 0], ['night', 3, 0]],
    },
});
const PIXEL_PATH = (name) => `approved/pixel/${name}.png`;
const BACKDROPS = Object.freeze([['mansion-day', 'banner'], ['mansion-night', 'banner'], ['mansion-day', 'social']]);

const readJson = (rootDir, file) => JSON.parse(readFileSync(join(rootDir, file), 'utf8'));

function frame(theme, unit) {
    const { frame: layers, page, moon } = THEMES[theme];
    return {
        type: 'frame',
        unit,
        layers: layers.map(([colour, cells]) => ({ colour, cells })),
        boss: { cells: 13, notch: 3, outside: page, ornaments: [moon, 'clover', 'carrot', moon] },
    };
}

function plaque(theme, widthCells, heightCells, left, unit, centreY = BANNER.height / 2) {
    return {
        type: 'bar',
        unit,
        widthCells,
        heightCells,
        layers: THEMES[theme].plaque.map(([colour, inset, notch]) => ({ colour, inset, notch })),
        studs: { colour: 'gold', cells: 2, inset: 4 },
        at: { left, centerY: centreY },
    };
}

/** The backdrop of a theme as github-backdrops.json crops it: the step, the place and the bleed are the crop's. */
function backdrop(theme, variant, mirror, backdrops) {
    const { plate } = THEMES[theme];
    if (!Object.hasOwn(backdrops.plates, plate)) {
        throw new Error(`github-backdrops.json has no plate "${plate}", which the ${theme} layouts are set on.`);
    }
    const crop = resolvePlate(backdrops, plate).variants[variant];
    if (!crop) {
        throw new Error(`github-backdrops.json: the plate "${plate}" has no "${variant}" crop, which the ${theme} ${variant} layouts are set on.`);
    }
    const { step, at, bleed } = crop;
    return {
        type: 'backdrop',
        source: backdropName(plate, variant),
        step,
        at: { ...at },
        ...(bleed ? { bleed: true } : {}),
        ...(mirror ? { mirror: true } : {}),
    };
}

/**
 * The one look of every contact shadow. The light of the plate moves a shadow to the right by `light.x` blocks, and a mirrored plate has
 * its light on the other side.
 */
function shadow(theme, mirror, backdrops) {
    const { x } = backdrops.plates[THEMES[theme].plate].light;
    return { tint: 'plum', bands: 3, inset: 4, strengths: { contact: 1, footprint: 0.6, raised: 0.5 }, offset: { x: mirror ? -x : x, y: 0 } };
}

const artElement = (source, at, theme, mirror, backdrops) => ({ type: 'art', source, step: 2, shadow: shadow(theme, mirror, backdrops), at });

/** A bar of three blocks drawn like the edge of the plaque: its outer layer, its inner one, and a small gold stud at each end. */
function separator(theme, widthCells, left, top, unit) {
    const [outer, inner] = THEMES[theme].plaque;
    return {
        type: 'bar',
        unit,
        widthCells,
        heightCells: 3,
        layers: [{ colour: outer[0], inset: 0, notch: 1 }, { colour: inner[0], inset: 1, notch: 0 }],
        studs: { colour: 'gold', cells: 1, inset: 1 },
        at: { left, top },
    };
}

/**
 * The logo plate and the wordmark side by side, a separator, and under it the subtitle, all centred in a plaque that is sized to them.
 * The baseline of the wordmark is on the baseline of the SB in the plate. On the light plaque the plate has a keyline of one block,
 * because its lavender edge is 1.3:1 on the cream; on the night fill it is 12:1 and has none. Both themes keep the room for the keyline, so
 * that the two banners have the same geometry.
 */
function lockup(theme, { plateSize, wordmarkSize: wordmark, subtitleSize: subtitle, centreY, unit, padX, padY, gap, separatorGap, left }, metrics) {
    const keyline = unit;
    const word = metrics.wordmark[wordmark];
    const sub = metrics.subtitle[subtitle];
    const plateBox = plateSize + 2 * keyline;
    const baseline = keyline + Math.round(PLATE_LETTERING_BASELINE * plateSize);
    const wordmarkTop = baseline - Math.round(wordmarkBaseline(wordmark));
    const rowTop = Math.min(0, wordmarkTop);
    const rowHeight = Math.max(plateBox, wordmarkTop + word.height) - rowTop;
    const rowWidth = plateBox + gap + word.width;
    const barCells = Math.ceil(rowWidth / unit);
    const contentWidth = Math.max(rowWidth, sub.width, barCells * unit);
    const contentHeight = rowHeight + separatorGap + 3 * unit + separatorGap + sub.height;
    const widthCells = Math.ceil((contentWidth + 2 * padX) / unit);
    const heightCells = Math.ceil((contentHeight + 2 * padY) / unit);
    const plaqueWidth = widthCells * unit;
    const top = centreY - Math.floor(contentHeight / 2);
    const origin = top - rowTop;
    const rowLeft = left + Math.floor((plaqueWidth - rowWidth) / 2);
    const separatorTop = top + rowHeight + separatorGap;
    return [
        plaque(theme, widthCells, heightCells, left, unit, centreY),
        {
            type: 'plate',
            size: plateSize,
            at: { left: rowLeft + keyline, top: origin + keyline },
            ...(theme === 'light' ? { edge: { outline: { colour: 'plum', width: keyline } } } : {}),
        },
        { type: 'wordmark', size: wordmark, colour: THEMES[theme].ink, line: 'baseline', at: { left: rowLeft + plateBox + gap, lineY: origin + baseline } },
        separator(theme, barCells, left + Math.floor((plaqueWidth - barCells * unit) / 2), separatorTop, unit),
        {
            type: 'subtitle',
            lines: [...SUBTITLE_LINES],
            size: subtitle,
            colour: SUBTITLE_INK[theme],
            align: 'centre',
            at: { top: separatorTop + 3 * unit + separatorGap, centerX: left + Math.floor(plaqueWidth / 2) },
        },
    ];
}

/** The icon and the title of a section in a plaque of its own, which is as high as the title and the icon need. */
function sectionPlaque(theme, { slot, side, maxWidth }, metrics) {
    const { width, height } = metrics.titles[slot];
    const multiline = height > MULTILINE_TITLE_HEIGHT;
    const iconUnit = multiline ? MULTILINE_ICON_UNIT : BANNER.iconUnit;
    const iconSize = metrics.icons[slot] * iconUnit;
    const contentWidth = iconSize + BANNER.iconGap + width;
    const widthCells = Math.ceil((2 * BANNER.padX + contentWidth) / BANNER.unit);
    const heightCells = Math.ceil((Math.max(height, iconSize) + 2 * BANNER.padY) / BANNER.unit);
    const left = side === 'left' ? BANNER.width - BANNER.outer - widthCells * BANNER.unit : BANNER.outer;
    const middle = BANNER.height / 2;
    const line = multiline ? { centerY: middle } : { lineY: middle };
    return [
        plaque(theme, widthCells, heightCells, left, BANNER.unit),
        { type: 'icon', icon: slot, palette: THEMES[theme].icons, unit: iconUnit, at: { left: left + BANNER.padX, ...line } },
        { type: 'title', title: slot, size: BANNER.titleSize, colour: THEMES[theme].ink, at: { left: left + BANNER.padX + iconSize + BANNER.iconGap, ...line }, ...(maxWidth ? { maxWidth } : {}) },
    ];
}

function bannerLayout(section, theme, { metrics, art, backdrops }) {
    const { slot, side } = section;
    const mirror = side === 'left';
    const artTop = BANNER.height - BANNER.frame - BANNER.ground - 2 * art[`banner-${slot}`].height;
    const artAt = { [mirror ? 'left' : 'right']: BANNER.artEdge, top: artTop };
    const isMain = slot === 'main';
    const middle = BANNER.height / 2;
    const content = isMain
        ? lockup(theme, { plateSize: MAIN_PLATE, wordmarkSize: MAIN_WORDMARK, subtitleSize: MAIN_SUBTITLE, centreY: middle, unit: BANNER.unit, padX: BANNER.padX, padY: 40, gap: 40, separatorGap: 28, left: BANNER.outer }, metrics)
        : sectionPlaque(theme, section, metrics);
    const note = isMain
        ? 'Main: the logo plate and the wordmark on one baseline, the pair large on the right.'
        : `Grove: a plaque drawn like the frame holds the icon and the title; the pair on the ${mirror ? 'left' : 'right'}.`;
    return {
        id: `banner-${slot}-${theme}`,
        asset: 'banner',
        note,
        background: THEMES[theme].page,
        height: BANNER.height,
        elements: [backdrop(theme, 'banner', mirror, backdrops), ...content, artElement(`banner-${slot}`, artAt, theme, mirror, backdrops), frame(theme, BANNER.unit)],
    };
}

function socialLayout({ metrics, art, backdrops }) {
    const theme = 'light';
    const artTop = SOCIAL.height - SOCIAL.frame - SOCIAL.ground - 2 * art['social-welcome'].height;
    const content = lockup(theme, { plateSize: SOCIAL_PLATE, wordmarkSize: SOCIAL_WORDMARK, subtitleSize: SOCIAL_SUBTITLE, centreY: SOCIAL.height / 2, unit: SOCIAL.unit, padX: 40, padY: 28, gap: 24, separatorGap: 14, left: 3 * SOCIAL.unit + 28 }, metrics);
    return {
        id: 'social-grove',
        asset: 'social',
        note: 'Social: the logo plaque at the left with the pair large on the right, the pair on the ground.',
        background: 'pale',
        elements: [backdrop(theme, 'social', false, backdrops), ...content, artElement('social-welcome', { right: SOCIAL.artRight, top: artTop }, theme, false, backdrops), frame(theme, SOCIAL.unit)],
    };
}

/** The sizes that the layouts are positioned from, as the drawing code measures them. */
function measure(icons) {
    const iconGrids = Object.fromEntries(Object.entries(icons.shapes).map(([name, { rows }]) => [name, rows.length]));
    const wordmark = Object.fromEntries([MAIN_WORDMARK, SOCIAL_WORDMARK].map((size) => [size, wordmarkSize(size)]));
    const subtitle = Object.fromEntries([SOCIAL_SUBTITLE, MAIN_SUBTITLE].map((size) => [size, subtitleSize(SUBTITLE_LINES, { size })]));
    const titles = Object.fromEntries(SECTIONS.filter(({ slot }) => slot !== 'main').map(({ slot, maxWidth }) => [slot, titleSize(slot, maxWidth ? { size: BANNER.titleSize, maxWidth } : { size: BANNER.titleSize })]));
    return { wordmark, subtitle, titles, icons: iconGrids };
}

/**
 * The config of the GitHub assets, as an object ready to be written as JSON: every layout positioned from the drawn sizes, with the
 * contacts and the parts as they are in their files.
 * @param {string} rootDir the package folder (assets-src/branding)
 * @returns {Promise<object>}
 */
export async function buildGithubConfig(rootDir) {
    const parts = readJson(rootDir, 'github-parts.json');
    const contacts = readJson(rootDir, 'github-contacts.json');
    const backdrops = loadBackdropConfig(rootDir);
    const artNames = [...SECTIONS.map(({ slot }) => `banner-${slot}`), 'social-welcome'];
    const art = Object.fromEntries(await Promise.all(artNames.map(async (name) => {
        const { width, height } = await loadArt(join(rootDir, PIXEL_PATH(name)));
        return [name, { width, height }];
    })));
    const context = { metrics: measure(parts.icons), art, backdrops };
    const layouts = [...parts.avatars, socialLayout(context)];
    for (const section of SECTIONS) {
        for (const theme of ['light', 'dark']) {
            layouts.push(bannerLayout(section, theme, context));
        }
    }
    return {
        colours: parts.colours,
        sources: {
            plate: 'approved/logo-plate.svg',
            emblem: 'approved/logo-emblem.svg',
            art: Object.fromEntries(artNames.map((name) => [name, PIXEL_PATH(name)])),
            backdrops: Object.fromEntries(BACKDROPS.map(([plate, variant]) => [backdropName(plate, variant), PIXEL_PATH(backdropName(plate, variant))])),
            placeholders: {},
        },
        icons: parts.icons,
        ornaments: parts.ornaments,
        assets: {
            avatar: { width: 500, height: 500, maxBytes: 1000000 },
            social: { width: SOCIAL.width, height: SOCIAL.height, maxBytes: 1000000 },
            banner: { width: BANNER.width, height: BANNER.height, maxBytes: 1000000 },
        },
        final: {
            avatar: 'avatar.png',
            social: 'social-preview.png',
            ...Object.fromEntries(SECTIONS.flatMap(({ slot }) => ['light', 'dark'].map((theme) => [`banner-${slot}-${theme}`, `banner-${slot}-${theme}.png`]))),
        },
        chosen: { avatar: 'avatar-fill', social: 'social-grove' },
        contacts,
        layouts,
    };
}

/** The text of github-config.json for a config object. */
export const githubConfigText = (config) => `${JSON.stringify(config, null, 1)}\n`;
