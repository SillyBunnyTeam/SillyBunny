import { createStatusPage } from '../sillybunny-editor/status-page.js';
import { mountAssistants } from './assistants-view.js';
import { COPY_PLACEHOLDER, markCopyPlaceholder } from './copy.js';
import { createExtrasPage } from './extras-page.js';
import { mountGettingStarted } from './getting-started-view.js';
import { createHomePageHost } from './home-page.js';
import { mountLinks } from './links-view.js';
import { openHomeMenu } from './menu.js';
import { getVisibleRegions, parseDisplayMode } from './modes.js';
import { openAbout, openHelp, openKeyboardShortcuts, showWelcome } from './windows.js';

/**
 * @typedef {object} HomeContext
 * @property {string} version The displayed client version.
 * @property {() => string} getDisplayMode Reads the stored display mode.
 * @property {(mode: string) => void} setDisplayMode Applies and stores a display mode.
 * @property {() => unknown} openRecentChatsSettings
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
    return safeMode;
}

function getVersionLabel(version) {
    return String(version ?? '').trim().replace(/^SillyBunny\s+/i, '');
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
}

function mountMenuButton(panel, { getDisplayMode, setDisplayMode, openRecentChatsSettings }) {
    const button = panel.querySelector('.sbHomeMenuButton');
    if (!(button instanceof HTMLElement)) {
        return;
    }

    const actions = { setDisplayMode, openRecentChatsSettings, showWelcome, openKeyboardShortcuts, openHelp, openAbout };
    button.addEventListener('click', (event) => {
        openHomeMenu(button, { displayMode: getDisplayMode() }, actions, { keyboard: event.detail === 0 });
    });
}

/**
 * Fills a rendered Home panel: version, external links, menu, sections, empty states and the display mode.
 * @param {HTMLElement} panel The `.welcomePanel` root, before or after it is attached.
 * @param {HomeContext} context
 */
export function mountHome(panel, context) {
    panel.querySelectorAll('[data-sb-home-version]').forEach((node) => {
        node.textContent = getVersionLabel(context.version);
    });
    panel.querySelectorAll('a[data-sb-external-link]').forEach((link) => {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
    });
    mountFilteredEmptyState(panel);
    mountMenuButton(panel, context);
    const pages = createHomePageHost(panel);
    mountGettingStarted(panel);
    mountAssistants(panel);
    mountLinks(panel, {
        openBundledExtras: opener => pages.push(createExtrasPage({ goBack: () => pages.pop() }), opener),
        openHelp,
    });
    applyDisplayMode(panel, context.getDisplayMode());
}
