import { play, stopMotion, animateOut, MOTION_SLOW, prefersReducedMotion } from '../sillybunny-motion.js';
import { t } from '../i18n.js';

/**
 * GNOME search bar for List→Editor sidebars: a revealable field under the list header,
 * live filtering, Ctrl/Cmd+F, type-to-search, result-count announcements and scroll restore.
 *
 * The consumer supplies the field markup (so existing classes and IDs stay stable) and does
 * its own filtering in `onChange` and must call `report()` after each completed render.
 *
 * @param {object} options
 * @param {HTMLElement} options.field        Wrapper revealed/hidden by `toggle()`.
 * @param {HTMLInputElement} options.input
 * @param {HTMLElement} [options.trigger]    Header toggle button; gets aria-expanded/aria-controls.
 * @param {HTMLElement} [options.scope]      Ctrl/Cmd+F and type-to-search apply while focus is inside it.
 * @param {HTMLElement} [options.scroller]   Scroll position is restored when a search is cleared.
 * @param {HTMLElement} [options.status]     Polite live region for result announcements.
 * @param {(query: string) => void} options.onChange
 * @param {number} [options.debounce=0]      Milliseconds; 0 filters synchronously on every input.
 * @param {string} [options.heightProperty]  Custom property holding the revealed field height in px; omitted, the shown field is measured.
 * @param {boolean} [options.shortcuts=true] Enables Ctrl/Cmd+F and type-to-search inside `scope`.
 * @param {boolean} [options.escapeClearsFirst=false] Keeps an open search visible for one Escape after clearing its query.
 * @param {string} [options.typeToSearchSelector='[data-sb-list-key]'] Focus target filter for type-to-search.
 * @param {boolean} [options.closeEmptyOnBlur=false] Closes the open field when the input loses focus to something outside it
 *   while the query is empty (a field that also holds a filter button keeps the focus inside). A close that a pointer press
 *   caused waits for the click to finish, so the list does not move under the pointer.
 * @returns {{ toggle: (show?: boolean) => void, open: (options?: { focus?: boolean, animate?: boolean }) => void,
 *   close: (options?: { focus?: boolean, animate?: boolean }) => void, clear: () => void,
 *   setQuery: (value: string, options?: { notify?: boolean }) => void, report: (shown: number, total: number) => void,
 *   readonly query: string, readonly isOpen: boolean, destroy: () => void }}
 */
