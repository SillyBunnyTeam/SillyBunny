import { getPixelArt } from './art-sources.js';

/*
 * Pixel art is drawn so that one art pixel covers the same whole number of device pixels everywhere. A picture
 * that is scaled by a fraction has some art pixels one device pixel wider than their neighbours, and the figure
 * shows uneven stripes. This module owns the arithmetic, the picture element and the watch on the screen scale.
 */

const EPSILON = 1e-6;

/**
 * Share of a figure that a banner shows, from the top: the head down to the hips.
 * Kept in step with the 58% where the fade of `.sbArtPanel[data-sb-art-mode='banner']` starts.
 */
export const BANNER_SHARE = 0.62;

/** The screen scale, or 1 where the browser reports none. */
export function readDevicePixelRatio() {
    const ratio = globalThis.devicePixelRatio;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/**
 * Device pixels per art pixel. It rounds, so that on a 1.5 screen the art is a third larger than at 1x, where
 * flooring would make it a third smaller. From a 1.5 screen up, an art pixel then covers between two thirds and
 * four thirds of a CSS pixel. A step is never below 1, because a fraction of a device pixel cannot be drawn evenly.
 * @param {number} [ratio]
 * @returns {number}
 */
export function pixelStep(ratio = readDevicePixelRatio()) {
    return Math.max(1, Math.round(ratio));
}

/**
 * The CSS size of `artPixels` art pixels, at `step` device pixels each.
 * @param {number} artPixels
 * @param {number} step
 * @param {number} ratio The device pixel ratio.
 * @returns {number}
 */
export function pixelCssSize(artPixels, step, ratio) {
    return (artPixels * step) / ratio;
}

/**
 * The rows of a figure that a banner shows. A whole number, so the cut falls between two art pixels.
 * @param {number} artHeight
 * @param {number} [share]
 * @returns {number}
 */
export function bannerRows(artHeight, share = BANNER_SHARE) {
    return Math.max(1, Math.floor(artHeight * share + EPSILON));
}

/** Room for the rounding of a layout, in CSS pixels. */
const FIT_TOLERANCE = 0.01;

/**
 * The scale at which a row of figures fits `availableWidth`. The fixed step is kept when the row fits. Otherwise the
 * step goes down by whole device pixels until it does, which is the largest step that fits. Only when even one device
 * pixel per art pixel is too wide does the row shrink, by the fraction that it lacks: that is the one place where the
 * art is drawn at a fraction of a device pixel per art pixel, and it needs a container narrower than the row at its
 * native size.
 * @param {object} input
 * @param {number[]} input.widths The width of each figure in art pixels.
 * @param {number} [input.gap] The CSS pixels between two figures, which do not scale.
 * @param {number} input.step The fixed step of the screen.
 * @param {number} input.ratio The device pixel ratio.
 * @param {number} input.availableWidth CSS pixels.
 * @returns {{ step: number, ratio: number }} A larger `ratio` than the one given means that the row was shrunk.
 */
export function largestStepThatFits({ widths, gap = 0, step, ratio, availableWidth }) {
    const gaps = gap * (widths.length - 1);
    const figuresWidth = candidate => widths.reduce((sum, width) => sum + pixelCssSize(width, candidate, ratio), 0);
    for (let candidate = step; candidate >= 1; candidate--) {
        if (figuresWidth(candidate) + gaps <= availableWidth + FIT_TOLERANCE) {
            return { step: candidate, ratio };
        }
    }
    // The gaps keep their size, so only the figures give back the width. A larger ratio gives a smaller CSS size.
    return { step: 1, ratio: (ratio * figuresWidth(1)) / Math.max(availableWidth - gaps, 1) };
}

/**
 * How a scale compares with the fixed one of the screen. Only `smooth` draws an art pixel at a fraction of a device
 * pixel, which the stylesheet must render with `image-rendering: auto` because `pixelated` would show uneven stripes.
 * @param {{ step: number, ratio: number }} scale
 * @param {{ step: number, ratio: number }} fixed
 * @returns {'fixed' | 'step' | 'smooth'}
 */
export function describeFit(scale, fixed) {
    if (scale.ratio !== fixed.ratio) {
        return 'smooth';
    }
    return scale.step === fixed.step ? 'fixed' : 'step';
}

/**
 * A box for one pixel placement: a clip that the layout sizes, and the picture inside it. The picture is hidden
 * from assistive technology by its panel, and has no text alternative of its own.
 * @param {string} id Name in the export spec, for example `gs-reisen`.
 * @returns {HTMLSpanElement}
 */
export function createPixelFigure(id) {
    const art = getPixelArt(id);
    const figure = document.createElement('span');
    figure.className = 'sbArtFigure';
    // The attribute keeps the name that the placeholders had, so a test or a style that finds art by it still does.
    figure.dataset.sbArtPlaceholder = id;
    const image = document.createElement('img');
    image.className = 'sbPixelArt';
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    image.width = art.width;
    image.height = art.height;
    image.src = art.url;
    figure.append(image);
    return figure;
}

/**
 * Sets the CSS size of a figure so that one art pixel is `step` device pixels.
 * @param {HTMLElement} figure From `createPixelFigure`.
 * @param {{ step: number, ratio: number, rows?: number }} size `rows` shows only the first rows of the picture.
 */
export function sizePixelFigure(figure, { step, ratio, rows }) {
    const art = getPixelArt(figure.dataset.sbArtPlaceholder);
    const image = figure.firstElementChild;
    const shownRows = rows ?? art.height;
    // The player of a moving picture reads the size of an art pixel from here when it makes the layers.
    figure.style.setProperty('--sb-art-unit', `${pixelCssSize(1, step, ratio)}px`);
    figure.style.width = `${pixelCssSize(art.width, step, ratio)}px`;
    figure.style.height = `${pixelCssSize(shownRows, step, ratio)}px`;
    if (image instanceof HTMLElement) {
        image.style.width = `${pixelCssSize(art.width, step, ratio)}px`;
        image.style.height = `${pixelCssSize(art.height, step, ratio)}px`;
    }
    for (const layer of figure.querySelectorAll('[data-sb-art-box]')) {
        placePixelLayer(/** @type {HTMLElement} */ (layer), pixelCssSize(1, step, ratio));
    }
}

/**
 * Layout cuts a length down to a unit of 1/64 CSS px. An edge that should be a whole device pixel can end a hair under it,
 * and a layer whose edge did is painted a device pixel off from the still, at some scales and in some engines. An edge is
 * two lengths, a position and a size, so the bias has to be more than two units; a larger one pushes other edges over a
 * device pixel instead, and the window that holds in both Chromium and WebKit at every scale of the layered evenness
 * tests is narrow, about two to three units. This value is inside it, so a change to it, or to the art, has to be checked
 * with those tests in both engines. Moving the figure onto a whole device pixel does not remove the need: Chromium then
 * needs no bias, but WebKit still paints layers off at some scales.
 */
export const LAYER_EDGE_BIAS_CSS_PX = 5 / 128;

/**
 * Puts a picture that lies over the still of a figure at its place. Its box is in art pixels, in `data-sb-art-box`
 * as `left top width height`, and it is drawn at the same size of an art pixel as the still, so a layer lines up with
 * the still pixel for pixel at every step.
 * @param {HTMLElement} layer
 * @param {number} unit The CSS size of one art pixel.
 */
export function placePixelLayer(layer, unit) {
    const [left, top, width, height] = layer.dataset.sbArtBox.split(' ').map(Number);
    const bias = LAYER_EDGE_BIAS_CSS_PX;
    Object.assign(layer.style, {
        position: 'absolute',
        left: `${left * unit + bias}px`,
        top: `${top * unit + bias}px`,
        width: `${width * unit + bias}px`,
        height: `${height * unit + bias}px`,
    });
}

/**
 * Calls `onChange` when the device pixel ratio changes: browser zoom, or a move to another screen. A media query
 * names one ratio and fires once when it stops matching, so it is created again after each change.
 * @param {() => void} onChange
 * @returns {() => void} Stops listening.
 */
export function watchPixelScale(onChange) {
    if (typeof matchMedia !== 'function') {
        return () => {};
    }
    let query = null;
    let stopped = false;
    const handle = () => {
        if (stopped) {
            return;
        }
        onChange();
        listen();
    };
    const listen = () => {
        query = matchMedia(`(resolution: ${readDevicePixelRatio()}dppx)`);
        query.addEventListener('change', handle, { once: true });
    };
    listen();
    return () => {
        stopped = true;
        query?.removeEventListener('change', handle);
    };
}

/** @param {Element} element */
export function hasTransformedAncestor(element) {
    for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.transform !== 'none' || style.translate !== 'none' || style.scale !== 'none' || style.rotate !== 'none') {
            return true;
        }
    }
    return false;
}

/**
 * Moves a figure by the fractional part of its device-pixel position, so its box starts on a device pixel.
 * It does so only below an ancestor with a transform. A box that is laid out without a transform is already
 * rounded to whole device pixels by the browser, and a correction on top of that moves the picture by a part
 * of a device pixel, which can tear it at a tile edge.
 * Call it once layout has settled: it measures the box without its own earlier correction.
 * @param {HTMLElement} element
 */
export function alignToDevicePixels(element) {
    element.style.translate = '';
    if (!hasTransformedAncestor(element)) {
        return;
    }
    const ratio = readDevicePixelRatio();
    const rect = element.getBoundingClientRect();
    const deviceLeft = rect.left * ratio;
    const deviceTop = rect.top * ratio;
    const shiftX = (Math.round(deviceLeft) - deviceLeft) / ratio;
    const shiftY = (Math.round(deviceTop) - deviceTop) / ratio;
    if (Math.abs(shiftX) < EPSILON && Math.abs(shiftY) < EPSILON) {
        return;
    }
    element.style.translate = `${shiftX}px ${shiftY}px`;
}
