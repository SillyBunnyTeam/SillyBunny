import sharp from 'sharp';

const BACKGROUND = { r: 58, g: 58, b: 66, alpha: 1 };
const BACKDROP = { r: 112, g: 112, b: 120, alpha: 1 };

const escapeXml = (text) => text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&apos;' })[c]);

function labelSvg(text, width, height) {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="4" y="${Math.round(height * 0.7)}" font-family="sans-serif" font-size="${Math.round(height * 0.55)}" fill="#ffffff">${escapeXml(text)}</text></svg>`);
}

/** Largest size that fits inside the box and keeps the image's own aspect. */
function fitInside(width, height, boxWidth, boxHeight) {
    const scale = Math.min(boxWidth / width, boxHeight / height);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Builds a labelled grid image. Each image is scaled to fit inside the cell box at its own aspect ratio,
 * so a 3:2 sheet next to a 2:3 portrait leaves no empty bars. A row is as tall as its tallest image.
 * Use `nearest` for pixel art so enlarged pixels stay square.
 * With `scales` (whole numbers) every image is instead shown at each scale, exactly width x scale by height x scale,
 * with nearest-neighbour resizing, so a native-size sprite can be compared at 1x and 4x. `cellWidth` and `cellHeight` are not used then.
 * An item's `image` is a file path or a PNG buffer; `path` is accepted as the old name for a file path.
 * @param {Array<{ image?: string | Buffer, path?: string, label: string }>} items
 * @param {{ cols: number, cellWidth: number, cellHeight: number, gap: number, labelHeight: number, nearest: boolean, scales?: number[] }} layout
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function buildContactSheet(items, { cols, cellWidth, cellHeight, gap, labelHeight, nearest, scales }) {
    if (items.length === 0) {
        throw new Error('Contact sheet has no images.');
    }
    if (scales && (scales.length === 0 || !scales.every((scale) => Number.isInteger(scale) && scale >= 1))) {
        throw new Error('Contact sheet scales must be whole numbers of 1 or more.');
    }
    const useNearest = nearest || Boolean(scales);
    const columns = Math.min(cols, scales ? items.length * scales.length : items.length);
    const placed = [];
    for (const item of items) {
        const source = item.image ?? item.path;
        const { width, height } = await sharp(source).metadata();
        if (scales) {
            placed.push(...scales.map((scale) => ({ source, label: `${item.label} ${scale}x`, width: width * scale, height: height * scale })));
        } else {
            placed.push({ source, label: item.label, ...fitInside(width, height, cellWidth, cellHeight) });
        }
    }

    const layers = [];
    let top = gap;
    let sheetWidth = 0;
    for (let start = 0; start < placed.length; start += columns) {
        const row = placed.slice(start, start + columns);
        let left = gap;
        for (const [offset, item] of row.entries()) {
            const scaled = await sharp(item.source)
                .resize(item.width, item.height, { kernel: useNearest ? 'nearest' : 'lanczos3' })
                .png()
                .toBuffer();
            layers.push({ input: await sharp({ create: { width: item.width, height: item.height, channels: 4, background: BACKDROP } }).png().toBuffer(), left, top });
            layers.push({ input: scaled, left, top });
            if (labelHeight > 0) {
                layers.push({ input: labelSvg(`${start + offset + 1}. ${item.label}`, item.width, labelHeight), left, top: top + item.height });
            }
            left += item.width + gap;
        }
        sheetWidth = Math.max(sheetWidth, left);
        top += Math.max(...row.map((item) => item.height)) + labelHeight + gap;
    }
    return sharp({ create: { width: sheetWidth, height: top, channels: 4, background: BACKGROUND } }).composite(layers).png().toBuffer();
}