export function createListSearch({
    field,
    input,
    trigger = null,
    scope = null,
    scroller = null,
    status = null,
    onChange,
    debounce = 0,
    heightProperty = '',
    shortcuts = true,
    escapeClearsFirst = false,
    typeToSearchSelector = '[data-sb-list-key]',
    closeEmptyOnBlur = false,
}) {
    let query = input.value ?? '';
    let timer = 0;
    let savedScroll = null;
    let lastReport = '';
    let destroyed = false;
    let pointerActive = false;
    let pointerInside = false;
    let pendingBlur = null;
    let blurFrame = 0;

    if (!input.id) input.id = `sb-list-search-${Math.random().toString(36).slice(2, 9)}`;
    if (trigger) {
        trigger.setAttribute('aria-controls', field.id || (field.id = `${input.id}-field`));
        trigger.setAttribute('aria-expanded', String(!field.hidden));
    }
    field.setAttribute('aria-hidden', String(Boolean(field.hidden)));
    field.inert = Boolean(field.hidden);
    field.dataset.state = field.hidden ? 'closed' : 'open';

    function emit(next) {
        if (next === query) return;
        if (!query && next && scroller) savedScroll = scroller.scrollTop;
        query = next;
        if (!query) lastReport = '';
        onChange(query);
    }

    function schedule() {
        clearTimeout(timer);
        if (!debounce) { emit(input.value); return; }
        timer = setTimeout(() => emit(input.value), debounce);
    }

    function revealedHeight() {
        const declared = heightProperty ? parseFloat(getComputedStyle(field).getPropertyValue(heightProperty)) : 0;
        // A height that comes from a token expression does not parse, so the shown field is measured instead.
        return `${declared || field.getBoundingClientRect().height || 40}px`;
    }

    function syncTrigger() {
        trigger?.setAttribute('aria-expanded', String(!field.hidden));
    }

    function open({ focus = true, animate = true } = {}) {
        if (!field.hidden) {
            if (focus) input.focus({ preventScroll: true });
            return;
        }
        stopMotion(field);
        field.hidden = false;
        field.inert = false;
        field.setAttribute('aria-hidden', 'false');
        field.dataset.state = 'opening';
        syncTrigger();
        if (!animate || prefersReducedMotion()) {
            field.dataset.state = 'open';
        } else {
            play(field, [{ height: '0px', marginBlock: '0px', opacity: 0 }, { height: revealedHeight(), marginBlock: '0px', opacity: 1 }], {
                duration: MOTION_SLOW,
                onEnd: () => field.dataset.state = 'open',
            });
        }
        if (focus) input.focus({ preventScroll: true });
    }

    function close({ focus = true, animate = true } = {}) {
        if (field.hidden) return;
        stopMotion(field);
        const height = animate ? revealedHeight() : '0px';
        field.inert = true;
        field.setAttribute('aria-hidden', 'true');
        field.dataset.state = 'closing';
        const finish = () => {
            field.hidden = true;
            field.dataset.state = 'closed';
            syncTrigger();
        };
        if (!animate || prefersReducedMotion()) finish();
        else animateOut(field, [{ height, marginBlock: '0px', opacity: 1 }, { height: '0px', marginBlock: '0px', opacity: 0 }], finish, { duration: MOTION_SLOW });
        clearTimeout(timer);
        input.value = '';
        emit('');
        if (focus) trigger?.focus({ preventScroll: true });
    }

    function toggle(show = field.hidden) {
        if (show) open(); else close();
    }

    function clear() {
        clearTimeout(timer);
        input.value = '';
        emit('');
    }

    /** Sets the query programmatically. `notify: false` updates state without calling onChange. */
    function setQuery(value, { notify = true } = {}) {
        clearTimeout(timer);
        input.value = value;
        if (notify) emit(value);
        else query = value;
    }

    /**
     * Call after every completed list render. Restores the pre-search scroll position once the
     * unfiltered list exists (renders can be deferred past the clear), then announces counts.
     */
    function report(shown, total) {
        if (!query && scroller && savedScroll !== null) {
            scroller.scrollTop = savedScroll;
            savedScroll = null;
        }
        if (!status || !query) return;
        const message = shown === 0 ? t`No results` : t`${shown} of ${total} results`;
        if (message === lastReport) return;
        lastReport = message;
        status.textContent = message;
    }

    const onInput = () => schedule();
    const onInputKeydown = event => {
        if (event.key !== 'Escape' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        if (escapeClearsFirst && input.value) {
            clear();
            return;
        }
        close();
    };

    const onScopeKeydown = event => {
        if (!shortcuts || event.isComposing || event.defaultPrevented) return;
        const mod = event.ctrlKey || event.metaKey;
        const findShortcut = mod && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === 'f';
        if (scope?.closest('[data-selection-mode="true"]')) {
            // Do not let selection-mode Find fall through to the shell's global search.
            if (findShortcut) {
                event.preventDefault();
                event.stopPropagation();
            }
            return;
        }
        if (findShortcut) {
            const target = event.target;
            if (target !== input && (target instanceof HTMLTextAreaElement || target?.isContentEditable)) return;
            event.preventDefault();
            event.stopPropagation();
            open();
            input.select();
            return;
        }
        if (mod || event.altKey || event.key?.length !== 1 || event.key === ' ') return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.matches('input, textarea, select, [contenteditable], button, a[href]')) return;
        if (typeToSearchSelector && !target.matches(typeToSearchSelector) && target.closest(typeToSearchSelector) === null) return;
        event.preventDefault();
        open();
        input.value += event.key;
        schedule();
    };

    const finishPointer = () => {
        pointerActive = false;
        pointerInside = false;
        cancelAnimationFrame(blurFrame);
        blurFrame = 0;
        const close = pendingBlur;
        pendingBlur = null;
        close?.(true);
    };
    const startPointer = event => {
        pointerActive = document.activeElement === input && !field.contains(event.target);
        // Safari does not focus a pressed button, so the blur has no related target; a press on the field's own controls keeps it open.
        pointerInside = document.activeElement === input && field.contains(event.target);
    };
    const releasePointer = () => {
        pointerActive = false;
        pointerInside = false;
        if (pendingBlur) blurFrame = requestAnimationFrame(finishPointer);
    };
    const onBlur = event => {
        const nextFocus = event.relatedTarget;
        if (input.value || pointerInside || field.contains(nextFocus) || (trigger && nextFocus === trigger)) return;
        const closeNow = (restoreImmediately = false) => {
            if (destroyed || input.value || field.hidden) return;
            close();
            if (!(nextFocus instanceof HTMLElement) || !nextFocus.isConnected) return;
            if (restoreImmediately) nextFocus.focus({ preventScroll: true });
            else queueMicrotask(() => nextFocus.focus({ preventScroll: true }));
        };
        // Keep pointer-down coordinates stable until the browser has resolved the click target.
        if (pointerActive) pendingBlur = closeNow;
        else closeNow();
    };

    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onInputKeydown);
    scope?.addEventListener('keydown', onScopeKeydown);
    if (closeEmptyOnBlur) {
        input.addEventListener('blur', onBlur);
        document.addEventListener('pointerdown', startPointer, true);
        document.addEventListener('click', finishPointer, true);
        document.addEventListener('pointerup', releasePointer, true);
        document.addEventListener('pointercancel', finishPointer, true);
    }

    return {
        toggle,
        open,
        close,
        clear,
        setQuery,
        report,
        get query() { return query; },
        get isOpen() { return !field.hidden; },
        destroy() {
            destroyed = true;
            clearTimeout(timer);
            cancelAnimationFrame(blurFrame);
            pendingBlur = null;
            input.removeEventListener('input', onInput);
            input.removeEventListener('keydown', onInputKeydown);
            input.removeEventListener('blur', onBlur);
            scope?.removeEventListener('keydown', onScopeKeydown);
            document.removeEventListener('pointerdown', startPointer, true);
            document.removeEventListener('click', finishPointer, true);
            document.removeEventListener('pointerup', releasePointer, true);
            document.removeEventListener('pointercancel', finishPointer, true);
        },
    };
}
