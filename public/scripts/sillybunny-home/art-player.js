import { afterPageMotion, isPageMotionRunning } from '../sillybunny-editor/page-motion.js';
import { prefersReducedMotion } from '../sillybunny-motion.js';
import { createBlinkState, parseBreathScene, planScene } from './art-motion.js';
import { placePixelLayer } from './pixel-art.js';
import { getPixelArt, getPixelMotionFile, pictureUrl } from './art-sources.js';

/*
 * Plays the idle motion of a pixel picture: its figures breathe and blink. The picture is a figure of the layout, with
 * its still on it. Once the pre-rendered pictures of the motion have loaded they are laid over the still, at the
 * same art pixels, and one picture of each figure shows at a time. The motion stays inside the picture: the layers
 * are placed absolutely in a box that clips them, so nothing around the picture moves.
 *
 * It runs only while it can be seen and may move. It waits for a change with a timer and does not draw frames, so a
 * picture that is hidden, off screen or under Reduced Motion costs nothing, and one that is on screen wakes only
 * when a figure changes its picture.
 *
 * A picture that the layout shrinks by a fraction to fit its place (`data-sb-art-fit="smooth"`) keeps its still. Its
 * art pixels are not whole device pixels there, so layers placed on them would round each to a different edge and show
 * seams that the single still does not have.
 *
 * A picture in a dialog page that slides makes no write to the document until the slide has ended. The pictures still
 * load and decode during the slide, and a figure that plays keeps the picture it shows until then.
 */

/** @typedef {import('./art-motion.js').MotionScene} MotionScene */

const EARLY_WAKE_RETRY_MS = 50;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Reduced Motion is the system setting or the app's own, which puts `reduced-motion` on the body. */
function readReducedMotion() {
    return typeof matchMedia === 'function' && prefersReducedMotion();
}

const conditionListeners = new Set();
/** @type {(() => void) | null} */
let removeConditionWatch = null;

function notifyConditionListeners() {
    for (const listener of [...conditionListeners]) {
        listener();
    }
}

/** @returns {() => void} Stops watching. */
function installConditionWatch() {
    document.addEventListener('visibilitychange', notifyConditionListeners);
    const query = typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION_QUERY) : null;
    query?.addEventListener('change', notifyConditionListeners);
    const bodyClass = document.body ? new MutationObserver(notifyConditionListeners) : null;
    bodyClass?.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => {
        document.removeEventListener('visibilitychange', notifyConditionListeners);
        query?.removeEventListener('change', notifyConditionListeners);
        bodyClass?.disconnect();
    };
}

/**
 * Calls `onChange` when the tab is hidden or shown, or when Reduced Motion changes. The listeners are shared and exist
 * only while something is listening, so a picture that is gone does not keep the page's events alive.
 * @param {() => void} onChange
 * @returns {() => void} Stops listening.
 */
function watchMotionConditions(onChange) {
    conditionListeners.add(onChange);
    if (conditionListeners.size === 1) {
        removeConditionWatch = installConditionWatch();
    }
    return () => {
        conditionListeners.delete(onChange);
        if (conditionListeners.size === 0) {
            removeConditionWatch?.();
            removeConditionWatch = null;
        }
    };
}

/**
 * @param {HTMLImageElement} image
 * @returns {Promise<void>} Settles once the picture is decoded, so it can show without a blank frame.
 */
function whenDecoded(image) {
    if (typeof image.decode === 'function') {
        return image.decode();
    }
    return new Promise((resolve, reject) => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => reject(new Error(`The picture ${image.currentSrc} did not load.`)), { once: true });
    });
}

/**
 * A picture of one figure, placed in art pixels. The layout places it again at every change of step.
 * @param {string} src
 * @param {{ left: number, top: number, width: number, height: number }} box
 * @param {Record<string, string>} data
 * @param {boolean} shown
 * @param {number} unit The CSS size of one art pixel.
 */
function createLayerImage(src, { left, top, width, height }, data, shown, unit) {
    const image = document.createElement('img');
    image.className = 'sbPixelArt';
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    image.src = src;
    Object.assign(image.dataset, data, { sbArtBox: `${left} ${top} ${width} ${height}` });
    image.style.visibility = shown ? 'visible' : 'hidden';
    placePixelLayer(image, unit);
    return image;
}

