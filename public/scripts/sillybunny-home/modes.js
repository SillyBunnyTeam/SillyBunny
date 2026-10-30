/** Values stored under `WelcomePage_PanelMode`. */
export const DISPLAY_MODES = Object.freeze(['full', 'compact', 'list']);

const DEFAULT_MODE = 'full';

/*
 * The header is not a region: every mode shows it. `getting-started` is the first tile of the `tiles` row,
 * `tile-lines` are the voiced lines under the tile titles, and `assistant-art` is the portrait of each assistant card.
 */
const VISIBLE_REGIONS = Object.freeze({
    full: Object.freeze(['hero', 'tiles', 'getting-started', 'tile-lines', 'assistants', 'assistant-art', 'recent-chats', 'mascot-art']),
    compact: Object.freeze(['tiles', 'assistants', 'recent-chats']),
    list: Object.freeze(['recent-chats']),
});

/**
 * @param {unknown} value A stored or requested display mode.
 * @returns {'full' | 'compact' | 'list'}
 */
export function parseDisplayMode(value) {
    return DISPLAY_MODES.includes(/** @type {string} */ (value)) ? /** @type {'full' | 'compact' | 'list'} */ (value) : DEFAULT_MODE;
}

/**
 * Region ids match `data-sb-home-region` in the Home template. A region that a mode does not list is hidden.
 * @param {unknown} mode
 * @returns {readonly string[]}
 */
export function getVisibleRegions(mode) {
    return VISIBLE_REGIONS[parseDisplayMode(mode)];
}
