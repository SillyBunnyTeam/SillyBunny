/**
 * Measures whether pixel art on a page is drawn as even blocks of device pixels.
 *
 * Every opaque art pixel of a picture must be drawn as one block of `step` x `step` device pixels in its own colour.
 * The check reads the screenshot and the picture file in the page, with the decoder of the browser, so the test needs
 * no image library. Only a browser that really runs at the screen scale can pass it: Playwright's `deviceScaleFactor`
 * emulation lays the page out in CSS pixels and shows seams that a real screen does not (see
 * `tests/art-pixel-evenness.e2e.js`).
 */

/**
 * Every figure on the page that is drawn, with where it sits in CSS pixels. A figure is a clip with a picture inside
 * (`.sbArtFigure`), or a picture of its own, such as the splash mascot.
 * @param {import('@playwright/test').Page} page
 * @param {{ scope?: string, figureSelector?: string }} [options]
 */
export async function readFigures(page, { scope = 'body', figureSelector = '.sbArtFigure' } = {}) {
    return page.evaluate(({ root, selector }) => [...document.querySelector(root).querySelectorAll(selector)]
        .filter(figure => !figure.closest('[inert]') && figure.getBoundingClientRect().width > 0)
        .map((figure) => {
            const image = figure instanceof HTMLImageElement ? figure : figure.firstElementChild;
            const box = figure.getBoundingClientRect();
            const mask = figure.closest('.sbArtPanel');
            return {
                id: figure.dataset.sbArtPlaceholder ?? figure.dataset.variant ?? figure.className,
                src: image.currentSrc,
                nativeWidth: image.naturalWidth,
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
                mode: mask?.dataset.sbArtMode ?? 'panel',
                panelHeight: mask?.getBoundingClientRect().height ?? box.height,
                panelTop: mask?.getBoundingClientRect().top ?? box.top,
            };
        }), { root: scope, selector: figureSelector });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ figures: (Awaited<ReturnType<typeof readFigures>>[number] & { step: number })[], ratio: number, shot: Buffer }} input
 * @returns {Promise<{ id: string, total: number, bad: number, offset: [number, number] }[]>}
 */
export async function measureEvenness(page, { figures, ratio, shot }) {
    return page.evaluate(async ({ figures: boxes, ratio: scale, shot: encoded }) => {
        const readPixels = (source, width, height) => {
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(source, 0, 0);
            return context.getImageData(0, 0, width, height);
        };
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
        const screen = readPixels(bitmap, bitmap.width, bitmap.height);
        const results = [];
        for (const box of boxes) {
            const blockSize = box.step;
            const image = new Image();
            image.src = box.src;
            await image.decode();
            const art = readPixels(image, image.naturalWidth, image.naturalHeight);
            // A banner fades out below 58% of its height, and the fade blends the figure into the surface.
            const lastRow = box.mode === 'banner'
                ? Math.floor(((box.panelTop + box.panelHeight * 0.5 - box.top) * scale) / blockSize)
                : image.naturalHeight;
            const rows = Math.min(image.naturalHeight, Math.floor((box.height * scale) / blockSize + 1e-6), lastRow);
            const left = Math.round(box.left * scale);
            const top = Math.round(box.top * scale);
            let best = null;
            for (let shiftY = -1; shiftY <= 1; shiftY++) {
                for (let shiftX = -1; shiftX <= 1; shiftX++) {
                    let total = 0;
                    let bad = 0;
                    for (let y = 0; y < rows; y++) {
                        for (let x = 0; x < image.naturalWidth; x++) {
                            const at = (y * image.naturalWidth + x) * 4;
                            if (art.data[at + 3] !== 255) {
                                continue;
                            }
                            total++;
                            let even = true;
                            for (let dy = 0; dy < blockSize && even; dy++) {
                                for (let dx = 0; dx < blockSize; dx++) {
                                    const sx = left + shiftX + x * blockSize + dx;
                                    const sy = top + shiftY + y * blockSize + dy;
                                    const from = (sy * screen.width + sx) * 4;
                                    if (Math.abs(screen.data[from] - art.data[at]) > 2
                                        || Math.abs(screen.data[from + 1] - art.data[at + 1]) > 2
                                        || Math.abs(screen.data[from + 2] - art.data[at + 2]) > 2) {
                                        even = false;
                                        break;
                                    }
                                }
                            }
                            if (!even) {
                                bad++;
                            }
                        }
                    }
                    if (best === null || bad < best.bad) {
                        best = { id: box.id, total, bad, offset: [shiftX, shiftY] };
                    }
                }
            }
            results.push(best);
        }
        return results;
    }, { figures, ratio, shot: shot.toString('base64') });
}
