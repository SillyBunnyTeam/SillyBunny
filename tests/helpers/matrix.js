/**
 * The viewport matrix of the specs that run one set of tests at several window sizes.
 *
 * `npm run test:e2e` runs every size of every spec, and CI relies on that. `SB_QUICK_MATRIX=1` is a development
 * shortcut: a spec runs the tests whose result depends on the window size at a few sizes, and the tests whose
 * result does not depend on it at the desktop size only.
 */

export const QUICK_MATRIX = process.env.SB_QUICK_MATRIX === '1';

export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };
export const SMALL_PHONE = { width: 360, height: 640 };
/** The widest window that shows the action menus as sheets. */
export const SHEET_BOUNDARY_PHONE = { width: 450, height: 800 };
export const LANDSCAPE_PHONE = { width: 844, height: 390 };
/**
 * Sizes where a spec checks the geometry of a layout and nothing else, because the tests of a layout that do not depend on
 * the size already pass at the sizes beside them. Pass them as `geometryOnlySizes` to `sizeFreeTestFor`.
 */
export const GEOMETRY_ONLY_SIZES = [SHEET_BOUNDARY_PHONE, LANDSCAPE_PHONE];

/** Picks the full value, or the quick one while `SB_QUICK_MATRIX=1`. */
export function quickOr(full, quick) {
    return QUICK_MATRIX ? quick : full;
}

const isSameSize = (first, second) => first.width === second.width && first.height === second.height;
const sizeOfOptions = viewport => viewport.options.viewport;

/**
 * The entries of a spec's own viewport list that its size-dependent tests run at.
 * A spec keeps its own list, because its entries carry fields that its tests read (`sheet`, `portrait`, `checksColours`).
 * @template T
 * @param {T[]} viewports The full list of the spec.
 * @param {{ width: number, height: number }[]} quickSizes The sizes that stay in quick mode, each of which must be in the list.
 * @param {(viewport: T) => { width: number, height: number }} [sizeOf] Reads the window size of an entry.
 * @returns {T[]}
 */
export function matrixViewports(viewports, quickSizes, sizeOf = sizeOfOptions) {
    if (!QUICK_MATRIX) {
        return viewports;
    }
    return quickSizes.map((size) => {
        const viewport = viewports.find(candidate => isSameSize(sizeOf(candidate), size));
        if (!viewport) {
            throw new Error(`SB_QUICK_MATRIX asks for ${size.width}x${size.height}, which is not in the viewport list of the spec.`);
        }
        return viewport;
    });
}

/**
 * A stand-in for `test` that registers nothing. Every property of it (`skip`, `only`, `describe` and the rest) is the
 * stand-in again, so any form of the call is accepted and none of them registers a test or runs a callback.
 */
const unregisteredTest = new Proxy(() => {}, { get: () => unregisteredTest });

/**
 * The function that registers the tests of a spec whose result does not depend on the window size. It is `test` itself
 * in a full run, and in a quick run it is `test` at the desktop size only and a stand-in that registers nothing at
 * every other size. At a size in `geometryOnlySizes` it is the stand-in in a full run too.
 * @template T
 * @param {T} test The `test` of the spec.
 * @param {{ width: number, height: number }} size The window size of the pass that registers the tests.
 * @param {{ width: number, height: number }[]} [geometryOnlySizes] Sizes that run the tests of the layout only.
 * @returns {T}
 */
export function sizeFreeTestFor(test, size, geometryOnlySizes = []) {
    const isGeometryOnly = geometryOnlySizes.some(geometrySize => isSameSize(geometrySize, size));
    if (!isGeometryOnly && (!QUICK_MATRIX || isSameSize(size, DESKTOP))) {
        return test;
    }
    return /** @type {T} */ (/** @type {unknown} */ (unregisteredTest));
}