/**
 * @typedef {object} Rig What the player has built in a figure once the pictures have loaded.
 * @property {MotionScene} scene
 * @property {HTMLElement[]} nodes Every picture that the player added, in drawing order.
 * @property {{ layer: import('./art-motion.js').MotionLayer, images: Map<string, HTMLImageElement>, shown: string }[]} figures
 */

/**
 * @param {MotionScene} scene
 * @param {(file: string) => string} urlOf
 * @param {number} unit The CSS size of one art pixel in the figure.
 * @returns {Promise<Rig>} Pictures that are decoded but not yet in the page.
 */
async function buildRig(scene, urlOf, unit) {
    /** @type {HTMLImageElement[]} */
    const pending = [];
    const nodes = [];
    if (scene.backdrop) {
        const backdrop = createLayerImage(urlOf(scene.backdrop), { left: 0, top: 0, width: scene.width, height: scene.height }, { sbArtLayer: 'backdrop' }, true, unit);
        nodes.push(backdrop);
        pending.push(backdrop);
    }
    const figures = scene.layers.map((layer) => {
        const images = new Map();
        const first = layer.images.c.base;
        for (const pose of /** @type {const} */ (['c', 'b'])) {
            for (const [variant, file] of Object.entries(layer.images[pose])) {
                if (images.has(file)) {
                    continue;
                }
                const image = createLayerImage(urlOf(file), layer, { sbArtLayer: layer.id, sbArtPose: pose, sbArtPicture: variant }, file === first, unit);
                images.set(file, image);
                nodes.push(image);
                pending.push(image);
            }
        }
        return { layer, images, shown: first };
    });
    await Promise.all(pending.map(whenDecoded));
    return { scene, nodes, figures };
}

/**
 * @param {HTMLElement} figure
 * @returns {number | null} The CSS size of one art pixel in the figure, as the layout last set it, or null while the layout has not sized it.
 */
function readUnit(figure) {
    const unit = Number.parseFloat(figure.style.getPropertyValue('--sb-art-unit'));
    return unit > 0 ? unit : null;
}

/**
 * @param {HTMLElement} figure
 * @returns {boolean} Whether the layout has shrunk the picture by a fraction, so its art pixels are not whole device pixels.
 */
function isShrunkSmooth(figure) {
    return figure.closest('[data-sb-art-fit]')?.getAttribute('data-sb-art-fit') === 'smooth';
}

/**
 * @typedef {object} MotionSource
 * @property {() => Promise<MotionScene>} loadScene Called once, when the picture first has to move.
 * @property {(file: string) => string} urlOf
 * @property {() => number} [random]
 * @property {() => number} [now]
 * @property {boolean} [awaitsLayout] A figure that a layout sizes and fits does not start until the layout has said it is
 *   done, by `refresh`, so that it does not load frames for a fit that keeps the still.
 */

/**
 * Makes the picture in `figure` move while it can be seen.
 * @param {HTMLElement} figure A pixel figure that the layout sizes; it holds the still as its first child.
 * @param {MotionSource} source
 * @returns {{ stop: () => void, refresh: () => void }} `stop` ends it for good and puts the still back. A picture that only
 *   leaves the page needs no call: it pauses by itself and starts again when it returns. `refresh` looks again at whether
 *   it can move, for a layout that has just sized the figure.
 */
