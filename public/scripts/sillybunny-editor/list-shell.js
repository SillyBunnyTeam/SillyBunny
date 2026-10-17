import { play, stopMotion, prefersReducedMotion, SPRING_NAVIGATION, MOTION_FAST } from '../sillybunny-motion.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../popup.js';
import { t } from '../i18n.js';

export const LIST_EDITOR_STYLESHEET = { href: 'css/sillybunny-editor-shell.css?v=20261018a', id: 'deferred-editor-shell-css' };

/**
 * Loads the deferred shell stylesheet. Consumers await it before revealing the shell.
 * @returns {Promise<unknown>}
 */
export function loadListEditorStyles() {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    return loader ? loader(LIST_EDITOR_STYLESHEET.href, { id: LIST_EDITOR_STYLESHEET.id }) : Promise.resolve();
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
 * @param {number}      [config.collapseAt=720]         Root width below which the panes stack.
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
        collapseAt = 720,
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
    const mobile = matchMedia('(max-width: 768px)');
    const clampWidth = value => Math.max(minWidth, Math.min(maxWidth, value));
    const listWidth = () => clampWidth(sidebarWidth || root.clientWidth * defaultWidth);

    // --- Layout ---

    function layout() {
        if (transition) return;
        const width = root.clientWidth;
        if (!width) return;
        const nextCollapsed = mobile.matches || width < collapseAt;
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
     */
    async function allowLeave() {
        if (!isDirty()) return true;
        if (busy) return false;
        busy = true;
        let result;
        try {
            const message = document.createElement('p');
            message.textContent = t`Unsaved changes`;
            const popup = new Popup(message, POPUP_TYPE.CONFIRM, '', {
                okButton: t`Save`,
                cancelButton: t`Cancel`,
                customButtons: [{ text: t`Discard`, result: 2 }],
                defaultResult: POPUP_RESULT.NEGATIVE,
            });
            // AdwAlertDialog order: Cancel · Discard · Save.
            popup.cancelButton.style.order = '0';
            popup.okButton.style.order = '2';
            result = await popup.show();
        } finally {
            busy = false;
        }
        if (result === POPUP_RESULT.AFFIRMATIVE) return Boolean(await onSave());
        if (result !== 2) return false;
        onDiscard();
        return true;
    }

    // --- Public: select / deselect ---

    /**
     * @param {unknown} item
     * @param {{ guard?: boolean, force?: boolean }} [options] `guard: false` skips the leave guard
     *   (the caller already ran it); `force` re-renders when the same key is already open.
     * @returns {Promise<boolean>} Whether this selection is now displayed.
     */
    async function selectItem(item, { guard = true, force = false } = {}) {
        const key = getKey(item);
        if (isOpen && Object.is(key, selectedKey) && !force) return true;
        if (guard && !(await allowLeave())) return false;
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
        const isCurrent = () => token === renderToken;
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
            if (target) play(target, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
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
