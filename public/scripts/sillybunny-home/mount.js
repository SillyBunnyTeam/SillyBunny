import { loadListEditorStyles } from '../sillybunny-editor/list-shell.js';
import { createStatusPage } from '../sillybunny-editor/status-page.js';
import { createArtPlaceholder } from './art.js';
import { createArtPanel } from './art-layout.js';
import { mountAssistants } from './assistants-view.js';
import { COPY_PLACEHOLDER, markCopyPlaceholder } from './copy.js';
import { fitCardFooters } from './footer-fit.js';
import { captureHomeFocus, restoreHomeFocus } from './focus.js';
// Listens for the Getting Started signals from the moment the app loads, not from the first render of Home.
import './getting-started-boot.js';
import { getSharedGettingStartedState } from './getting-started.js';
import { fitHomeHeader } from './header-fit.js';
import { chooseHeroArt } from './hero-art.js';
import { openHomeMenu } from './menu.js';
import { getVisibleRegions, parseDisplayMode } from './modes.js';
import { describeTiles, mountTiles } from './tiles-view.js';
// The APP_READY listener that opens Welcome has to exist before that event fires, so it is imported here, at load, and not on the first render of Home.
import './welcome-boot.js';
import { openAbout, openAssistantPicker, openBundledExtras, openGettingStarted, openHelp, openKeyboardShortcuts, showWelcome } from './windows.js';

/**
 * @typedef {object} HomeContext
 * @property {string} version The displayed client version.
 * @property {() => string} getDisplayMode Reads the stored display mode.
 * @property {(mode: string) => void} setDisplayMode Applies and stores a display mode.
 * @property {() => unknown} openRecentChatsSettings
 * @property {AssistantsContext} assistants What the assistant cards show and do.
 *
 * @typedef {Pick<Parameters<typeof mountAssistants>[1], 'getCards' | 'actions' | 'getThumbnailUrl'> & {
 *   getPickerEntries: () => import('./assistant-cards.js').PickerEntry[],
 *   setPointer: (avatar: string | null) => Promise<void>,
 * }} AssistantsContext `setPointer` writes the account's assistant pointer, `null` clears it, and it never rejects.
 */

/**
 * Shows the regions that a display mode lists and hides the rest, without rendering the panel again.
 * @param {HTMLElement} panel The `.welcomePanel` root.
 * @param {unknown} mode
 * @returns {'full' | 'compact' | 'list'} The mode that was applied.
 */
export function applyDisplayMode(panel, mode) {
    const safeMode = parseDisplayMode(mode);
    const visible = new Set(getVisibleRegions(safeMode));
    panel.dataset.homePanelMode = safeMode;
    panel.querySelectorAll('[data-sb-home-region]').forEach((region) => {
        if (region instanceof HTMLElement) {
            region.hidden = !visible.has(region.dataset.sbHomeRegion ?? '');
        }
    });
    describeTiles(panel);
    return safeMode;
}

function getVersionLabel(version) {
    return String(version ?? '').trim().replace(/^SillyBunny\s+/i, '');
}

/**
 * The empty Recent Chats list holds a stand-in where its mascot goes, so the template does not depend on the art
 * code. It becomes the art panel here, in the same place and region, so a display mode hides it as before.
 * @param {HTMLElement} panel
 */
function mountEmptyStateArt(panel) {
    for (const standIn of panel.querySelectorAll('.sbHomeEmpty > [data-sb-art-placeholder="empty-tewi"]')) {
        const { panel: art } = createArtPanel(['empty-tewi']);
        art.dataset.sbHomeRegion = standIn instanceof HTMLElement ? (standIn.dataset.sbHomeRegion ?? '') : '';
        standIn.replaceWith(art);
    }
}