export function startArtMotion(figure, { loadScene, urlOf, random = Math.random, now = () => performance.now(), awaitsLayout = false }) {
    if (typeof IntersectionObserver !== 'function') {
        return { stop() {}, refresh() {} };
    }
    const still = /** @type {HTMLElement | null} */ (figure.firstElementChild);
    /** @type {'idle' | 'loading' | 'ready' | 'failed'} */
    let status = 'idle';
    let inView = false;
    let stopped = false;
    let playing = false;
    let placed = !awaitsLayout;
    let startedAt = 0;
    let timer = 0;
    /** @type {{ layers: (import('./art-motion.js').FigureBlink | null)[] }} */
    let blinkState = { layers: [] };
    /** @type {Promise<MotionScene> | null} */
    let sceneLoad = null;
    /** @type {Rig | null} */
    let rig = null;
    /** @type {(() => void) | null} */
    let unwatch = null;
    /** @type {Rig | null} */
    let pendingRig = null;
    /** @type {(() => void) | null} */
    let cancelWait = null;
    let retryTimer = 0;

    /** @param {string} state */
    const report = (state) => {
        figure.dataset.sbArtMotion = state;
    };

    /**
     * @param {Rig['figures'][number]} entry
     * @param {string} file
     */
    const show = (entry, file) => {
        if (entry.shown === file) {
            return;
        }
        /** @type {HTMLImageElement} */ (entry.images.get(entry.shown)).style.visibility = 'hidden';
        /** @type {HTMLImageElement} */ (entry.images.get(file)).style.visibility = 'visible';
        entry.shown = file;
    };

    const inHiddenPage = () => figure.closest('[hidden]') !== null;

    /** Shows the still, or the neutral picture of every figure, which is the same picture. */
    const showStill = () => {
        if (!rig) {
            return;
        }
        // A smooth fit has no layers at all, and any other fit puts the neutral pictures where the still is.
        const layered = !isShrunkSmooth(figure);
        for (const node of rig.nodes) {
            node.style.display = layered ? '' : 'none';
        }
        if (still) {
            still.style.visibility = layered ? 'hidden' : '';
        }
        for (const entry of rig.figures) {
            show(entry, entry.layer.images.c.base);
        }
    };

    const tick = () => {
        timer = 0;
        // A figure that left the document while a timer was pending has nothing to move.
        if (!rig || !figure.isConnected) {
            pause();
            return;
        }
        if (isPageMotionRunning(figure)) {
            waitForPagesToRest();
            return;
        }
        const plan = planScene(blinkState, now() - startedAt, rig.scene, random);
        blinkState = plan.blinkState;
        rig.figures.forEach((entry, index) => show(entry, plan.files[index]));
        timer = setTimeout(tick, plan.untilMs);
    };

    const pause = () => {
        clearTimeout(timer);
        timer = 0;
        // Nothing shows a figure that is detached or in a hidden page, so the writes of the still would be wasted
        // restyles. The still is put back when the figure plays again.
        if (figure.isConnected && !inHiddenPage()) {
            showStill();
        }
        if (playing) {
            playing = false;
            report('still');
        }
    };

    const play = () => {
        if (playing || !rig) {
            return;
        }
        playing = true;
        startedAt = now();
        blinkState = createBlinkState(rig.scene, random);
        // It may have been showing the still of a smooth fit, so the layers are put back first.
        showStill();
        report('playing');
        tick();
    };

    const canMove = () => placed && inView && figure.isConnected && !inHiddenPage() && !document.hidden && !readReducedMotion() && !isShrunkSmooth(figure);

    /** Looks at the figure again once, when the pages of its dialog have stopped moving. */
    const waitForPagesToRest = () => {
        if (retryTimer) {
            return;
        }
        cancelWait ??= afterPageMotion(figure, () => {
            cancelWait = null;
            if (stopped) {
                return;
            }
            // A wake-up that comes while the pages still move would otherwise register the wait again in the same
            // microtask, and the page would never get to run its tasks.
            if (isPageMotionRunning(figure)) {
                retryTimer = setTimeout(() => {
                    retryTimer = 0;
                    waitForPagesToRest();
                }, EARLY_WAKE_RETRY_MS);
                return;
            }
            if (pendingRig) {
                const built = pendingRig;
                pendingRig = null;
                install(built);
                return;
            }
            refresh();
        });
    };

    /** @param {Rig} built Pictures that are decoded but not yet in the page. */
    const install = (built) => {
        if (stopped) {
            return;
        }
        // The dialog may have closed during the slide. The next refresh loads the scene again if the figure returns.
        if (!figure.isConnected) {
            pendingRig = null;
            if (status === 'loading') {
                status = 'idle';
            }
            return;
        }
        if (isPageMotionRunning(figure)) {
            pendingRig = built;
            waitForPagesToRest();
            return;
        }
        // The layout may have changed the step while the pictures decoded, and it places only what is in the figure.
        const unit = readUnit(figure);
        if (unit === null) {
            status = 'idle';
            return;
        }
        built.nodes.forEach(node => placePixelLayer(node, unit));
        figure.append(...built.nodes);
        rig = built;
        status = 'ready';
        report('still');
        showStill();
        refresh();
    };

    const load = () => {
        // The layout sizes a figure after it makes it. A figure that has no size yet is not a failure: the next refresh asks again.
        if (readUnit(figure) === null) {
            return;
        }
        status = 'loading';
        sceneLoad ??= loadScene();
        sceneLoad
            .then((scene) => {
                const unit = readUnit(figure);
                if (unit === null) {
                    return null;
                }
                return buildRig(scene, urlOf, unit);
            })
            .then((built) => {
                if (stopped) {
                    return;
                }
                if (!built) {
                    status = 'idle';
                    return;
                }
                install(built);
            })
            .catch((error) => {
                if (stopped) {
                    return;
                }
                // A scene that failed once would fail again, so the picture stays a still and stops watching.
                status = 'failed';
                report('failed');
                release();
                console.warn('The picture keeps its still: its motion could not be loaded.', error);
            });
    };

    function refresh() {
        // A failed scene has released its listeners and would only install them again.
        if (stopped || status === 'failed') {
            return;
        }
        // The listeners exist only while the picture is on screen, so one that is gone leaves nothing behind.
        if (inView && !unwatch) {
            unwatch = watchMotionConditions(refresh);
        } else if (!inView && unwatch) {
            unwatch();
            unwatch = null;
        }
        const pagesMove = isPageMotionRunning(figure);
        if (!canMove()) {
            if (pagesMove) {
                waitForPagesToRest();
            } else {
                pause();
            }
            return;
        }
        if (pagesMove) {
            // Loading makes no write, so the pictures can be ready when the slide ends.
            if (status === 'idle') {
                load();
            }
            waitForPagesToRest();
            return;
        }
        if (status === 'idle') {
            load();
        } else if (status === 'ready') {
            if (!playing) {
                play();
            } else if (!timer) {
                tick();
            }
        }
    }

    const observer = new IntersectionObserver((entries) => {
        inView = entries[entries.length - 1].isIntersecting;
        refresh();
    });
    observer.observe(figure);

    function release() {
        clearTimeout(timer);
        timer = 0;
        cancelWait?.();
        cancelWait = null;
        clearTimeout(retryTimer);
        retryTimer = 0;
        pendingRig = null;
        observer.disconnect();
        unwatch?.();
        unwatch = null;
    }

    return {
        refresh() {
            placed = true;
            refresh();
        },
        stop() {
            if (stopped) {
                return;
            }
            stopped = true;
            release();
            rig?.nodes.forEach(node => node.remove());
            rig = null;
            if (still) {
                still.style.visibility = '';
            }
            delete figure.dataset.sbArtMotion;
        },
    };
}

