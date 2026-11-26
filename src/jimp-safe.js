import { ResizeStrategy } from '@jimp/plugin-resize';

function assertJimpLikeImage(image) {
    if (!image?.bitmap || typeof image.bitmap.width !== 'number' || typeof image.bitmap.height !== 'number') {
        throw new TypeError('Expected a Jimp-like image instance');
    }
}

function clampCropRegion(image, { x = 0, y = 0, w = image.bitmap.width, h = image.bitmap.height } = {}) {
    const sourceWidth = Math.max(1, Math.round(image.bitmap.width));
    const sourceHeight = Math.max(1, Math.round(image.bitmap.height));

    let cropX = Number.isFinite(x) ? Math.round(x) : 0;
    let cropY = Number.isFinite(y) ? Math.round(y) : 0;
    let cropWidth = Number.isFinite(w) ? Math.round(w) : sourceWidth;
    let cropHeight = Number.isFinite(h) ? Math.round(h) : sourceHeight;

    cropWidth = Math.max(1, cropWidth);
    cropHeight = Math.max(1, cropHeight);
    cropX = Math.max(0, Math.min(cropX, sourceWidth - 1));
    cropY = Math.max(0, Math.min(cropY, sourceHeight - 1));
    cropWidth = Math.max(1, Math.min(cropWidth, sourceWidth - cropX));
    cropHeight = Math.max(1, Math.min(cropHeight, sourceHeight - cropY));

    return { x: cropX, y: cropY, w: cropWidth, h: cropHeight };
}

function ensureBitmapBuffer(image) {
    if (!Buffer.isBuffer(image.bitmap.data)) {
        image.bitmap.data = Buffer.from(image.bitmap.data);
    }

    return image.bitmap.data;
}

/**
 * Bun currently throws inside Buffer.writeUInt32BE(), which breaks Jimp's crop/cover plugins.
 * Copy rows directly so image processing stays stable on Bun.
 * @param {import('./jimp.js').Jimp} image
 * @param {{x?: number, y?: number, w?: number, h?: number}} options
 * @returns {import('./jimp.js').Jimp}
 */
export function safeCrop(image, options = {}) {
    assertJimpLikeImage(image);

    const { x, y, w, h } = clampCropRegion(image, options);
    const sourceData = ensureBitmapBuffer(image);
    const sourceWidth = image.bitmap.width;
    const rowBytes = w * 4;
    const bitmap = Buffer.allocUnsafe(rowBytes * h);

    for (let row = 0; row < h; row++) {
        const sourceStart = (((y + row) * sourceWidth) + x) * 4;
        sourceData.copy(bitmap, row * rowBytes, sourceStart, sourceStart + rowBytes);
    }

    image.bitmap.data = bitmap;
    image.bitmap.width = w;
    image.bitmap.height = h;
    return image;
}

/**
 * Resizes to fill the target box, then crops the overflow.
 * Mirrors Jimp's cover behavior without relying on the broken crop plugin.
 * Clamps scale to 1 by default (withoutEnlargement) so smaller images are never upscaled.
 * @param {import('./jimp.js').Jimp} image
 * @param {{w: number, h: number, mode?: ResizeStrategy, withoutEnlargement?: boolean}} options
 * @returns {import('./jimp.js').Jimp}
 */
export function safeCover(image, { w, h, mode = ResizeStrategy.BILINEAR, withoutEnlargement = true }) {
    assertJimpLikeImage(image);

    const targetWidth = Math.max(1, Math.round(Number(w) || 0));
    const targetHeight = Math.max(1, Math.round(Number(h) || 0));
    const sourceWidth = Math.max(1, image.bitmap.width);
    const sourceHeight = Math.max(1, image.bitmap.height);
    const rawScale = targetWidth / targetHeight > sourceWidth / sourceHeight
        ? targetWidth / sourceWidth
        : targetHeight / sourceHeight;
    // SillyBunny: clamp cover scale to <= 1 by default so smaller cards are never upscaled into bloated bitmaps.
    const scale = withoutEnlargement ? Math.min(1, rawScale) : rawScale;

    let cropWidth = targetWidth;
    let cropHeight = targetHeight;

    if (withoutEnlargement && rawScale > 1) {
        const downscaleFactor = 1 / rawScale;
        cropWidth = Math.max(1, Math.min(sourceWidth, Math.round(targetWidth * downscaleFactor)));
        cropHeight = Math.max(1, Math.min(sourceHeight, Math.round(targetHeight * downscaleFactor)));
    } else {
        const resizedWidth = Math.max(targetWidth, Math.round(sourceWidth * scale));
        const resizedHeight = Math.max(targetHeight, Math.round(sourceHeight * scale));
        if (resizedWidth !== sourceWidth || resizedHeight !== sourceHeight) {
            image.resize({
                w: resizedWidth,
                h: resizedHeight,
                mode,
            });
        }
    }

    if (image.bitmap.width === cropWidth && image.bitmap.height === cropHeight) {
        return image;
    }

    return safeCrop(image, {
        x: Math.round((image.bitmap.width - cropWidth) / 2),
        y: Math.round((image.bitmap.height - cropHeight) / 2),
        w: cropWidth,
        h: cropHeight,
    });
}
