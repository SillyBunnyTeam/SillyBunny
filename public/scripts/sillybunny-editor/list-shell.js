import { play, stopMotion, prefersReducedMotion, SPRING_NAVIGATION, MOTION_FAST } from '../sillybunny-motion.js';
import { t } from '../i18n.js';
import { LAYOUT_MOBILE_QUERY } from './breakpoints.js';
import { askLeaveEditor } from './leave-dialog.js';

const DEFAULT_COLLAPSE_AT = 720;

export const LIST_EDITOR_STYLESHEET = { href: 'css/sillybunny-editor-shell.css?v=20261117zo', id: 'deferred-editor-shell-css' };
/** The header, action, field and section rules that every explicit-save editor shares. index.html preloads it. */
export const EDITOR_CHROME_STYLESHEET = { href: 'css/sillybunny-character-editor.css?v=20261117zg', id: 'deferred-editor-chrome-css' };

/**
 * Loads the editor chrome stylesheet on its own, for the editors that have no list shell.
 * @returns {Promise<unknown>}
 */
export function loadEditorChromeStyles() {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    return loader ? loader(EDITOR_CHROME_STYLESHEET.href, { id: EDITOR_CHROME_STYLESHEET.id }) : Promise.resolve();
}

/**
 * Loads the deferred shell stylesheet and the editor chrome it builds on. Consumers await it before revealing the shell.
 * @returns {Promise<unknown>}
 */
export function loadListEditorStyles() {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    return loader
        ? Promise.all([LIST_EDITOR_STYLESHEET, EDITOR_CHROME_STYLESHEET].map(({ href, id }) => loader(href, { id })))
        : Promise.resolve();
}

const ACTIVE_MENU_CLASS = 'sb-active-right-menu';

// The mobile shell makes an active menu `visibility: visible !important`, which only an important inline value outranks.
const isHeld = menu => menu.style.getPropertyValue('visibility') === 'hidden' && menu.style.getPropertyPriority('visibility') === 'important';

// The character editor needs only the chrome sheet. The group editor also reads the list shell, so it waits for both.
const GATED_MENUS = Object.freeze([
    { id: 'rm_ch_create_block', load: loadEditorChromeStyles },
    { id: 'rm_group_chats_block', load: loadListEditorStyles },
]);

/**
 * The character and group editors are static markup that `selectRightMenuWithAnimation()` shows from many paths.
 * Their rules come from a deferred sheet, so a menu that turns active before its sheet applies is kept
 * invisible until the sheet is ready. The observer runs in the microtask after the script that showed the
 * menu, which is before the browser's next frame, so no frame paints the menu unstyled. Once a sheet is ready it
 * stays applied, and the gate for that menu ends.
 * @returns {() => void} Stops the gate and shows any held menu.
 */
export function holdEditorsUntilStyled() {
    const gates = GATED_MENUS.map(({ id, load }) => ({ menu: document.getElementById(id), load, ready: false, loading: false, held: false }))
        .filter(gate => gate.menu instanceof HTMLElement);
    const observers = [];

    const release = gate => {
        gate.ready = true;
        if (!gate.held) return;
        gate.held = false;
        // The sheet's rules start transitions from the unstyled values while the menu is still hidden. Finish them, so
        // the first frame that shows the menu has the end values. The menu's own fade-in is not one of them.
        const { CSSTransition } = globalThis;
        if (typeof CSSTransition === 'function') {
            for (const animation of gate.menu.getAnimations({ subtree: true })) {
                if (animation instanceof CSSTransition && animation.effect?.target !== gate.menu) animation.finish();
            }
        }
        if (gate.menu.classList.contains(ACTIVE_MENU_CLASS) && isHeld(gate.menu)) {
            gate.menu.style.setProperty('visibility', 'visible');
        }
    };

    const hold = gate => {
        if (gate.ready || !gate.menu.classList.contains(ACTIVE_MENU_CLASS)) return;
        if (!isHeld(gate.menu)) gate.menu.style.setProperty('visibility', 'hidden', 'important');
        gate.held = true;
        if (gate.loading) return;
        gate.loading = true;
        // A failed sheet must not leave the editor invisible: the editor works without its styles.
        Promise.resolve()
            .then(() => gate.load())
            .catch(error => console.warn('Failed to load the editor styles.', error))
            .finally(() => release(gate));
    };

    for (const gate of gates) {
        const observer = new MutationObserver(() => hold(gate));
        observer.observe(gate.menu, { attributes: true, attributeFilter: ['class', 'style'] });
        observers.push(observer);
        hold(gate);
    }

    return () => {
        for (const observer of observers) observer.disconnect();
        for (const gate of gates) release(gate);
    };
}

