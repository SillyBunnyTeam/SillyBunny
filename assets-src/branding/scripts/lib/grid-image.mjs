import sharp from 'sharp';

const LINE = 'rgba(255,0,110,0.55)';
const escape = (text) => text.replace(/[<>&]/g, '');

/**
 * Draws a coordinate grid over a picture so a person can read rect coordinates off it.
 * Lines fall on every `step` pixels of the SOURCE image even when a crop is zoomed, and each line is labelled with
 * its source coordinate. Everything between the lines is left as it was.
 * @param {Buffer | string} input
 * @param {{ step: number, crop?: { x: number, y: number, width: number, height: number }, zoom?: number }} options
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function drawGrid(input, { step, crop, zoom = 1 }) {
    if (!Number.isInteger(step) || step < 2) {
        throw new Error('The grid step must be a whole number of 2 or more.');
    }
    if (!Number.isInteger(zoom) || zoom < 1) {
        throw new Error('The zoom must be a whole number of 1 or more.');
    }
    const { width, height } = await sharp(input).metadata();
    const area = crop ?? { x: 0, y: 0, width, height };
    if (area.x < 0 || area.y < 0 || area.width < 1 || area.height < 1 || area.x + area.width > width || area.y + area.height > height) {
        throw new Error(`The crop [${area.x},${area.y},${area.width},${area.height}] is outside the ${width}x${height} image.`);
    }
    const outWidth = area.width * zoom;
    const outHeight = area.height * zoom;
    const fontSize = Math.max(11, Math.min(18, Math.round(Math.min(outWidth, outHeight) / 45)));

    const parts = [];
    const label = (text, x, y) => `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" fill="#000" stroke="#fff" stroke-width="3" paint-order="stroke">${escape(text)}</text>`;
    for (let sourceX = Math.ceil(area.x / step) * step; sourceX < area.x + area.width; sourceX += step) {
        const x = (sourceX - area.x) * zoom;
        parts.push(`<line x1="${x + 0.5}" y1="0" x2="${x + 0.5}" y2="${outHeight}" stroke="${LINE}" stroke-width="1"/>`, label(String(sourceX), x + 3, fontSize + 2));
    }
    for (let sourceY = Math.ceil(area.y / step) * step; sourceY < area.y + area.height; sourceY += step) {
        const y = (sourceY - area.y) * zoom;
        parts.push(`<line x1="0" y1="${y + 0.5}" x2="${outWidth}" y2="${y + 0.5}" stroke="${LINE}" stroke-width="1"/>`, label(String(sourceY), 3, y - 3));
    }
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}">${parts.join('')}</svg>`);

    let image = sharp(input).extract({ left: area.x, top: area.y, width: area.width, height: area.height });
    if (zoom > 1) {
        image = image.resize(outWidth, outHeight, { kernel: 'lanczos3' });
    }
    return sharp(await image.png().toBuffer()).composite([{ input: overlay }]).png().toBuffer();
}
