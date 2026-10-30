import { t } from '../i18n.js';
import { markCopyPlaceholder } from './copy.js';
import { formatProgress } from './getting-started.js';

const GETTING_STARTED_KEY = 'getting-started';

/**
 * @param {object} options
 * @param {string} options.key Names the tile for tests and for restoring focus.
 * @param {string} options.icon
 * @param {string} options.title
 * @param {(tile: HTMLButtonElement) => void} options.onActivate
 * @returns {{ tile: HTMLButtonElement, subtitle: HTMLElement }}
 */
function createTile({ key, icon, title, onActivate }) {
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
    titleNode.textContent = title;
    const subtitle = document.createElement('span');
    subtitle.className = 'sbHomeTileSub';

    tile.append(iconBox, titleNode, subtitle);
    tile.addEventListener('click', () => onActivate(tile));
    return { tile, subtitle };
}

/** Safari does not focus a button on click, and the window returns focus to the element that had it. */
function openFromTile(tile, open) {
    tile.focus({ preventScroll: true });
    open();
}

function createCopyTile(options, slot) {
    const { tile, subtitle } = createTile(options);
    markCopyPlaceholder(subtitle, slot);
    return tile;
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
    /** @type {{ tile: HTMLButtonElement, subtitle: HTMLElement } | null} */
    let current = null;

    function showProgress() {
        if (current) {
            current.subtitle.textContent = formatProgress(state.getResolvedCount(), state.getTotal());
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
        current = createTile({ key: GETTING_STARTED_KEY, icon: 'fa-solid fa-list-check', title: t`Getting Started`, onActivate: tile => openFromTile(tile, openGettingStarted) });
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

    const help = createCopyTile({
        key: 'help',
        icon: 'fa-solid fa-circle-question',
        title: t`Help`,
        onActivate: tile => openFromTile(tile, openHelp),
    }, 'HOME-ROW-HELP');
    const extras = createCopyTile({
        key: 'extras',
        icon: 'fa-solid fa-box-open',
        title: t`Bundled Extras`,
        onActivate: tile => openFromTile(tile, openBundledExtras),
    }, 'HOME-ROW-EXTRAS');

    row.replaceChildren(help, extras);
    stopPreviousTiles = mountGettingStartedTile(row, state, openGettingStarted, onRowChanged);
}
