import sharp from 'sharp';

/** @typedef {Map<string, { layout: { id: string, asset: string, note: string, width: number, height: number }, png: Buffer, placeholders: string[] }>} Built */

const LIGHT_PAGE = '#ffffff';
// GitHub's dark theme page background.
const DARK_PAGE = '#0d1117';
const SHEET_BACKGROUND = '#e8e8ec';
const GAP = 24;
const LABEL_HEIGHT = 30;
/** The sizes that GitHub shows an avatar at in lists and mentions, with the largest first. */
const SMALL_AVATAR_SIZES = Object.freeze([40, 32, 24]);
const ZOOM = 4;

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** A line of text for a sheet. A sheet is for review and is not shipped, so it uses the system's sans-serif. */
export async function label(text, width) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_HEIGHT}"><text x="0" y="21" font-family="sans-serif" font-size="18" fill="#222">${escapeXml(text)}</text></svg>`;
    return { input: await sharp(Buffer.from(svg)).png().toBuffer(), width, height: LABEL_HEIGHT };
}

export async function resized(png, width, height, { kernel = 'lanczos3', background } = {}) {
    const image = sharp(png).resize(width, height, { kernel });
    return { input: await (background ? image.flatten({ background }) : image).png().toBuffer(), width, height };
}

/**
 * A part of a picture, a PNG or a raster, enlarged `zoom` times by copying pixels, as a piece of a sheet. `box` ({ x, y, width, height })
 * says which part, the whole picture when it is left out; `background` is flattened under a picture that has transparent pixels.
 * @param {Buffer | import('./raster.mjs').Raster} source
 * @param {{ zoom: number, box?: { x: number, y: number, width: number, height: number }, background?: string }} options
 */
export async function enlarged(source, { zoom, box, background }) {
    const open = () => (Buffer.isBuffer(source) ? sharp(source) : sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } }));
    const whole = Buffer.isBuffer(source) ? await open().metadata() : source;
    const { width, height } = box ?? whole;
    let image = open();
    if (box) {
        image = image.extract({ left: box.x, top: box.y, width, height });
    }
    if (background) {
        image = image.flatten({ background });
    }
    const size = { width: width * zoom, height: height * zoom };
    return { input: await image.resize(size.width, size.height, { kernel: 'nearest' }).png().toBuffer(), ...size };
}

/** Lays pieces out as rows, each row left to right with `GAP` between pieces, and returns the sheet as a PNG. */
async function sheetOf(rows) {
    const rowWidth = (row) => row.reduce((sum, piece) => sum + piece.width, 0) + GAP * (row.length - 1);
    const rowHeight = (row) => Math.max(...row.map((piece) => piece.height));
    const width = Math.max(...rows.map(rowWidth)) + 2 * GAP;
    const height = rows.reduce((sum, row) => sum + rowHeight(row) + GAP, GAP);
    const composites = [];
    let top = GAP;
    for (const row of rows) {
        let left = GAP;
        for (const piece of row) {
            composites.push({ input: piece.input, left, top });
            left += piece.width + GAP;
        }
        top += rowHeight(row) + GAP;
    }
    return sharp({ create: { width, height, channels: 3, background: SHEET_BACKGROUND } }).composite(composites).png({ compressionLevel: 9 }).toBuffer();
}

/** Each avatar at half size, then at the small sizes GitHub uses, on the light and the dark page, with a zoomed copy of the 40 px one. */
async function avatarSheet(built) {
    const rows = [];
    for (const { layout, png } of [...built.values()].filter(({ layout }) => layout.asset === 'avatar')) {
        rows.push([await label(`${layout.id}: ${layout.note}`, 1300)]);
        for (const page of [LIGHT_PAGE, DARK_PAGE]) {
            const row = [await resized(png, 250, 250, { background: page })];
            for (const size of SMALL_AVATAR_SIZES) {
                row.push(await resized(png, size, size, { background: page }));
            }
            const small = await resized(png, SMALL_AVATAR_SIZES[0], SMALL_AVATAR_SIZES[0], { background: page });
            row.push(await resized(small.input, SMALL_AVATAR_SIZES[0] * ZOOM, SMALL_AVATAR_SIZES[0] * ZOOM, { kernel: 'nearest' }));
            rows.push(row);
        }
    }
    return sheetOf(rows);
}

/** The width at which GitHub shows a README image on a desktop page, and the width of the link card that shows a social preview. */
export const README_WIDTH = 880;
const LINK_CARD_WIDTH = 400;
const PAGE_MARGIN = 40;
const PAGE_GAP = 40;

