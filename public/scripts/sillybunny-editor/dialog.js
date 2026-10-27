import { t } from '../i18n.js';
import {
    MOTION_EASE_OUT_CUBIC,
    MOTION_FAST,
    SPRING_DIALOG,
    SPRING_NAVIGATION,
    SPRING_SHEET,
    animateIn,
    play,
    prefersReducedMotion,
    stopMotion,
} from '../sillybunny-motion.js';
import { blockUpstreamDrawerClose } from '../sillybunny-sheet.js';
import { closeActionMenu, openActionMenu } from '../sillybunny-action-menu.js';
import { closePicker } from './picker.js';
import { createListSearch } from './list-search.js';
import { bindSheetGestures } from './sheet-gestures.js';
import { OVERLAY_SHEET_QUERY } from './breakpoints.js';
import { MODAL_ATTRIBUTE, getTopmostDialog, hostOverlayLayer, releaseOverlayLayers } from './overlay-host.js';
import { FOCUSABLE_SELECTOR, closeChain, coverSurface, findCoveredSurface, registerChainLevel, unregisterChainLevel } from './page-chain.js';

/*
 * Shared dialog frame.
 * - openAlert mirrors AdwAlertDialog: heading, body, optional extra child, 1–3 responses.
 * - openDialog mirrors AdwDialog with a header bar: the Dialog tier follows its content up to
 *   640px wide; the Window tier takes the shell's large pop-out footprint.
 * Both float above a scrim and become bottom sheets under OVERLAY_SHEET_QUERY.
 */

export { getTopmostDialog, hostOverlayLayer, bindSheetGestures };

/** @type {WeakMap<HTMLDialogElement, { pushPage: (spec: object) => object }>} */
const frames = new WeakMap();
let nextId = 0;

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function uid(prefix) {
    return `${prefix}-${++nextId}`;
}

