import { play, stopMotion, prefersReducedMotion, SPRING_NAVIGATION, MOTION_FAST } from './sillybunny-motion.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from './popup.js';
import { t } from './i18n.js';

/**
 * Generic two-pane List→Editor shell component.
 *
 * Owns: split-pane layout, sidebar resize, collapse/expand responsive
 * behaviour, open/close animation, dirty guard before navigation,
 * and beforeunload guard.
 *
 * Does not own: list content, detail pane content, save logic, or
 * any domain-specific state — those are supplied via callbacks.
 *
 * @param {object} config
 * @param {HTMLElement} config.container         Root element to mount into.
 * @param {string}      config.storageKey        localStorage key for sidebar width.
 * @param {number}      [config.defaultWidth=0.30] Sidebar default width (0–1 fraction).
 * @param {number}      [config.minWidth=240]    Minimum sidebar width in px.
 * @param {number}      [config.maxWidth=420]    Maximum sidebar width in px.
 * @param {number}      [config.collapseAt=720]  Root px width below which sidebar collapses.
 * @param {Function}    config.renderList        (listEl: HTMLElement) => void — populate/refresh list.
 * @param {Function}    config.renderDetail      (detailEl: HTMLElement, item: *) => void — render detail pane.
 * @param {Function}    config.onSave            async () => boolean — save current item; return false on failure.
 * @param {Function}    config.isDirty           () => boolean — true when there are unsaved changes.
 * @param {Function}    config.onDiscard         () => void — discard unsaved changes and reset state.
 * @param {Function}    [config.onSelect]        (item: *) => void — called when an item is selected.
 * @param {Function}    [config.onDeselect]      () => void — called when returning to list.
 * @returns {{
 *   root: HTMLElement,
 *   sidebar: HTMLElement,
 *   detail: HTMLElement,
 *   status: HTMLElement,
 *   selectItem: (item: *) => Promise<void>,
 *   deselectItem: () => Promise<void>,
 *   refresh: () => void,
 *   scheduleRefresh: () => void,
 *   destroy: () => void,
 * }}
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
    } = config;

    // --- DOM shell ---

    const root = document.createElement('div');
    root.className = 'sb-list-editor';
    root.dataset.open = 'false';
    root.dataset.collapsed = 'false';

    const sidebar = document.createElement('div');
    sidebar.className = 'sb-list-editor__sidebar';

    const divider = document.createElement('div');
    divider.className = 'sb-list-editor__divider';
    divider.tabIndex = 0;
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', 'vertical');
    divider.setAttribute('aria-label', t`Resize sidebar`);
    divider.setAttribute('aria-valuemin', String(minWidth));
    divider.setAttribute('aria-valuemax', String(maxWidth));

    const detail = document.createElement('div');
    detail.className = 'sb-list-editor__detail';
    detail.hidden = true;
    detail.inert = true;

    const status = document.createElement('div');
    status.className = 'sb-list-editor__status';
    status.setAttribute('aria-live', 'polite');

    root.append(sidebar, divider, detail, status);
    container.append(root);

    // --- State ---

    let selectedItem = null;
    let collapsed = false;
    let sidebarWidth = Number(localStorage.getItem(storageKey)) || 0;
    let transition = null;
    let layoutFrame = 0;
    let refreshPending = false;
    let pointerActive = false;
    let busy = false;
    const mobile = matchMedia('(max-width: 768px)');
    const listWidth = () => Math.max(minWidth, Math.min(maxWidth, sidebarWidth || root.clientWidth * defaultWidth));

    // --- Layout ---

    function layout() {
        if (transition) return;
        const width = root.clientWidth;
        if (!width) return;
        const nextCollapsed = mobile.matches || width < collapseAt;
        const nextListWidth = listWidth();
        const hideList = Boolean(selectedItem) && nextCollapsed;
        collapsed = nextCollapsed;
        if (root.dataset.collapsed !== String(collapsed)) root.dataset.collapsed = String(collapsed);
        if (root.style.getPropertyValue('--sb-list-editor-sidebar-width') !== `${nextListWidth}px`) {
            root.style.setProperty('--sb-list-editor-sidebar-width', `${nextListWidth}px`);
        }
        if (divider.getAttribute('aria-valuenow') !== String(Math.round(nextListWidth))) {
            divider.setAttribute('aria-valuenow', String(Math.round(nextListWidth)));
        }
        if (sidebar.inert !== hideList) sidebar.inert = hideList;
        if (Boolean(selectedItem) !== root.dataset.open === 'true') {
            root.dataset.open = String(Boolean(selectedItem));
        }
    }

    function scheduleLayout() {
        if (layoutFrame) return;
        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = 0;
            layout();
        });
    }

    // --- Animation ---

    function cancelTransition() {
        if (transition) {
            const previous = transition;
            transition = null;
            cancelAnimationFrame(previous.startFrame);
            previous.handles.forEach(h => h?.cancel());
        }
        for (const node of [sidebar, detail]) {
            stopMotion(node);
            for (const prop of ['width', 'transform', 'opacity', 'will-change']) node.style.removeProperty(prop);
        }
        if (detail.classList.contains('sb-list-editor__detail--travelling')) {
            detail.classList.remove('sb-list-editor__detail--travelling');
        }
        if (detail.hidden !== !selectedItem) detail.hidden = !selectedItem;
        if (detail.inert !== !selectedItem) detail.inert = !selectedItem;
        const listInert = collapsed && Boolean(selectedItem);
        if (sidebar.inert !== listInert) sidebar.inert = listInert;
        if (refreshPending) { refreshPending = false; renderList(sidebar); }
    }

    function navigate(opening, startListWidth) {
        const frame = { handles: [], remaining: 2, startFrame: 0 };
        transition = frame;
        detail.hidden = false;
        detail.inert = !opening;
        detail.classList.add('sb-list-editor__detail--travelling');
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
        detail.getBoundingClientRect();
        if (prefersReducedMotion()) start();
        else frame.startFrame = requestAnimationFrame(start);
    }

    // --- Dirty guard ---

    async function allowLeave() {
        if (!isDirty()) return true;
        if (busy) return false;
        busy = true;
        const popup = new Popup(
            (() => { const p = document.createElement('p'); p.textContent = t`Unsaved changes`; return p; })(),
            POPUP_TYPE.CONFIRM, '', {
                okButton: t`Save`,
                cancelButton: t`Cancel`,
                customButtons: [{ text: t`Discard`, result: 2 }],
                defaultResult: POPUP_RESULT.NEGATIVE,
            },
        );
        popup.cancelButton.style.order = '0';
        popup.okButton.style.order = '2';
        const result = await popup.show();
        busy = false;
        if (result === POPUP_RESULT.AFFIRMATIVE) return onSave();
        if (result !== 2) return false;
        onDiscard();
        return true;
    }

    // --- Public: select / deselect ---

    async function selectItem(item) {
        if (selectedItem === item) return;
        if (!(await allowLeave())) return;
        cancelTransition();
        const wasOpen = Boolean(selectedItem);
        const startWidth = sidebar.getBoundingClientRect().width;
        selectedItem = item;
        root.dataset.open = 'true';
        detail.replaceChildren();
        renderDetail(detail, item);
        layout();
        if (!wasOpen) navigate(true, startWidth);
        else play(detail, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
        onSelect?.(item);
        detail.querySelector('[autofocus], input, button')?.focus({ preventScroll: true });
    }

    async function deselectItem() {
        if (!selectedItem) return;
        if (!(await allowLeave())) return;
        cancelTransition();
        const startWidth = sidebar.getBoundingClientRect().width;
        selectedItem = null;
        sidebar.inert = false;
        root.dataset.open = 'false';
        navigate(false, startWidth);
        onDeselect?.();
    }

    function deselectNow() {
        selectedItem = null;
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
        sidebarWidth = Math.max(minWidth, Math.min(maxWidth, listWidth() + (event.key === 'ArrowLeft' ? -10 : 10)));
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
            sidebarWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + moveEvent.clientX - startX));
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

    // --- List drag-guard (for sortable, prevents render during drag) ---

    sidebar.addEventListener('pointerdown', event => {
        if (event.target.closest('.sb-list-editor__drag-handle[aria-disabled="false"]')) pointerActive = true;
    }, true);

    const finishPointer = () => {
        if (!pointerActive) return;
        pointerActive = false;
        requestAnimationFrame(() => {
            if (!refreshPending) return;
            refreshPending = false;
            renderList(sidebar);
        });
    };
    window.addEventListener('pointerup', finishPointer, true);
    window.addEventListener('pointercancel', finishPointer, true);
    window.addEventListener('blur', finishPointer);

    // --- Keyboard: Escape closes detail when clean ---

    detail.addEventListener('keydown', async event => {
        if (event.key !== 'Escape') return;
        if (event.target.closest('input, textarea, select, [role="listbox"], [role="dialog"]')) return;
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

    // --- ResizeObserver ---

    const resizeObserver = new ResizeObserver(scheduleLayout);
    resizeObserver.observe(root);
    mobile.addEventListener('change', () => { cancelTransition(); scheduleLayout(); });

    // --- Initial render ---

    renderList(sidebar);
    scheduleLayout();

    // --- Destroy ---

    function destroy() {
        cancelAnimationFrame(layoutFrame);
        cancelTransition();
        resizeObserver.disconnect();
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
        scheduleLayout,
        layout,
        allowLeave,
        get selectedItem() { return selectedItem; },
        destroy,
    };
}