/** A banner as the README shows it: scaled to 880 pixels wide with a smooth filter, unframed. */
export async function readmeImage(png) {
    const { width, height } = await sharp(png).metadata();
    return sharp(png).resize(README_WIDTH, Math.round((height * README_WIDTH) / width), { kernel: 'lanczos3' }).png().toBuffer();
}

/** A banner id is banner-<section>-<theme>. */
const BANNER_ID = /^banner-[a-z]+-(light|dark)$/;

/** The banners of one theme, in config order. @param {Built} built @param {'light' | 'dark'} theme */
const bannersOfTheme = (built, theme) => [...built.values()].filter(({ layout }) => layout.asset === 'banner' && BANNER_ID.exec(layout.id)?.[1] === theme);

/**
 * The banners of one theme stacked as a README page would stack them, in the order of the config, each at 880 pixels wide on the
 * page colour of that theme, so the edge of each shows against the page as it will on GitHub.
 * @param {Built} built
 * @param {'light' | 'dark'} theme
 */
async function readmeSheet(built, theme) {
    const page = theme === 'dark' ? DARK_PAGE : LIGHT_PAGE;
    const banners = bannersOfTheme(built, theme);
    const images = await Promise.all(banners.map(({ png }) => readmeImage(png)));
    const heights = await Promise.all(images.map(async (image) => (await sharp(image).metadata()).height));
    const composites = [];
    let top = PAGE_MARGIN;
    images.forEach((input, at) => {
        composites.push({ input, left: PAGE_MARGIN, top });
        top += heights[at] + PAGE_GAP;
    });
    const height = top - PAGE_GAP + PAGE_MARGIN;
    return sharp({ create: { width: README_WIDTH + 2 * PAGE_MARGIN, height, channels: 3, background: page } }).composite(composites).png({ compressionLevel: 9 }).toBuffer();
}

/** Each social preview at full size, and at the width of the link card that GitHub shows it in. */
async function socialSheets(built) {
    const sheets = new Map();
    for (const { layout, png } of [...built.values()].filter(({ layout }) => layout.asset === 'social')) {
        sheets.set(`${layout.id}-full.png`, png);
        sheets.set(`${layout.id}-${LINK_CARD_WIDTH}.png`, (await resized(png, LINK_CARD_WIDTH, Math.round((layout.height * LINK_CARD_WIDTH) / layout.width))).input);
    }
    return sheets;
}

const SHADOW_ZOOM = 2;
/** How much of a layout round the art the shadow sheet shows: this far each side of it, and this far above the bottom of the art. */
const SHADOW_MARGIN = 120;
const SHADOW_ABOVE = 200;
/** Each kind of contact has an outline colour of its own on the sheet, and an outline reaches this many rows of art up from its ground row. */
const KIND_OUTLINE = Object.freeze({ contact: '#ff2fd0', footprint: '#00c8ff', raised: '#ffe600' });
const OUTLINE_ROWS = 6;

/** The feet strip of one layout, twice at 2x: with the configured contacts outlined by kind, and as painted. */
async function shadowTiles({ layout, png, placements }) {
    const art = placements.find(({ type, contacts }) => type === 'art' && contacts);
    const left = Math.max(0, art.x - SHADOW_MARGIN);
    const top = Math.max(0, art.y + art.height - SHADOW_ABOVE);
    const box = { x: left, y: top, width: Math.min(layout.width, art.x + art.width + SHADOW_MARGIN) - left, height: layout.height - top };
    const painted = await enlarged(png, { zoom: SHADOW_ZOOM, box });
    const size = { width: painted.width, height: painted.height };
    const outlines = art.contacts.map(({ kind, x0, x1, y }) => {
        const x = (art.x + x0 * art.step - left) * SHADOW_ZOOM;
        const bottom = (art.y + (y + 1) * art.step - top) * SHADOW_ZOOM;
        const rectangle = { width: (x1 - x0 + 1) * art.step * SHADOW_ZOOM, height: OUTLINE_ROWS * art.step * SHADOW_ZOOM };
        return `<rect x="${x}" y="${bottom - rectangle.height}" width="${rectangle.width}" height="${rectangle.height}" fill="${KIND_OUTLINE[kind]}" fill-opacity="0.2" stroke="${KIND_OUTLINE[kind]}" stroke-width="3"/>`;
    });
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}">${outlines.join('')}</svg>`);
    const outlined = await sharp(painted.input).composite([{ input: overlay }]).png().toBuffer();
    return { outlined: { input: outlined, ...size }, painted, art };
}

/**
 * The contact shadows to check by eye: for every layout that draws a scene with contacts, the strip of the feet at 2x, once with each
 * configured contact outlined by kind (contact magenta, footprint cyan, raised yellow, each as wide as its columns and 6 rows of art high
 * above its ground row), and once as painted. Under each pair is the list of its contacts.
 * @param {Built} built
 * @returns {Promise<Buffer | undefined>} nothing when no layout has a contact shadow
 */