function icon(glyph) {
    const node = element('i', `fa-solid fa-${glyph}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

export function createIconButton(label, glyph, className = '') {
    const node = element('button', `sb-dialog__icon-button ${className}`);
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(icon(glyph));
    return node;
}

function responseButton({ id, label, appearance = null, enabled = true }) {
    const node = element('button', 'menu_button sb-dialog__response', label);
    node.type = 'button';
    node.dataset.response = id;
    if (appearance === 'suggested') node.classList.add('is-suggested', 'menu_button_primary');
    if (appearance === 'destructive') node.classList.add('is-destructive');
    node.disabled = !enabled;
    return node;
}

function isVisible(node) {
    return node instanceof HTMLElement && node.getClientRects().length > 0;
}

function firstFocusable(root) {
    const all = [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(node => !node.closest('[hidden], [inert]'));
    return all.find(isVisible) ?? all[0] ?? null;
}

/** Keep titles centred when they fit, then let unequal header controls provide the spare space. */
export function bindHeaderLayout(header) {
    const sideSelector = ':scope > .sb-dialog__header-start, :scope > .sb-dialog__header-end, :scope > .popup-controls > :is(.popup-button-ok, .popup-button-cancel), :scope > .popup-button-close';
    const titles = header.querySelector(':scope > .sb-dialog__titles');
    const title = titles?.querySelector(':scope > .sb-dialog__title');
    const measuredWidth = node => node ? node.offsetWidth || [...node.children].reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) : 0;
    const keepCloseLast = () => {
        const end = header.querySelector(':scope > .sb-dialog__header-end');
        const close = end?.querySelector(':scope > .popup-button-close, :scope > .sb-dialog__close');
        if (close && end.lastElementChild !== close) end.append(close);
    };
    const sync = () => {
        keepCloseLast();
        const sides = [...header.querySelectorAll(sideSelector)];
        const width = Math.max(0, ...sides.map(measuredWidth));
        header.style.setProperty('--sb-dialog-header-side', `${width}px`);
        if (!titles || !title) return;
        const start = measuredWidth(header.querySelector(':scope > .sb-dialog__header-start'));
        const end = measuredWidth(header.querySelector(':scope > .sb-dialog__header-end'));
        const controls = measuredWidth(header.querySelector(':scope > .popup-controls'));
        const trailing = Math.max(end, controls);
        const style = getComputedStyle(header);
        const padding = (parseFloat(style.paddingInlineStart) || 0) + (parseFloat(style.paddingInlineEnd) || 0);
        const available = Math.max(0, header.clientWidth - padding - 12);
        const titleWidth = title.scrollWidth;
        const centeredCapacity = Math.max(0, available - (width * 2));
        const looseCapacity = Math.max(0, available - start - trailing);
        const needsLooseCentering = titleWidth > centeredCapacity + 1 && titleWidth <= looseCapacity + 1;
        header.toggleAttribute('data-header-centering-loose', needsLooseCentering);
    };
    sync();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    resizeObserver?.observe(header);
    header.querySelectorAll(sideSelector).forEach(node => resizeObserver?.observe(node));
    if (titles) resizeObserver?.observe(titles);
    if (title) resizeObserver?.observe(title);
    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(sync);
    mutationObserver?.observe(header, { childList: true, subtree: true });
    return () => {
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
    };
}

function appendContent(target, content) {
    if (typeof content === 'function') content(target);
    else if (content instanceof Node) target.append(content);
}

function settle(result, onResolved) {
    return typeof result?.then === 'function' ? Promise.resolve(result).then(onResolved) : onResolved(result);
}

/**
 * Keeps a frame above the on-screen keyboard: writes the covered height to
 * `--sb-dialog-keyboard-inset` on `host` and keeps the focused field visible.
 * Exported for popup-frame.js and tests.
 * @param {HTMLElement} host
 * @returns {() => void}
 */
export function bindKeyboardInset(host, { onInsetChange = null } = {}) {
    const viewport = window.visualViewport;
    let frame = 0;
    let previousInset = null;
    function sync() {
        frame = 0;
        const inset = viewport ? Math.max(0, Math.round(window.innerHeight - viewport.offsetTop - viewport.height)) : 0;
        host.style.setProperty('--sb-dialog-keyboard-inset', `${inset}px`);
        if (inset !== previousInset) onInsetChange?.(inset);
        previousInset = inset;
        const focused = document.activeElement;
        if (inset > 0 && focused instanceof HTMLElement && host.contains(focused) && focused.matches('input, textarea, select, [contenteditable]')) {
            focused.scrollIntoView?.({ block: 'nearest' });
        }
    }
    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(sync);
    };
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    host.addEventListener('focusin', schedule);
    sync();
    return () => {
        if (frame) cancelAnimationFrame(frame);
        viewport?.removeEventListener('resize', schedule);
        viewport?.removeEventListener('scroll', schedule);
        host.removeEventListener('focusin', schedule);
        host.style.removeProperty('--sb-dialog-keyboard-inset');
    };
}

/** Keeps a content-sized Window at its largest laid-out height until it closes. */
export function bindWindowHeightLock(surface, { isFill = () => false } = {}) {
    let minimumHeight = null;
    let frame = 0;

    function keyboardInset() {
        const value = Number.parseFloat(
            surface.style.getPropertyValue('--sb-dialog-keyboard-inset')
            || surface.parentElement?.style.getPropertyValue('--sb-dialog-keyboard-inset'),
        );
        return Number.isFinite(value) ? value : 0;
    }

    function availableHeight() {
        const maxHeight = getComputedStyle(surface).maxHeight.trim();
        if (maxHeight.endsWith('px')) {
            const value = Number.parseFloat(maxHeight);
            if (Number.isFinite(value)) return value;
        }
        const parent = surface.parentElement;
        if (!parent || parent === document.body) return Number.POSITIVE_INFINITY;
        const style = getComputedStyle(parent);
        return Math.max(0, parent.getBoundingClientRect().height
            - (Number.parseFloat(style.paddingBlockStart) || 0)
            - (Number.parseFloat(style.paddingBlockEnd) || 0));
    }

    function sync() {
        frame = 0;
        if (!surface.isConnected) return;
        if (isFill()) {
            surface.style.removeProperty('min-height');
            return;
        }

        const height = surface.offsetHeight;
        if (minimumHeight === null) {
            if (height <= 0) return;
            minimumHeight = height;
        } else if (!keyboardInset() && height > minimumHeight) {
            minimumHeight = height;
        }

        surface.style.setProperty('min-height', `${Math.ceil(Math.min(minimumHeight, availableHeight()))}px`);
    }

    function schedule() {
        if (frame) return;
        if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(sync);
        else sync();
    }

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(surface);
    sync();
    schedule();

    return {
        refresh: schedule,
        destroy() {
            if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
            resizeObserver?.disconnect();
            surface.style.removeProperty('min-height');
        },
    };
}

/**
 * The transparent full-viewport modal host with a scrim, shared by alerts, dialogs and windows.
 * Exported for tests and popup-frame.js; feature code uses openDialog/openAlert.
 * @param {object} options
 * @param {'alert'|'dialog'|'window'} options.tier
 * @param {string} [options.className]
 * @param {'content'|'fill'} [options.size='fill']
 * @param {boolean} [options.page=false] Presents the surface as a page over a framed Popup: it never
 *     becomes a sheet, and the host backdrop carries the dim instead of the scrim.
 */
export function createDialogFrame({ tier, className = '', size = 'fill', page = false }) {
    const host = /** @type {HTMLDialogElement} */ (element('dialog', 'sb-dialog-host'));
    host.setAttribute(MODAL_ATTRIBUTE, '');
    host.dataset.tier = tier;
    const scrim = element('div', 'sb-dialog-scrim');
    scrim.setAttribute('aria-hidden', 'true');
    scrim.hidden = page;
    const surface = element('section', `sb-dialog sb-dialog--${tier}`);
    if (page) {
        host.classList.add('sb-dialog-host--page');
        surface.classList.add('sb-dialog--page');
    }
    if (className) surface.classList.add(...className.split(/\s+/).filter(Boolean));
    if (tier === 'window' && size === 'fill') surface.classList.add('sb-dialog--fill');
    const handle = element('div', 'sb-dialog__handle');
    handle.setAttribute('aria-hidden', 'true');
    surface.append(handle);
    host.append(scrim, surface);
    blockUpstreamDrawerClose(host);
    const query = window.matchMedia?.(OVERLAY_SHEET_QUERY) ?? { matches: false, addEventListener() {}, removeEventListener() {} };
    const isSheet = () => query.matches && !page;
    const syncPresentation = () => {
        host.dataset.presentation = isSheet() ? 'sheet' : 'floating';
    };
    syncPresentation();
    return { host, scrim, surface, handle, query, isSheet, syncPresentation, page };
}

function openMotion(frame) {
    const { surface, scrim, isSheet, host, page } = frame;
    if (page) {
        animateIn(surface, [{ transform: 'translateX(100%)' }, { transform: 'none' }], SPRING_NAVIGATION);
        return;
    }
    animateIn(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
    if (isSheet()) {
        animateIn(surface, [{ transform: 'translateY(100%)' }, { transform: 'none' }], SPRING_SHEET);
    } else if (host.dataset.tier === 'window') {
        animateIn(surface, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], SPRING_SHEET);
    } else {
        animateIn(surface, [{ opacity: 0, transform: 'scale(0.8)' }, { opacity: 1, transform: 'none' }], SPRING_DIALOG);
    }
}

function closeMotion(frame, offset, done) {
    const { surface, scrim, isSheet, host, page } = frame;
    const from = surface.style.transform || (offset > 0 ? `translateY(${offset}px)` : 'none');
    surface.style.removeProperty('transform');
    scrim.style.removeProperty('opacity');
    const options = { duration: MOTION_FAST, easing: MOTION_EASE_OUT_CUBIC, fill: 'forwards' };
    if (!page) play(scrim, [{ opacity: 1 }, { opacity: 0 }], options);
    let keyframes;
    // A page over a sheet leaves downward after a swipe, and sideways after Back.
    if (page && surface.hasAttribute('data-covers-sheet') && offset > 0) keyframes = [{ transform: from }, { transform: 'translateY(100%)' }];
    else if (page) keyframes = [{ transform: 'none' }, { transform: 'translateX(100%)' }];
    else if (isSheet()) keyframes = [{ transform: from }, { transform: 'translateY(100%)' }];
    else if (host.dataset.tier === 'window') keyframes = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.98)' }];
    else keyframes = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.9)' }];
    play(surface, keyframes, { ...options, inert: true, onEnd: done });
}

function wrapTab(host, event) {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const focusable = [...host.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter(node => !node.closest('[hidden], [inert]') && isVisible(node));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

/**
 * Builds one page: header bar, optional search row, scrolling body and optional bottom bar.
 * @returns {object}
 */
function createPage({ title, subtitle = '', content = null, search = null, menu = null, menuLabel = t`Menu`, responses = null, className = '', nested = false, onResponse, onBack }) {
    const page = element('section', 'sb-dialog__page');
    if (className) page.classList.add(...className.split(/\s+/).filter(Boolean));
    const header = element('header', 'sb-dialog__header');
    const start = element('div', 'sb-dialog__header-start');
    const titles = element('div', 'sb-dialog__titles');
    const titleNode = element('h2', 'sb-dialog__title', title);
    titleNode.id = uid('sb-dialog-title');
    const subtitleNode = element('span', 'sb-dialog__subtitle', subtitle);
    subtitleNode.hidden = !subtitle;
    titles.append(titleNode, subtitleNode);
    const end = element('div', 'sb-dialog__header-end');
    header.append(start, titles, end);
    page.append(header);

    const buttons = new Map();
    let menuButton = null;
    let closeButton = null;
    if (responses) {
        const cancel = responseButton({ id: 'cancel', label: responses.cancel?.label ?? t`Cancel` });
        cancel.classList.add('sb-dialog__cancel');
        cancel.addEventListener('click', () => onResponse('cancel', 'cancel'));
        start.append(cancel);
        buttons.set('cancel', cancel);
        const affirmative = responses.affirmative;
        if (affirmative) {
            const id = affirmative.id ?? 'affirmative';
            const node = responseButton({ ...affirmative, id, appearance: affirmative.appearance ?? 'suggested' });
            node.classList.add('sb-dialog__affirmative');
            node.addEventListener('click', () => onResponse('affirmative', id));
            end.append(node);
            buttons.set(id, node);
        }
    } else if (nested) {
        const back = createIconButton(t`Back`, 'arrow-left', 'sb-dialog__back');
        back.addEventListener('click', () => onBack());
        start.append(back);
    }
    if (menu) {
        menuButton = createIconButton(menuLabel, 'ellipsis-vertical', 'sb-dialog__menu');
        menuButton.setAttribute('aria-haspopup', 'menu');
        menuButton.setAttribute('aria-expanded', 'false');
        end.prepend(menuButton);
    }
    if (!responses) {
        closeButton = createIconButton(t`Close`, 'xmark', 'sb-dialog__close');
        closeButton.addEventListener('click', () => onResponse('close', 'close'));
        end.append(closeButton);
    }

    let searchControl = null;
    let searchInput = null;
    let searchToggle = null;
    let restoreAdoptedInput = null;
    let searchKeydownHandler = null;
    const status = element('div', 'sb-dialog__status');
    status.setAttribute('aria-live', 'polite');
    const body = element('div', 'sb-dialog__body');
    const syncHeaderShade = () => header.toggleAttribute('data-scrolled', body.scrollTop > 0);
    body.addEventListener('scroll', syncHeaderShade, { passive: true });
    if (search) {
        searchToggle = createIconButton(t`Search`, 'magnifying-glass', 'sb-dialog__search-toggle');
        const field = element('label', 'sb-dialog__search');
        field.hidden = Boolean(search.collapsed);
        const entry = element('span', 'sb-dialog__search-entry');
        const adoptedInput = search.input instanceof HTMLInputElement;
        if (adoptedInput) {
            const originalParent = search.input.parentNode;
            const originalNextSibling = search.input.nextSibling;
            const originalAttributes = new Set([...search.input.attributes].map(attribute => attribute.name));
            const addedClasses = ['text_pole', 'sb-dialog__entry', 'sb-dialog__search-input']
                .filter(className => !search.input.classList.contains(className));
            restoreAdoptedInput = () => {
                search.input.classList.remove(...addedClasses);
                for (const attribute of [...search.input.attributes]) {
                    if (!originalAttributes.has(attribute.name)) search.input.removeAttribute(attribute.name);
                }
                if (originalParent) {
                    originalParent.insertBefore(
                        search.input,
                        originalNextSibling?.parentNode === originalParent ? originalNextSibling : null,
                    );
                } else search.input.remove();
            };
        }
        searchInput = adoptedInput
            ? search.input
            : /** @type {HTMLInputElement} */ (element('input', 'text_pole sb-dialog__entry sb-dialog__search-input'));
        searchInput.classList.add('text_pole', 'sb-dialog__entry', 'sb-dialog__search-input');
        if (!searchInput.hasAttribute('type')) searchInput.type = 'search';
        if (!searchInput.hasAttribute('role')) searchInput.setAttribute('role', 'searchbox');
        if (!searchInput.hasAttribute('placeholder')) searchInput.placeholder = search.placeholder ?? t`Search`;
        if (!searchInput.hasAttribute('aria-label') && !searchInput.hasAttribute('aria-labelledby')) {
            searchInput.setAttribute('aria-label', search.label ?? t`Search`);
        }
        if (!searchInput.hasAttribute('aria-autocomplete') && search.ariaAutocomplete) searchInput.setAttribute('aria-autocomplete', search.ariaAutocomplete);
        if (!searchInput.hasAttribute('aria-controls') && search.ariaControls) searchInput.setAttribute('aria-controls', search.ariaControls);
        if (!searchInput.hasAttribute('enterkeyhint') && search.enterKeyHint) searchInput.enterKeyHint = search.enterKeyHint;
        field.id = uid('sb-dialog-search');
        entry.append(icon('magnifying-glass'), searchInput);
        field.append(entry);
        page.append(field);
        (start.childElementCount ? end : start).append(searchToggle);
        searchKeydownHandler = event => {
            if (event.key !== 'Escape' || event.isComposing) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (search.onEscape?.(event)) return;
            if (search.escapeClearsFirst && searchInput.value) searchControl.clear();
            else {
                searchControl.close();
                if (nested) onBack?.('escape');
            }
        };
        searchInput.addEventListener('keydown', searchKeydownHandler, true);
        searchControl = createListSearch({
            field, input: searchInput, trigger: searchToggle, scope: page, scroller: body, status,
            typeToSearchSelector: search.typeToSearchSelector,
            escapeClearsFirst: Boolean(search.escapeClearsFirst),
            debounce: search.debounce ?? 0, onChange: query => search.onChange?.(query),
        });
        searchToggle.addEventListener('click', () => searchControl.toggle());
    }
    appendContent(body, content);
    page.append(body);

    let bottomBar = null;
    if (responses?.extra?.length) {
        bottomBar = element('div', 'sb-dialog__bottom-bar');
        for (const extra of responses.extra) {
            const node = responseButton(extra);
            node.addEventListener('click', () => onResponse(extra.id, extra.id));
            bottomBar.append(node);
            buttons.set(extra.id, node);
        }
        page.append(bottomBar);
    }
    page.append(status);
    const unbindHeaderLayout = bindHeaderLayout(header);

    return {
        page, header, titleNode, body, bottomBar, status, buttons, menuButton, closeButton, searchToggle,
        search: searchControl, searchInput,
        setTitle(text) { titleNode.textContent = text; },
        setSubtitle(text) {
            subtitleNode.textContent = text;
            subtitleNode.hidden = !text;
        },
        setResponseEnabled(id, enabled) {
            const node = buttons.get(id);
            if (node) node.disabled = !enabled;
        },
        destroy() {
            body.removeEventListener('scroll', syncHeaderShade);
            unbindHeaderLayout();
            searchControl?.destroy();
            if (searchKeydownHandler) searchInput?.removeEventListener('keydown', searchKeydownHandler, true);
            restoreAdoptedInput?.();
        },
    };
}

/**
 * Opens a Dialog- or Window-tier frame. When another frame is active, this frame becomes a page in it.
 * Over a framed Popup Dialog or Window it is a page over that Popup, with Back, and with Close when it
 * has no responses. Close closes the whole chain, one level at a time, and stops at a level that refuses.
 *
 * @param {object} o
 * @param {'dialog'|'window'} [o.tier='dialog']
 * @param {string} o.title
 * @param {string} [o.subtitle]
 * @param {HTMLElement|((body: HTMLElement) => void)} [o.content]
 * @param {{ placeholder?: string, label?: string, debounce?: number, input?: HTMLInputElement, ariaAutocomplete?: string, ariaControls?: string, enterKeyHint?: string, escapeClearsFirst?: boolean, onEscape?: (event: KeyboardEvent) => boolean, onChange: (query: string) => void }|null} [o.search]
 * @param {((trigger: HTMLElement) => object[])|null} [o.menu] Sections for openActionMenu.
 * @param {string} [o.menuLabel]
 * @param {null|{ cancel?: { label?: string }, affirmative?: { id?: string, label: string, appearance?: 'suggested'|'destructive', enabled?: boolean }, extra?: { id: string, label: string }[] }} [o.responses]
 *     null means immediate apply: the header shows Close.
 * @param {(reason: string) => boolean|Promise<boolean>} [o.canClose] Reasons: 'close', 'cancel', 'affirmative',
 *     'escape', 'scrim', 'swipe', 'back', 'programmatic', or an extra response id.
 * @param {() => HTMLElement|null} [o.initialFocus]
 * @param {string} [o.className] Added to the surface or, when pushed, to the page.
 * @param {'content'|'fill'} [o.size='fill'] Whether the Window body fills the frame.
 */
export function openDialog({
    tier = 'dialog', title, subtitle = '', content = null, search = null, menu = null, menuLabel,
    responses = null, canClose = null, initialFocus = null, className = '', size = 'fill',
}) {
    const parentHost = getTopmostDialog();
    const parent = parentHost ? frames.get(/** @type {HTMLDialogElement} */ (parentHost)) : null;
    if (parent) return parent.pushPage({ title, subtitle, content, search, menu, menuLabel, responses, canClose, initialFocus, className, size });

    // A framed Popup is not an openDialog host, so it is covered here instead of through `frames`.
    const coveredSurface = findCoveredSurface();
    const isPage = Boolean(coveredSurface);
    const frame = createDialogFrame({ tier: tier === 'window' ? 'window' : 'dialog', className, size, page: isPage });
    const { host, scrim, surface, query, isSheet, syncPresentation } = frame;
    const pagesNode = element('div', 'sb-dialog__pages');
    surface.append(pagesNode);
    const returnFocus = document.activeElement;
    const closeResponse = responses ? 'cancel' : 'close';
    // Back, Escape and programmatic closes of a page return to the covered surface, as a pushed page does.
    const dismissResponse = isPage ? (responses ? 'cancel' : 'back') : closeResponse;
    /** @type {'open'|'closing'|'closed'} */
    let state = 'open';
    let pending = false;
    /** The async canClose check that runs now, so that a chain Close does not start a second one. */
    let attemptRun = null;
    let heightLock = null;
    let finish;
    const closed = new Promise(resolve => finish = resolve);
    /** @type {ReturnType<typeof coverSurface>|null} */
    let cover = null;
    /** @type {import('./page-chain.js').ChainLevel} */
    const level = registerChainLevel({ surface, close: closeLevel, covered: coveredSurface, pending: pendingClose });
    /** @type {{ view: ReturnType<typeof createPage>, spec: object, resolve: Function }[]} */
    const stack = [];

    function topPage() {
        return stack.at(-1);
    }

    function openMenu(trigger, sections, label) {
        openActionMenu({ trigger, title: label, sections, bounds: surface });
    }

    function attempt(reason, response, offset = 0) {
        if (state !== 'open' || pending) return false;
        const approved = canClose ? canClose(reason) : true;
        if (typeof approved?.then === 'function') {
            pending = true;
            const run = Promise.resolve(approved).then(ok => {
                pending = false;
                if (ok === false || state !== 'open') return false;
                complete(response, offset);
                return true;
            }, error => {
                pending = false;
                throw error;
            });
            attemptRun = run;
            const clear = () => { if (attemptRun === run) attemptRun = null; };
            run.then(clear, clear);
            return run;
        }
        if (approved === false) return false;
        complete(response, offset);
        return true;
    }

    function complete(response, offset = 0) {
        if (state !== 'open') return;
        state = 'closing';
        closeActionMenu({ animate: false });
        closePicker({ animate: false, restoreFocus: false });
        releaseOverlayLayers(host);
        host.setAttribute('closing', '');
        closeMotion(frame, offset, () => dispose(response));
    }

    /** The close that this host runs now, as a close outcome, or null. */
    function pendingClose() {
        if (!attemptRun) return null;
        return attemptRun.then(async () => {
            if (state === 'open') return false;
            await closed;
            return true;
        });
    }

    /** Closes this level only, for a chain walk. Resolves once the level is gone. */
    async function closeLevel() {
        const running = pendingClose();
        if (running) return running;
        if (state !== 'open') {
            await closed;
            return true;
        }
        if (!(await attempt('close', closeResponse))) return false;
        await closed;
        return true;
    }

    function dispose(response) {
        if (state === 'closed') return;
        state = 'closed';
        query.removeEventListener('change', layoutChanged);
        unbindGestures();
        unbindKeyboard();
        heightLock?.destroy();
        for (const entry of stack.splice(0)) {
            entry.view.destroy();
            entry.resolve({ response });
        }
        frames.delete(host);
        releaseOverlayLayers(host);
        if (host.open) host.close();
        host.remove();
        // Pages over this frame that stay open must find it removed when they take over its dim.
        unregisterChainLevel(level);
        // The covered surface must be interactive again before focus returns into it.
        cover?.release();
        if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
        finish({ response });
    }

    function popPage(response, reason = response) {
        const entry = topPage();
        if (!entry || stack.length < 2 || state !== 'open') return false;
        const approved = entry.spec.canClose ? entry.spec.canClose(reason) : true;
        return settle(approved, ok => {
            if (ok === false || topPage() !== entry) return false;
            stack.pop();
            const previous = topPage();
            stopMotion(entry.view.page);
            previous.view.page.classList.remove('is-underlay');
            previous.view.page.hidden = false;
            previous.view.page.inert = false;
            host.setAttribute('aria-labelledby', previous.view.titleNode.id);
            const leaving = entry.view.page;
            leaving.inert = true;
            leaving.classList.add('is-leaving');
            const remove = () => {
                entry.view.destroy();
                leaving.remove();
            };
            if (prefersReducedMotion()) remove();
            else play(leaving, [{ transform: 'none' }, { transform: 'translateX(100%)' }], { ...SPRING_NAVIGATION, fill: 'forwards', onEnd: remove });
            (entry.returnFocus?.isConnected ? entry.returnFocus : firstFocusable(previous.view.page))?.focus({ preventScroll: true });
            heightLock?.refresh();
            entry.resolve({ response });
            return true;
        });
    }

    function mountPage(spec, nested) {
        const view = createPage({
            ...spec,
            // The root page of a page host also has Back, because it returns to the covered surface.
            nested: nested || isPage,
            onResponse: (kind, id) => {
                if (kind === 'close') return closeChain(level);
                if (nested) return popPage(id, kind === 'affirmative' ? 'affirmative' : id);
                return attempt(kind === 'affirmative' ? 'affirmative' : id, id);
            },
            onBack: reason => {
                if (nested) return popPage(spec.responses ? 'cancel' : 'back', reason ?? 'back');
                if (isPage) return attempt(reason ?? 'back', dismissResponse);
                if (reason === 'escape') return attempt('escape', closeResponse);
                return false;
            },
        });
        if (view.menuButton) {
            view.menuButton.addEventListener('click', () => openMenu(view.menuButton, spec.menu(view.menuButton), spec.menuLabel ?? spec.title));
        }
        let resolve;
        const pageClosed = new Promise(done => resolve = done);
        const entry = { view, spec, resolve, returnFocus: nested ? document.activeElement : null };
        const previous = topPage();
        stack.push(entry);
        pagesNode.append(view.page);
        heightLock?.refresh();
        host.setAttribute('aria-labelledby', view.titleNode.id);
        if (previous) {
            previous.view.page.inert = true;
            previous.view.page.classList.add('is-underlay');
            const hidePrevious = () => {
                if (topPage() === previous) return;
                previous.view.page.hidden = true;
                previous.view.page.classList.remove('is-underlay');
            };
            if (prefersReducedMotion()) hidePrevious();
            else play(view.page, [{ transform: 'translateX(100%)' }, { transform: 'none' }], { ...SPRING_NAVIGATION, onEnd: hidePrevious });
            (spec.initialFocus?.() ?? (view.search?.isOpen ? view.searchInput : view.searchToggle) ?? firstFocusable(view.body) ?? firstFocusable(view.header))?.focus({ preventScroll: true });
        }
        return { entry, pageClosed };
    }

    function handleFor(view) {
        return {
            header: view.header,
            headerStart: view.header.querySelector(':scope > .sb-dialog__header-start'),
            headerEnd: view.header.querySelector(':scope > .sb-dialog__header-end'),
            titles: view.header.querySelector(':scope > .sb-dialog__titles'),
            titleNode: view.titleNode,
            menuButton: view.menuButton,
            closeButton: view.closeButton,
            body: view.body,
            search: view.search,
            searchInput: view.searchInput,
            searchToggle: view.searchToggle,
            setTitle: view.setTitle,
            setSubtitle: view.setSubtitle,
            setResponseEnabled: view.setResponseEnabled,
        };
    }

    function pushPage(spec) {
        const { entry, pageClosed } = mountPage(spec, true);
        return {
            root: host,
            surface,
            page: entry.view.page,
            ...handleFor(entry.view),
            closed: pageClosed,
            close: (response = spec.responses ? 'cancel' : 'back') => (topPage() === entry ? popPage(response, 'programmatic') : false),
            pop: (response = spec.responses ? 'cancel' : 'back') => (topPage() === entry ? popPage(response, 'programmatic') : false),
            forceClose: () => {
                if (topPage() !== entry) return;
                const original = entry.spec.canClose;
                entry.spec.canClose = null;
                popPage(spec.responses ? 'cancel' : 'back', 'programmatic');
                entry.spec.canClose = original;
            },
            push: pushPage,
        };
    }

    const { entry: rootEntry } = mountPage({ title, subtitle, content, search, menu, menuLabel, responses, initialFocus }, false);
    const root = rootEntry.view;
    frames.set(host, { pushPage });

    function requestDismiss(reason, offset = 0) {
        if (stack.length > 1) return popPage(topPage().spec.responses ? 'cancel' : 'back', reason);
        return attempt(reason, dismissResponse, offset);
    }

    scrim.addEventListener('click', () => {
        if (!isSheet() && !isPage) void requestDismiss('scrim');
    });
    host.addEventListener('cancel', event => {
        event.preventDefault();
        const view = topPage()?.view;
        if (view?.search?.isOpen) {
            view.search.close();
            return;
        }
        void requestDismiss('escape');
    });
    host.addEventListener('close', () => {
        // Some engines close a modal without a cancel event (repeated Escape); keep it open and ask instead.
        if (state !== 'open') return;
        host.showModal();
        void requestDismiss('escape');
    });
    host.addEventListener('keydown', event => wrapTab(host, event));

    const unbindGestures = bindSheetGestures({
        surface, scrim, targets: [surface], startSelector: '.sb-dialog__handle, .sb-dialog__header',
        // A page over a sheet keeps the sheet's grab handle, and a swipe goes back one level like Escape.
        isActive: () => isSheet() || surface.hasAttribute('data-covers-sheet'),
        requestClose: offset => requestDismiss('swipe', offset),
    });
    const unbindKeyboard = bindKeyboardInset(host, { onInsetChange: () => heightLock?.refresh() });

    function layoutChanged() {
        if (state !== 'open') return;
        stopMotion(surface);
        stopMotion(scrim);
        surface.style.removeProperty('transform');
        scrim.style.removeProperty('opacity');
        syncPresentation();
        heightLock?.refresh();
    }
    query.addEventListener('change', layoutChanged);

    if (isPage) {
        cover = coverSurface(coveredSurface, surface);
        level.onOrphan = cover.standalone;
    }
    document.body.append(host);
    host.showModal();
    // A page takes its rectangle from the covered surface, so a measured height lock would fight it.
    if (host.dataset.tier === 'window' && !isPage) {
        heightLock = bindWindowHeightLock(surface, { isFill: () => surface.classList.contains('sb-dialog--fill') });
    }
    openMotion(frame);
    (initialFocus?.() ?? (root.search?.isOpen ? root.searchInput : root.searchToggle) ?? firstFocusable(root.body) ?? root.buttons.get('cancel') ?? root.closeButton)?.focus({ preventScroll: true });

    return {
        root: host,
        surface,
        page: root.page,
        ...handleFor(root),
        closed,
        close: (response = dismissResponse, reason = 'programmatic') => attempt(reason, response),
        forceClose: () => complete(dismissResponse),
        push: pushPage,
        get isOpen() { return state === 'open'; },
    };
}

/**
 * Mirrors AdwAlertDialog. Resolves with the activated response id, or `closeResponse` on
 * Escape, scrim or swipe. Responses are listed Cancel first; the destructive or suggested one last.
 * @param {object} o
 * @param {string} o.heading
 * @param {string} [o.body]
 * @param {Node|null} [o.bodyNode] Rich body content, used instead of `body`.
 * @param {Node|null} [o.extra] Extra child below the body (for example one switch row).
 * @param {{ id: string, label: string, appearance?: 'suggested'|'destructive', enabled?: boolean }[]} o.responses
 * @param {string|null} [o.defaultResponse] Activated by Return; leave null for destructive alerts.
 * @param {string} [o.closeResponse='cancel']
 * @param {boolean} [o.preferWide=false]
 * @returns {Promise<string>}
 */
export function openAlert({ heading, body = '', bodyNode = null, extra = null, responses, defaultResponse = null, closeResponse = 'cancel', preferWide = false }) {
    const frame = createDialogFrame({ tier: 'alert' });
    const { host, scrim, surface, query, isSheet, syncPresentation } = frame;
    host.setAttribute('role', 'alertdialog');
    if (preferWide) surface.classList.add('sb-dialog--wide');
    const content = element('div', 'sb-dialog__body');
    const headingNode = element('h2', 'sb-dialog__heading', heading);
    headingNode.id = uid('sb-alert-heading');
    host.setAttribute('aria-labelledby', headingNode.id);
    content.append(headingNode);
    const description = element('div', 'sb-dialog__message');
    description.id = uid('sb-alert-body');
    if (bodyNode instanceof Node) description.append(bodyNode);
    else description.textContent = body;
    if (description.childNodes.length) {
        content.append(description);
        host.setAttribute('aria-describedby', description.id);
    }
    if (extra instanceof Node) {
        const holder = element('div', 'sb-dialog__extra');
        holder.append(extra);
        content.append(holder);
    }
    const responsesNode = element('div', 'sb-dialog__responses');
    const buttons = new Map();
    for (const response of responses) {
        const node = responseButton(response);
        node.addEventListener('click', () => complete(response.id));
        responsesNode.append(node);
        buttons.set(response.id, node);
    }
    surface.append(content, responsesNode);
    const returnFocus = document.activeElement;
    let state = 'open';
    let finish;
    const result = new Promise(resolve => finish = resolve);

    // AdwAlertDialog lays responses out side by side at equal widths when the widest fits that
    // share, and stacks them otherwise. Sheets always stack.
    function layoutResponses() {
        responsesNode.classList.remove('is-stacked');
        if (isSheet()) {
            responsesNode.classList.add('is-stacked');
            return;
        }
        responsesNode.classList.add('is-measuring');
        const nodes = [...buttons.values()];
        const widest = Math.max(0, ...nodes.map(node => node.getBoundingClientRect().width));
        const style = getComputedStyle(responsesNode);
        const gap = parseFloat(style.columnGap) || 0;
        const available = responsesNode.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
        responsesNode.classList.remove('is-measuring');
        if (widest * nodes.length + gap * (nodes.length - 1) > available + 1) responsesNode.classList.add('is-stacked');
    }

    function complete(response, offset = 0) {
        if (state !== 'open') return;
        state = 'closing';
        releaseOverlayLayers(host);
        host.setAttribute('closing', '');
        closeMotion(frame, offset, () => {
            state = 'closed';
            query.removeEventListener('change', layoutChanged);
            window.removeEventListener('resize', layoutResponses);
            unbindGestures();
            unbindKeyboard();
            if (host.open) host.close();
            host.remove();
            if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
            finish(response);
        });
    }

    scrim.addEventListener('click', () => {
        if (!isSheet()) complete(closeResponse);
    });
    host.addEventListener('cancel', event => {
        event.preventDefault();
        complete(closeResponse);
    });
    host.addEventListener('close', () => complete(closeResponse));
    host.addEventListener('keydown', event => {
        wrapTab(host, event);
        if (event.key !== 'Enter' || event.isComposing || !defaultResponse) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('button, textarea, select, a[href]')) return;
        const node = buttons.get(defaultResponse);
        if (node && !node.disabled) {
            event.preventDefault();
            node.click();
        }
    });
    const unbindGestures = bindSheetGestures({
        surface, scrim, targets: [surface], startSelector: '.sb-dialog__handle, .sb-dialog__heading', isActive: isSheet,
        requestClose: offset => {
            complete(closeResponse, offset);
            return true;
        },
    });
    const unbindKeyboard = bindKeyboardInset(host);
    function layoutChanged() {
        if (state !== 'open') return;
        syncPresentation();
        layoutResponses();
    }
    query.addEventListener('change', layoutChanged);
    window.addEventListener('resize', layoutResponses, { passive: true });

    document.body.append(host);
    host.showModal();
    layoutResponses();
    openMotion(frame);
    const focusTarget = buttons.get(defaultResponse) ?? buttons.get(closeResponse) ?? firstFocusable(content) ?? responsesNode.querySelector('button');
    focusTarget?.focus({ preventScroll: true });
    return result;
}
