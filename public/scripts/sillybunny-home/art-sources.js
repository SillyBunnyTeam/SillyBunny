/** Changes with every new set of picture files, because the service worker caches `/img/` by the full URL. */
export const ART_VERSION = '20261104a';

const ART_BASE = '/img/sillybunny/';

/**
 * The pixel placements that `assets-src/branding/export-specs/shell.json` ships, with the size of the file in art
 * pixels. A pixel placement is stored at its own size, so the size is what the layout needs before the picture has
 * loaded. `tests/unit/sillybunny-home-art-sources.test.js` reads every file and fails when a size or a name is stale.
 * @type {Readonly<Record<string, { file: string, width: number, height: number }>>}
 */
const PIXEL_ART = Object.freeze({
    'welcome-both': { file: 'welcome-both@native.webp', width: 312, height: 365 },
    'welcome-persona-tewi': { file: 'welcome-persona-tewi@native.webp', width: 153, height: 329 },
    'welcome-next-reisen': { file: 'welcome-next-reisen@native.webp', width: 276, height: 395 },
    'gs-reisen': { file: 'gs-reisen@native.webp', width: 189, height: 372 },
    'gs-reisen-done': { file: 'gs-reisen-done@native.webp', width: 213, height: 425 },
    'help-reisen': { file: 'help-reisen@native.webp', width: 196, height: 402 },
    'extras-tewi': { file: 'extras-tewi@native.webp', width: 172, height: 317 },
    'shortcuts-tewi': { file: 'shortcuts-tewi@native.webp', width: 143, height: 315 },
    'about-reisen': { file: 'about-reisen@native.webp', width: 183, height: 368 },
    'about-tewi': { file: 'about-tewi@native.webp', width: 145, height: 305 },
    'troubleshooting-reisen': { file: 'troubleshooting-reisen@native.webp', width: 197, height: 366 },
    'empty-tewi': { file: 'empty-tewi@native.webp', width: 159, height: 318 },
});

/**
 * @param {string} id For example `gs-reisen`.
 * @returns {{ id: string, url: string, width: number, height: number }}
 */
export function getPixelArt(id) {
    const art = PIXEL_ART[id];
    if (!art) {
        throw new Error(`There is no pixel art named "${id}". Add it to PIXEL_ART in art-sources.js and to the export spec.`);
    }
    return { id, url: `${ART_BASE}${art.file}?v=${ART_VERSION}`, width: art.width, height: art.height };
}

/** @returns {string[]} */
export function listPixelArtIds() {
    return Object.keys(PIXEL_ART);
}