function mountFilteredEmptyState(panel) {
    const container = panel.querySelector('[data-recent-chat-empty-state="filtered"]');
    if (!container) {
        return;
    }

    const { element } = createStatusPage({ icon: 'filter', title: COPY_PLACEHOLDER, description: COPY_PLACEHOLDER, compact: true });
    markCopyPlaceholder(element.querySelector('.sb-status-page__title'), 'RC-FILTER-EMPTY-HEAD');
    markCopyPlaceholder(element.querySelector('.sb-status-page__description'), 'RC-FILTER-EMPTY-BODY');
    container.append(element);
    holdUntilStatusPageStyles(container);
}

/**
 * The status page takes its base styles from the deferred editor-shell sheet, which Home does not wait for. The
 * container shows when a filter has no match. The first time it shows, it stays invisible until the sheet is
 * ready, which is at once when the sheet has loaded already.
 * @param {HTMLElement} container
 */
function holdUntilStatusPageStyles(container) {
    const watcher = new MutationObserver(() => {
        if (container.classList.contains('displayNone')) {
            return;
        }
        watcher.disconnect();
        container.style.visibility = 'hidden';
        loadListEditorStyles()
            .catch(error => console.warn('Failed to load the status page styles for Home.', error))
            .finally(() => container.style.removeProperty('visibility'));
    });
    watcher.observe(container, { attributes: true, attributeFilter: ['class'] });
}

function mountMenuButton(panel, { getDisplayMode, setDisplayMode, openRecentChatsSettings }, gettingStarted) {
    const button = panel.querySelector('.sbHomeMenuButton');
    if (!(button instanceof HTMLElement)) {
        return;
    }

    const actions = {
        setDisplayMode,
        openRecentChatsSettings,
        showWelcome,
        showGettingStarted: () => gettingStarted.setHidden(false),
        openKeyboardShortcuts,
        openHelp,
        openAbout,
    };
    button.addEventListener('click', (event) => {
        openHomeMenu(button, { displayMode: getDisplayMode(), gettingStartedHidden: gettingStarted.isHidden() }, actions, { keyboard: event.detail === 0 });
    });
}

/**
 * Fills a rendered Home panel: the hero art for the time of day, version, external links, menu, tiles, assistants,
 * empty states and the display mode.
 * @param {HTMLElement} panel The `.welcomePanel` root, before or after it is attached.
 * @param {HomeContext} context
 * @returns {{ remountAssistants: () => void }} `remountAssistants` makes the cards again from the context, for a status
 *   that arrived after the panel was mounted. It keeps the focus on the control that had it.
 */
export function mountHome(panel, context) {
    panel.querySelector('[data-sb-home-region="hero"]')?.prepend(createArtPlaceholder(chooseHeroArt(new Date())));
    panel.querySelectorAll('[data-sb-home-version]').forEach((node) => {
        node.textContent = getVersionLabel(context.version);
    });
    panel.querySelectorAll('a[data-sb-external-link]').forEach((link) => {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
    });
    const gettingStarted = getSharedGettingStartedState();
    mountEmptyStateArt(panel);
    mountFilteredEmptyState(panel);
    mountMenuButton(panel, context, gettingStarted);
    mountTiles(panel, {
        state: gettingStarted,
        onRowChanged: () => applyDisplayMode(panel, panel.dataset.homePanelMode),
        openGettingStarted,
        openBundledExtras,
        openHelp,
    });
    const { getPickerEntries, getThumbnailUrl, setPointer } = context.assistants;
    const mountCards = () => {
        mountAssistants(panel, {
            ...context.assistants,
            openPicker: () => openAssistantPicker({ getEntries: getPickerEntries, getThumbnailUrl, choose: setPointer }),
            removeAssistant: () => setPointer(null),
        });
        fitCardFooters(panel);
    };
    mountCards();
    fitHomeHeader(panel);
    applyDisplayMode(panel, context.getDisplayMode());

    return {
        remountAssistants() {
            const grid = panel.querySelector('[data-sb-home-list="assistants"]');
            const focus = grid?.contains(document.activeElement) ? captureHomeFocus(panel) : null;
            mountCards();
            // The art of a card is a region of its own, which the display mode hides in Compact.
            applyDisplayMode(panel, panel.dataset.homePanelMode);
            restoreHomeFocus(panel, focus);
        },
    };
}
