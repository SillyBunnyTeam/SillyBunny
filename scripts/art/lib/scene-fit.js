import { frameBox, renderFrame } from './frame.js';
import { ArtProblem } from './problem.js';
import { createRaster, crop, opaqueBox, paste, samePixels } from './raster.js';

/**
 * The most combinations of one picture per layer that `fitScene` lays over each other to prove the layers line up. The
 * player may show any picture of one layer beside any picture of another.
 */
const MOST_COMBINATIONS = 4096;

const copyOf = (raster) => ({ ...raster, data: Buffer.from(raster.data) });

/**
 * Pixels of `frame` that differ from `reference`: an opaque pixel of `frame` that is transparent in `reference` or has
 * another colour there, in the colour of `frame`. Everything else is transparent.
 */
function differences(frame, reference) {
    const found = createRaster(frame.width, frame.height);
    for (let at = 0; at < frame.data.length; at += 4) {
        const opaque = frame.data[at + 3] !== 0;
        if (opaque && (reference.data[at + 3] === 0 || !frame.data.subarray(at, at + 3).equals(reference.data.subarray(at, at + 3)))) {
            frame.data.copy(found.data, at, at, at + 4);
        }
    }
    return found;
}

/** Every way to choose one name from each list, in the order of the lists. */
function* choices(lists) {
    if (lists.length === 0) {
        yield [];
        return;
    }
    const [first, ...rest] = lists;
    for (const name of first) {
        for (const tail of choices(rest)) {
            yield [name, ...tail];
        }
    }
}

/**
 * Brings a scene of figure layers onto its placement grid so that the layers still line up. A layer picture fitted on
 * its own would put its edges on other cell borders than the scene's fit does, so every picture is made from a whole
 * frame instead: the backdrop and the layers, each at the picture it shows, are composed on the master's canvas, and
 * that canvas is fitted and framed exactly as the still is. A layer's picture is then what that frame shows beyond the
 * frame made of the layers drawn before it. The player lays the pictures over the backdrop in the same order.
 *
 * The result is proven before it returns: for every combination of one picture per layer, the backdrop with those
 * pictures laid over it at the layers' boxes equals the fit of the whole composed frame, pixel for pixel. A pair of
 * layers whose pictures share a cell can fail this, and the derive refuses it.
 * @param {object} input
 * @param {string} input.id The asset, for a refusal.
 * @param {import('./raster.js').Raster} input.master The scene on its canvas.
 * @param {import('./raster.js').Raster | null} input.backdrop On the master's canvas, or null for a scene with none.
 * @param {{ id: string, left: number, top: number, pictures: Record<string, import('./raster.js').Raster> }[]} input.layers
 *   In drawing order, each picture at `left`, `top` of the master's canvas.
 * @param {string} input.pose The picture of each layer that, drawn over the backdrop, gives the master.
 * @param {(raster: import('./raster.js').Raster) => import('./raster.js').Raster} input.place The asset's placement.
 * @param {{ mode: 'canvas' } | { mode: 'subject', margin: number }} input.frame
 * @returns {{ still: import('./raster.js').Raster, backdrop: import('./raster.js').Raster, layers: Record<string, { box: number[], pictures: Record<string, import('./raster.js').Raster> }> }}
 *   Each layer's `box` is `[left, top, width, height]` in pixels of the framed still, the smallest box that holds
 *   every difference of every picture of the layer.
 * @throws {ArtProblem} `composition-mismatch` when the layers at their pose do not give the master, or when a
 *   combination does not line up; `layer-empty` for a layer that shows nothing of its own; `composition-too-large`.
 */
export function fitScene({ id, master, backdrop, layers, pose, place, frame }) {
    const fail = (code, message) => {
        throw new ArtProblem(code, message, { asset: id });
    };
    const compose = (chosen) => {
        const canvas = createRaster(master.width, master.height);
        if (backdrop) {
            paste(canvas, backdrop, 0, 0);
        }
        for (const layer of layers) {
            if (chosen[layer.id] !== undefined) {
                paste(canvas, layer.pictures[chosen[layer.id]], layer.left, layer.top);
            }
        }
        return canvas;
    };
    if (!samePixels(compose(Object.fromEntries(layers.map((layer) => [layer.id, pose]))), master)) {
        fail('composition-mismatch', `The backdrop and the "${pose}" pictures of the layers, drawn in order, do not give the scene's master.`);
    }
    const combinations = layers.reduce((count, layer) => count * Object.keys(layer.pictures).length, 1);
    if (combinations > MOST_COMBINATIONS) {
        fail('composition-too-large', `The layers have ${combinations} combinations of pictures to line up, and the derive proves at most ${MOST_COMBINATIONS}.`);
    }
    const box = frameBox(place(master), frame);
    const fit = (canvas) => renderFrame(place(canvas), box);
    const fittedBackdrop = fit(compose({}));
    const under = {};
    const made = {};
    for (const layer of layers) {
        const reference = fit(compose(under));
        const differing = Object.entries(layer.pictures).map(([name, picture]) => [name, differences(fit(compose({ ...under, [layer.id]: name })), reference), picture]);
        const boxes = differing.map(([, found]) => opaqueBox(found, 1)).filter(Boolean);
        if (boxes.length === 0) {
            fail('layer-empty', `Layer ${layer.id} shows nothing of its own on the placement grid, so it has nothing to ship.`);
        }
        const left = Math.min(...boxes.map((found) => found.x));
        const top = Math.min(...boxes.map((found) => found.y));
        const right = Math.max(...boxes.map((found) => found.x + found.width));
        const bottom = Math.max(...boxes.map((found) => found.y + found.height));
        const layerBox = { x: left, y: top, width: right - left, height: bottom - top };
        made[layer.id] = { box: [left, top, layerBox.width, layerBox.height], pictures: Object.fromEntries(differing.map(([name, found]) => [name, crop(found, layerBox)])) };
        under[layer.id] = pose;
    }
    const ids = layers.map((layer) => layer.id);
    for (const names of choices(layers.map((layer) => Object.keys(layer.pictures)))) {
        const laid = copyOf(fittedBackdrop);
        names.forEach((name, at) => paste(laid, made[ids[at]].pictures[name], made[ids[at]].box[0], made[ids[at]].box[1]));
        const chosen = Object.fromEntries(names.map((name, at) => [ids[at], name]));
        if (!samePixels(laid, fit(compose(chosen)))) {
            fail('composition-mismatch', `The layer pictures ${names.map((name, at) => `${ids[at]} ${name}`).join(', ')}, laid over the backdrop on the placement grid, do not give the fit of the whole frame; layers whose pictures share a cell cannot be fitted apart.`);
        }
    }
    return { still: fit(master), backdrop: fittedBackdrop, layers: made };
}
