import { expect } from '@playwright/test';

/**
 * Reads the page until two reads in a row are the same, and returns that read. A layout that fits a picture to its band
 * does so on a frame after the picture is made, so a read that follows at once can be of the size it had before the fit.
 * @template T
 * @param {import('@playwright/test').Page} page
 * @param {(page: import('@playwright/test').Page) => Promise<T>} read
 * @returns {Promise<T>}
 */
export async function settledRead(page, read) {
    const timeout = 10_000;
    let last = '';
    try {
        await expect.poll(async () => {
            const now = JSON.stringify(await read(page));
            const same = now === last;
            last = now;
            return same;
        }, { timeout }).toBe(true);
    } catch (error) {
        throw new Error(`The page did not stop changing within ${timeout}ms. The last read was ${last}.`, { cause: error });
    }
    return read(page);
}
