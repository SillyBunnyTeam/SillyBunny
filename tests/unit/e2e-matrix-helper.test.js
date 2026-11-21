import { afterEach, describe, expect, jest, test } from '@jest/globals';

const MATRIX_URL = '../helpers/matrix.js';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/** Loads the helper afresh, because it reads `SB_QUICK_MATRIX` once, when it is imported. */
async function loadMatrix(quick) {
    jest.resetModules();
    if (quick) {
        process.env.SB_QUICK_MATRIX = '1';
    } else {
        delete process.env.SB_QUICK_MATRIX;
    }
    return import(MATRIX_URL);
}

afterEach(() => {
    delete process.env.SB_QUICK_MATRIX;
});

describe('the e2e viewport matrix', () => {
    const viewports = [
        { name: 'desktop', options: { viewport: DESKTOP } },
        { name: 'phone', options: { viewport: PHONE } },
    ];

    test('a full run keeps every viewport and registers every test', async () => {
        const { matrixViewports, sizeFreeTestFor, quickOr } = await loadMatrix(false);
        const test = () => {};

        expect(matrixViewports(viewports, [DESKTOP])).toBe(viewports);
        expect(sizeFreeTestFor(test, PHONE)).toBe(test);
        expect(quickOr('full', 'quick')).toBe('full');
    });

    test('a quick run keeps the listed sizes and fails loudly on a size the spec does not have', async () => {
        const { matrixViewports, quickOr } = await loadMatrix(true);

        expect(matrixViewports(viewports, [DESKTOP]).map(viewport => viewport.name)).toEqual(['desktop']);
        expect(() => matrixViewports(viewports, [{ width: 360, height: 640 }])).toThrow('360x640');
        expect(quickOr('full', 'quick')).toBe('quick');
    });

    test('a quick run registers size-free tests at the desktop size only', async () => {
        const { sizeFreeTestFor } = await loadMatrix(true);
        const test = () => {};

        expect(sizeFreeTestFor(test, DESKTOP)).toBe(test);
        expect(sizeFreeTestFor(test, PHONE)).not.toBe(test);
    });

    test.each([false, true])('a size that checks geometry only registers no size-free test (quick run: %s)', async (quick) => {
        const { sizeFreeTestFor, GEOMETRY_ONLY_SIZES, SHEET_BOUNDARY_PHONE, LANDSCAPE_PHONE } = await loadMatrix(quick);
        const test = () => {};

        expect(GEOMETRY_ONLY_SIZES).toEqual([SHEET_BOUNDARY_PHONE, LANDSCAPE_PHONE]);
        expect(sizeFreeTestFor(test, LANDSCAPE_PHONE, GEOMETRY_ONLY_SIZES)).not.toBe(test);
        expect(sizeFreeTestFor(test, SHEET_BOUNDARY_PHONE, GEOMETRY_ONLY_SIZES)).not.toBe(test);
        expect(sizeFreeTestFor(test, LANDSCAPE_PHONE) === test).toBe(!quick);
    });

    test('a full run registers size-free tests at a size that is not geometry only', async () => {
        const { sizeFreeTestFor, GEOMETRY_ONLY_SIZES } = await loadMatrix(false);
        const test = () => {};

        expect(sizeFreeTestFor(test, PHONE, GEOMETRY_ONLY_SIZES)).toBe(test);
    });

    test('at another size every form of the call is accepted and nothing runs', async () => {
        const { sizeFreeTestFor } = await loadMatrix(true);
        const body = jest.fn();
        const registered = sizeFreeTestFor(() => {}, PHONE);

        registered('title', body);
        registered.skip('title', body);
        registered.only('title', body);
        registered.fixme('title', body);
        registered.fail('title', body);
        registered.describe('title', body);
        registered.describe.only('title', body);

        expect(body).not.toHaveBeenCalled();
    });
});