async function shadowSheet(built) {
    const rows = [];
    for (const entry of built.values()) {
        if (!entry.placements?.some(({ type, contacts }) => type === 'art' && contacts)) {
            continue;
        }
        const { outlined, painted, art } = await shadowTiles(entry);
        const list = art.contacts.map(({ kind, x0, x1, y, strength }) => `${kind} ${x0}-${x1}@${y}${strength === undefined ? '' : ` (${strength})`}`).join(', ');
        rows.push([await label(`${entry.layout.id}: ${list}`, outlined.width * 2 + GAP)], [outlined, painted]);
    }
    return rows.length > 0 ? sheetOf(rows) : undefined;
}

/**
 * The review sheets of a run: the avatars at the sizes GitHub shows them, the banners of each theme stacked as the README stacks them,
 * each social preview at full size and at the width of a link card, and the feet of every scene with its contact shadows outlined.
 * @param {Built} built
 * @returns {Promise<Map<string, Buffer>>}
 */
export async function buildSheets(built) {
    const shadows = await shadowSheet(built);
    return new Map([
        ['avatars.png', await avatarSheet(built)],
        ['readme-light.png', await readmeSheet(built, 'light')],
        ['readme-dark.png', await readmeSheet(built, 'dark')],
        ...await socialSheets(built),
        ...(shadows ? [['shadows.png', shadows]] : []),
    ]);
}

const SCENE_ZOOM = 2;
const SCENE_BACKGROUND = '#6b6b80';
const FRAME_COLOUR = '#ff2fd0';

/**
 * Every snapped scene at 2x, nearest neighbour, on a flat grey with the picture's own edge drawn in magenta, so a sticker that was cut
 * by the edge shows as a drawing that runs into the frame. A label under each says the size and the margins in art pixels.
 * @param {{ name: string, raster: { width: number, height: number, data: Buffer }, margins: { left: number, top: number, right: number, bottom: number }, lineup: { ratio: number, verdict: string, comparable: boolean } }[]} scenes
 */
export async function scenesSheet(scenes) {
    const perRow = 4;
    const tiles = [];
    for (const { name, raster, margins, lineup } of scenes) {
        const width = raster.width * SCENE_ZOOM;
        const height = raster.height * SCENE_ZOOM;
        const picture = await enlarged(raster, { zoom: SCENE_ZOOM });
        const frame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="${FRAME_COLOUR}" stroke-width="2"/></svg>`);
        const input = await sharp({ create: { width, height, channels: 3, background: SCENE_BACKGROUND } }).composite([{ input: picture.input }, { input: frame }]).png().toBuffer();
        const heights = lineup.comparable ? `Tewi/Reisen ${lineup.ratio.toFixed(3)} ${lineup.verdict.toUpperCase()}` : `Tewi/Reisen ${lineup.ratio.toFixed(3)} (mixed poses, not judged)`;
        tiles.push([await label(`${name} ${raster.width}x${raster.height}  L${margins.left} T${margins.top} R${margins.right} B${margins.bottom}  ${heights}`, width), { input, width, height }]);
    }
    const rows = [];
    for (let at = 0; at < tiles.length; at += perRow) {
        const chunk = tiles.slice(at, at + perRow);
        rows.push(chunk.map(([text]) => text), chunk.map(([, picture]) => picture));
    }
    return sheetOf(rows);
}

const REPAIR_ZOOM = 8;
const REPAIR_MARGIN = 26;

/**
 * A repair as it was and as it is: the union of the repaired boxes with a margin, from the snap before the repair on the left and after it
 * on the right, at 8x, nearest neighbour, on the dark banner colour.
 * @param {{ before: { width: number, height: number, data: Buffer }, after: { width: number, height: number, data: Buffer }, boxes: { x: number, y: number, width: number, height: number }[] }} repair
 */
export async function repairSheet({ before, after, boxes }) {
    const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - REPAIR_MARGIN);
    const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - REPAIR_MARGIN);
    const right = Math.min(after.width, Math.max(...boxes.map((box) => box.x + box.width)) + REPAIR_MARGIN);
    const bottom = Math.min(after.height, Math.max(...boxes.map((box) => box.y + box.height)) + REPAIR_MARGIN);
    const part = (raster) => enlarged(raster, { zoom: REPAIR_ZOOM, box: { x: left, y: top, width: right - left, height: bottom - top }, background: '#1c1228' });
    const [shownBefore, shownAfter] = await Promise.all([part(before), part(after)]);
    const pieces = [[await label('before', shownBefore.width), await label('after', shownAfter.width)], [shownBefore, shownAfter]];
    return sheetOf(pieces);
}