/**
 * Reads a scene that `breath-frames.mjs` wrote, and refuses one that is not the picture it is meant for.
 * @param {string} file The file name of the scene's description.
 * @param {{ width: number, height: number }} art The still that the scene moves, in art pixels.
 * @returns {Promise<MotionScene>}
 */
async function fetchBreathScene(file, art) {
    const response = await fetch(pictureUrl(file));
    if (!response.ok) {
        throw new Error(`${file}: the server answered ${response.status}.`);
    }
    const scene = parseBreathScene(await response.json());
    if (scene.width !== art.width || scene.height !== art.height) {
        throw new Error(`${file}: the scene is ${scene.width}x${scene.height} art pixels but its still is ${art.width}x${art.height}.`);
    }
    return scene;
}

/**
 * Starts the motion of the pixel art `id` in its figure, when the art has one.
 * @param {HTMLElement} figure From `createPixelFigure`.
 * @param {string} id
 * @returns {{ stop: () => void, refresh: () => void } | null}
 */
export function attachArtMotion(figure, id) {
    const file = getPixelMotionFile(id);
    if (!file) {
        return null;
    }
    const art = getPixelArt(id);
    return startArtMotion(figure, { loadScene: () => fetchBreathScene(file, art), urlOf: pictureUrl, awaitsLayout: true });
}
