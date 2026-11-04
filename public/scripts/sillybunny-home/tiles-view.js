import { getHomeDestination } from './destinations.js';
import { formatProgress } from './getting-started.js';

const GETTING_STARTED_KEY = 'getting-started';
/** The voiced lines are a region of their own, so Compact hides them like it hides the other art and prose of Full. */
const TILE_LINES_REGION = 'tile-lines';

/**
 * @param {object} options
 * @param {string} options.key Names the tile for tests and for restoring focus.
 * @param {string} options.icon
 * @param {string} options.title
 * @param {string} options.line What the tile says in the voice of an assistant.
 * @param {(tile: HTMLButtonElement) => void} options.onActivate
 * @returns {{ tile: HTMLButtonElement, line: HTMLElement }}
 */
function createTile({ key, icon, title, line: lineText, onActivate }) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'sbHomeTile';
    tile.dataset.sbHomeKey = key;

    const iconBox = document.createElement('span');
    iconBox.className = 'sbHomeTileIcon';
    const glyph = document.createElement('i');
    glyph.className = `${icon} fa-fw`;
    glyph.setAttribute('aria-hidden', 'true');
    iconBox.append(glyph);

    const titleNode = document.createElement('span');
    titleNode.className = 'sbHomeTileTitle';
    titleNode.id = `sb-home-tile-${key}-title`;
    titleNode.textContent = title;
    const line = document.createElement('span');
    line.className = 'sbHomeTileLine';
    line.textContent = lineText;
    line.id = `sb-home-tile-${key}-line`;
    line.dataset.sbHomeRegion = TILE_LINES_REGION;

    // As on the assistant cards, the title is the name and the rest of the tile is its description.
    tile.setAttribute('aria-labelledby', titleNode.id);
    tile.append(iconBox, titleNode, line);
    describeTile(tile);
    tile.addEventListener('click', () => onActivate(tile));
    return { tile, line };
}

/**
 * Describes a tile by its voiced line, when the line is shown, and by its progress, when it has one. A hidden
 * element that `aria-describedby` points at is still read, so Compact takes the line out of the list.
 * @param {HTMLElement} tile
 */
function describeTile(tile) {
    const parts = [tile.querySelector('.sbHomeTileLine:not([hidden])'), tile.querySelector('.sbHomeTileSub')];
    const ids = parts.filter(part => part instanceof HTMLElement).map(part => part.id);
    if (ids.length === 0) {
        tile.removeAttribute('aria-describedby');
        return;
    }
    tile.setAttribute('aria-describedby', ids.join(' '));
}

/**
 * Brings the description of every tile in step with the voiced lines that the display mode shows.
 * @param {HTMLElement} panel The `.welcomePanel` root.
 */
export function describeTiles(panel) {
    panel.querySelectorAll('.sbHomeTile').forEach((tile) => {
        if (tile instanceof HTMLElement) {
            describeTile(tile);
        }
    });
}

/** A tile of one Home destination, which names its icon, title and voiced line. */
function createDestinationTile(key, onActivate) {
    const { icon, getLine, getTitle } = getHomeDestination(key);
    return createTile({ key, icon, title: getTitle(), line: getLine(), onActivate });
}

/** Safari does not focus a button on click, and the window returns focus to the element that had it. */
function openFromTile(tile, open) {
    tile.focus({ preventScroll: true });
    open();
}

/**
 * The Getting Started tile shows the progress of the state it is given. A tile that the state hides is
 * removed from the row, so the tiles that are left share the row between them.
 * @param {HTMLElement} row
 * @param {ReturnType<typeof import('./getting-started.js').createGettingStartedState>} state
 * @param {() => void} openGettingStarted
 * @param {() => void} onRowChanged Runs after the tile came back, so the display mode applies to it.
 * @returns {() => void} Stops following the state.
 */
function mountGettingStartedTile(row, state, openGettingStarted, onRowChanged) {
    /** @type {{ tile: HTMLButtonElement, progress: HTMLElement } | null} */
    let current = null;

    function showProgress() {
        if (current) {
            current.progress.textContent = formatProgress(state.getResolvedCount(), state.getTotal());
        }
    }

    function sync({ announce }) {
        if (state.isHidden()) {
            current?.tile.remove();
            current = null;
            return;
        }
        if (current) {
            showProgress();
            return;
        }
        const { tile } = createDestinationTile(GETTING_STARTED_KEY, opened => openFromTile(opened, openGettingStarted));
        // The progress is the tile's own status, below the voiced line that the other tiles have as well.
        const progress = document.createElement('span');
        progress.className = 'sbHomeTileSub';
        progress.id = `sb-home-tile-${GETTING_STARTED_KEY}-progress`;
        tile.append(progress);
        describeTile(tile);
        current = { tile, progress };
        current.tile.dataset.sbHomeRegion = GETTING_STARTED_KEY;
        showProgress();
        row.prepend(current.tile);
        if (announce) {
            onRowChanged();
        }
    }

    sync({ announce: false });
    return state.subscribe(() => sync({ announce: true }));
}

/** @type {(() => void) | null} */
let stopPreviousTiles = null;

/**
 * Fills the tile row: Getting Started, Help and Bundled Extras.
 * @param {HTMLElement} panel The `.welcomePanel` root.
 * @param {object} options
 * @param {ReturnType<typeof import('./getting-started.js').createGettingStartedState>} options.state
 * @param {() => void} options.onRowChanged Applies the display mode again after a tile was added.
 * @param {() => void} options.openGettingStarted
 * @param {() => void} options.openBundledExtras
 * @param {() => void} options.openHelp
 */
export function mountTiles(panel, { state, onRowChanged, openGettingStarted, openBundledExtras, openHelp }) {
    // Only one Home panel exists at a time. A listener left on the state would keep the replaced panel alive.
    stopPreviousTiles?.();
    stopPreviousTiles = null;
    const row = panel.querySelector('[data-sb-home-region="tiles"]');
    if (!row) {
        return;
    }

    const { tile: help } = createDestinationTile('help', tile => openFromTile(tile, openHelp));
    const { tile: extras } = createDestinationTile('extras', tile => openFromTile(tile, openBundledExtras));

    row.replaceChildren(help, extras);
    stopPreviousTiles = mountGettingStartedTile(row, state, openGettingStarted, onRowChanged);
}