/**
 * Whether the list and detail panes stack instead of sitting side by side. Callers that must agree
 * with a list editor, for example when watching an ancestor of its root, use this same rule.
 * @param {{ viewportMobile: boolean, width: number, collapseAt?: number }} layout
 *   `width` is the root width; `viewportMobile` is whether `LAYOUT_MOBILE_QUERY` matches.
 * @returns {boolean}
 */
export function isListEditorCollapsed({ viewportMobile, width, collapseAt = DEFAULT_COLLAPSE_AT }) {
    return viewportMobile || width < collapseAt;
}

function classes(base, extra) {
    return [base, extra].filter(Boolean).join(' ');
}

function cssEscape(value) {
    return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

/**
 * Generic two-pane List→Editor shell (libadwaita AdwNavigationSplitView pattern).
 *
 * Owns: split-pane layout, sidebar resize, responsive collapse, open/close motion,
 * inert background, focus handoff, the Save/Discard/Cancel leave guard, and the
 * beforeunload guard. Consumers own list rows, detail content, drafts and saving.
 *
 * Selection is tracked by key (`getKey(item)`), so falsy keys such as a World Info
 * UID of 0 are valid. `renderDetail` may be async; a newer selection supersedes an
 * older one and the stale render's result is ignored.
 *
 * @param {object} config
 * @param {HTMLElement} config.container                Element to mount into.
 * @param {string}      config.storageKey               localStorage key for the sidebar width.
 * @param {number}      [config.defaultWidth=0.30]      Default sidebar width as a fraction of the root.
 * @param {number}      [config.minWidth=240]
 * @param {number}      [config.maxWidth=420]
 * @param {number}      [config.collapseAt=720]         Root width below which the panes stack (see `isListEditorCollapsed`).
 * @param {(sidebar: HTMLElement) => unknown} config.renderList
 * @param {(detail: HTMLElement, item: unknown, context: { isCurrent: () => boolean }) => unknown} config.renderDetail
 * @param {() => boolean|Promise<boolean>} config.onSave  Save the open item; false keeps the user in place.
 * @param {() => boolean} config.isDirty
 * @param {() => void}    config.onDiscard              Revert unsaved changes.
 * @param {(item: unknown) => void} [config.onSelect]   Called after the detail is rendered and laid out.
 * @param {() => void}    [config.onDeselect]           Called when the detail starts closing.
 * @param {(item: unknown) => unknown} [config.getKey]  Selection identity. Defaults to the item itself.
 * @param {(key: unknown) => HTMLElement|null} [config.findRow] Row to refocus after closing.
 * @param {(detail: HTMLElement) => HTMLElement|null} [config.focusTarget] Element focused after opening.
 * @param {(detail: HTMLElement) => HTMLElement|null} [config.fadeTarget]  Element faded when switching items.
 * @param {boolean} [config.transitionItemSwitch=true] Cross-fades the detail when switching between open items.
 * @param {(info: LayoutInfo) => unknown} [config.measureLayout] Layout reads, run before shell writes.
 * @param {(measurement: unknown, info: LayoutInfo) => void} [config.applyLayout] Layout writes.
 * @param {(collapsed: boolean) => void} [config.onCollapseChange]
 * @param {string}  [config.dragHandleSelector]         Pointer-downs on this defer list refreshes.
 * @param {boolean} [config.escapeCloses=true]          Escape outside fields closes the detail.
 * @param {string}  [config.rootTag='div']
 * @param {string}  [config.label]                      Accessible name for the root.
 * @param {string}  [config.dividerLabel]
 * @param {{ root?: string, sidebar?: string, divider?: string, detail?: string, status?: string }} [config.classNames]
 *
 * @typedef {{ width: number, collapsed: boolean, open: boolean, listWidth: number, collapseChanged: boolean }} LayoutInfo
 */
export function createListEditor(config) {
    const {
        container,
        storageKey,
        defaultWidth = 0.30,
        minWidth = 240,
        maxWidth = 420,
        collapseAt = DEFAULT_COLLAPSE_AT,
        renderList,
        renderDetail,
        onSave,
        isDirty,
        onDiscard,
        onSelect = null,
        onDeselect = null,
        getKey = item => item,
        findRow = null,
        focusTarget = null,
        fadeTarget = null,
        transitionItemSwitch = true,
        measureLayout = null,
        applyLayout = null,
        onCollapseChange = null,
        dragHandleSelector = '.sb-list-editor__drag-handle[aria-disabled="false"]',
        escapeCloses = true,
        rootTag = 'div',
        label = '',
        dividerLabel = t`Resize sidebar`,
        classNames = {},
    } = config;

    // --- DOM shell ---

    const root = document.createElement(rootTag);
    root.className = classes('sb-list-editor', classNames.root);
    root.dataset.open = 'false';
    root.dataset.collapsed = 'false';
    if (label) root.setAttribute('aria-label', label);

    const sidebar = document.createElement('div');
    sidebar.className = classes('sb-list-editor__sidebar', classNames.sidebar);

    const divider = document.createElement('div');
    divider.className = classes('sb-list-editor__divider', classNames.divider);
    divider.tabIndex = 0;
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', 'vertical');
    divider.setAttribute('aria-label', dividerLabel);
    divider.setAttribute('aria-valuemin', String(minWidth));
    divider.setAttribute('aria-valuemax', String(maxWidth));

    const detail = document.createElement('div');
    detail.className = classes('sb-list-editor__detail', classNames.detail);
    detail.hidden = true;
    detail.inert = true;

    const status = document.createElement('div');
    status.className = classes('sb-list-editor__status', classNames.status);
    status.setAttribute('aria-live', 'polite');

    root.append(sidebar, divider, detail, status);
    container.append(root);

    // --- State ---

    let isOpen = false;
    let selectedItem = null;
    let selectedKey = null;
    let returnKey = null;
    let renderToken = 0;
    let collapsed = false;
    let sidebarWidth = Number(localStorage.getItem(storageKey)) || 0;
    let transition = null;
    let layoutFrame = 0;
    let refreshPending = false;
    let pointerActive = false;
    let busy = false;
    const mobile = matchMedia(LAYOUT_MOBILE_QUERY);
    const clampWidth = value => Math.max(minWidth, Math.min(maxWidth, value));
    const listWidth = () => clampWidth(sidebarWidth || root.clientWidth * defaultWidth);

    // --- Layout ---

    function layout() {
        if (transition) return;
        const width = root.clientWidth;
        if (!width) return;
        const nextCollapsed = isListEditorCollapsed({ viewportMobile: mobile.matches, width, collapseAt });
        const nextListWidth = listWidth();
        const info = { width, collapsed: nextCollapsed, open: isOpen, listWidth: nextListWidth, collapseChanged: nextCollapsed !== collapsed };
        const measurement = measureLayout?.(info);
        if (info.collapseChanged) onCollapseChange?.(nextCollapsed);
        collapsed = nextCollapsed;
        if (root.dataset.collapsed !== String(collapsed)) root.dataset.collapsed = String(collapsed);
        if (root.dataset.open !== String(isOpen)) root.dataset.open = String(isOpen);
        if (root.style.getPropertyValue('--sb-list-editor-sidebar-width') !== `${nextListWidth}px`) {
            root.style.setProperty('--sb-list-editor-sidebar-width', `${nextListWidth}px`);
        }
        if (divider.getAttribute('aria-valuenow') !== String(Math.round(nextListWidth))) {
            divider.setAttribute('aria-valuenow', String(Math.round(nextListWidth)));
        }
        const listInert = isOpen && collapsed;
        if (sidebar.inert !== listInert) sidebar.inert = listInert;
        applyLayout?.(measurement, info);
    }

    function scheduleLayout() {
        if (layoutFrame) return;
        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = 0;
            layout();
        });
    }

    // --- Rendering deferral ---

    function flushRefresh() {
        if (!refreshPending || transition || pointerActive) return;
        refreshPending = false;
        renderList(sidebar);
    }

    function deferRefresh() {
        refreshPending = true;
    }

    // --- Animation ---

    function cancelTransition() {
        if (transition) {
            const previous = transition;
            transition = null;
            cancelAnimationFrame(previous.startFrame);
            previous.handles.forEach(handle => handle?.cancel());
        }
        for (const node of [sidebar, detail]) {
            stopMotion(node);
            for (const property of ['width', 'transform', 'opacity', 'will-change']) node.style.removeProperty(property);
        }
        if (detail.classList.contains('sb-list-editor__detail--travelling')) {
            detail.classList.remove('sb-list-editor__detail--travelling');
        }
        if (detail.hidden !== !isOpen) detail.hidden = !isOpen;
        if (detail.inert !== !isOpen) detail.inert = !isOpen;
        const listInert = collapsed && isOpen;
        if (sidebar.inert !== listInert) sidebar.inert = listInert;
        flushRefresh();
    }

    function navigate(opening, startListWidth) {
        const frame = { handles: [], remaining: 2, startFrame: 0 };
        transition = frame;
        detail.hidden = false;
        detail.inert = !opening;
        detail.classList.add('sb-list-editor__detail--travelling');
        // The list reflows to its target width; the detail keeps its settled width and slides over it.
        detail.style.width = `${collapsed ? root.clientWidth : root.clientWidth - listWidth() - 1}px`;
        detail.style.transform = opening ? 'translateX(100%)' : 'none';
        sidebar.style.width = `${startListWidth}px`;
        if (collapsed) {
            sidebar.style.transform = opening ? 'none' : 'translateX(-26%)';
            sidebar.style.opacity = opening ? '1' : '0.42';
        }
        const finish = () => {
            if (transition !== frame || --frame.remaining) return;
            transition = null;
            cancelTransition();
            layout();
            renderList(sidebar);
        };
        const start = () => {
            if (transition !== frame) return;
            frame.handles.push(play(detail, opening
                ? [{ transform: 'translateX(100%)' }, { transform: 'none' }]
                : [{ transform: 'none' }, { transform: 'translateX(100%)' }],
            { ...SPRING_NAVIGATION, fill: 'both', onEnd: finish }));
            frame.handles.push(play(sidebar, collapsed
                ? opening
                    ? [{ transform: 'none', opacity: 1 }, { transform: 'translateX(-26%)', opacity: 0.42 }]
                    : [{ transform: 'translateX(-26%)', opacity: 0.42 }, { transform: 'none', opacity: 1 }]
                : [{ width: `${startListWidth}px` }, { width: `${opening ? listWidth() : root.clientWidth}px` }],
            { ...SPRING_NAVIGATION, fill: 'both', onEnd: finish }));
        };
        // Settle the new detail DOM and its container-query layout before the first animation frame.
        detail.getBoundingClientRect();
        if (prefersReducedMotion()) start();
        else frame.startFrame = requestAnimationFrame(start);
    }

    // --- Dirty guard ---

    /**
     * Resolves true when it is safe to leave the open item (clean, saved, or discarded).
     * Consumers call this before any navigation the shell does not own (book switch, paging).
     * @param {() => boolean} [isCurrent] Navigation transaction currency.
     */
    async function allowLeave(isCurrent = () => true) {
        if (!isCurrent()) return false;
        if (!isDirty()) return true;
        if (busy) return false;
        busy = true;
        let choice;
        try {
            choice = await askLeaveEditor();
        } finally {
            busy = false;
        }
        if (!isCurrent()) return false;
        if (choice === 'save') {
            const saved = await onSave();
            return isCurrent() && Boolean(saved);
        }
        if (choice !== 'discard') return false;
        onDiscard();
        return true;
    }

    // --- Public: select / deselect ---

    /**
     * @param {unknown} item
     * @param {{ guard?: boolean, force?: boolean, isCurrent?: () => boolean, transition?: boolean }} [options] `guard: false` skips the leave guard
     *   (the caller already ran it); `force` re-renders when the same key is already open.
     * @returns {Promise<boolean>} Whether this selection is now displayed.
     */
    async function selectItem(item, { guard = true, force = false, isCurrent: requestIsCurrent = () => true, transition = transitionItemSwitch } = {}) {
        if (!requestIsCurrent()) return false;
        const key = getKey(item);
        if (isOpen && Object.is(key, selectedKey) && !force) return true;
        if (guard && !(await allowLeave(requestIsCurrent))) return false;
        if (!requestIsCurrent()) return false;
        cancelTransition();
        const wasOpen = isOpen;
        const startWidth = sidebar.getBoundingClientRect().width;
        const token = ++renderToken;
        isOpen = true;
        selectedItem = item;
        selectedKey = key;
        returnKey = key;
        root.dataset.open = 'true';
        detail.replaceChildren();
        const isCurrent = () => token === renderToken && requestIsCurrent();
        try {
            const pending = renderDetail(detail, item, { isCurrent });
            if (pending && typeof pending.then === 'function') await pending;
        } catch (error) {
            if (isCurrent()) deselectNow();
            throw error;
        }
        if (!isCurrent()) return false;
        layout();
        if (!wasOpen) navigate(true, startWidth);
        else {
            const target = fadeTarget?.(detail) ?? detail;
            if (transition && target) play(target, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
        }
        onSelect?.(item);
        const focus = focusTarget ? focusTarget(detail) : detail.querySelector('[autofocus], input, button');
        focus?.focus({ preventScroll: true });
        return true;
    }

    /**
     * @param {{ guard?: boolean }} [options]
     * @returns {Promise<boolean>} Whether the detail closed.
     */
    async function deselectItem({ guard = true } = {}) {
        if (!isOpen) return true;
        if (guard && !(await allowLeave())) return false;
        cancelTransition();
        const startWidth = sidebar.getBoundingClientRect().width;
        renderToken++;
        isOpen = false;
        selectedItem = null;
        selectedKey = null;
        sidebar.inert = false;
        root.dataset.open = 'false';
        onDeselect?.();
        navigate(false, startWidth);
        const row = findRow
            ? findRow(returnKey)
            : sidebar.querySelector(`[data-sb-list-key="${cssEscape(returnKey)}"]`);
        row?.focus({ preventScroll: true });
        return true;
    }

    /** Closes immediately: no guard, no motion, no onDeselect. */
    function deselectNow() {
        renderToken++;
        isOpen = false;
        selectedItem = null;
        selectedKey = null;
        cancelTransition();
        root.dataset.open = 'false';
        detail.hidden = true;
        detail.inert = true;
        layout();
    }

    // --- Public: refresh ---

    function refresh() {
        if (transition || pointerActive) { refreshPending = true; return; }
        renderList(sidebar);
    }

    function scheduleRefresh() {
        refreshPending = true;
        scheduleLayout();
    }

    // --- Divider: keyboard ---

    divider.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        sidebarWidth = clampWidth(listWidth() + (event.key === 'ArrowLeft' ? -10 : 10));
        localStorage.setItem(storageKey, String(sidebarWidth));
        layout();
    });

    // --- Divider: pointer drag ---

    divider.addEventListener('pointerdown', event => {
        if (transition) return;
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startWidth = listWidth();
        const move = moveEvent => {
            sidebarWidth = clampWidth(startWidth + moveEvent.clientX - startX);
            scheduleLayout();
        };
        const end = () => {
            divider.removeEventListener('pointermove', move);
            divider.removeEventListener('pointerup', end);
            divider.removeEventListener('pointercancel', end);
            localStorage.setItem(storageKey, String(sidebarWidth));
        };
        divider.addEventListener('pointermove', move);
        divider.addEventListener('pointerup', end, { once: true });
        divider.addEventListener('pointercancel', end, { once: true });
    });

    // --- List drag guard: keep rows stable while a sortable drag is in progress ---

    sidebar.addEventListener('pointerdown', event => {
        if (dragHandleSelector && event.target?.closest?.(dragHandleSelector)) pointerActive = true;
    }, true);

    const finishPointer = () => {
        if (!pointerActive) return;
        pointerActive = false;
        requestAnimationFrame(flushRefresh);
    };
    window.addEventListener('pointerup', finishPointer, true);
    window.addEventListener('pointercancel', finishPointer, true);
    window.addEventListener('blur', finishPointer);

    // --- Keyboard: Escape closes the detail (guarded) ---

    detail.addEventListener('keydown', async event => {
        if (!escapeCloses || event.key !== 'Escape' || event.isComposing) return;
        if (event.target?.closest?.('input, textarea, select, [role="listbox"], [role="dialog"]')) return;
        event.preventDefault();
        event.stopPropagation();
        await deselectItem();
    });

    // --- beforeunload guard ---

    const onBeforeUnload = event => {
        if (!isDirty()) return;
        event.preventDefault();
        event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    // --- Resize ---

    const resizeObserver = new ResizeObserver(scheduleLayout);
    resizeObserver.observe(root);
    const onMobileChange = () => { cancelTransition(); scheduleLayout(); };
    mobile.addEventListener('change', onMobileChange);

    // --- Initial render ---

    renderList(sidebar);
    scheduleLayout();

    // --- Destroy ---

    function destroy() {
        cancelAnimationFrame(layoutFrame);
        renderToken++;
        cancelTransition();
        resizeObserver.disconnect();
        mobile.removeEventListener('change', onMobileChange);
        window.removeEventListener('beforeunload', onBeforeUnload);
        window.removeEventListener('pointerup', finishPointer, true);
        window.removeEventListener('pointercancel', finishPointer, true);
        window.removeEventListener('blur', finishPointer);
        root.remove();
    }

    return {
        root,
        sidebar,
        detail,
        status,
        selectItem,
        deselectItem,
        deselectNow,
        refresh,
        scheduleRefresh,
        deferRefresh,
        flushRefresh,
        scheduleLayout,
        layout,
        allowLeave,
        guardLeave: allowLeave,
        cancelNavigation: cancelTransition,
        get selectedItem() { return selectedItem; },
        get selectedKey() { return selectedKey; },
        get isOpen() { return isOpen; },
        get isNavigating() { return Boolean(transition); },
        get collapsed() { return collapsed; },
        get pointerActive() { return pointerActive; },
        destroy,
    };
}
