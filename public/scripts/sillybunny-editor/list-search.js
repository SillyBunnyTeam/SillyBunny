import { play, stopMotion, animateOut, MOTION_SLOW } from '../sillybunny-motion.js';
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
 * @param {string} [options.heightProperty]  Custom property holding the revealed field height.
 * @param {boolean} [options.shortcuts=true] Enables Ctrl/Cmd+F and type-to-search inside `scope`.
 * @param {string} [options.typeToSearchSelector] Focus targets that accept type-to-search. Defaults to list rows.
 * @returns {{ toggle: (show?: boolean) => void, open: () => void, close: () => void, clear: () => void,
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
    typeToSearchSelector = '[data-sb-list-key]',
}) {
    let query = input.value ?? '';
    let timer = 0;
    let savedScroll = null;
    let lastReport = '';

    if (!input.id) input.id = `sb-list-search-${Math.random().toString(36).slice(2, 9)}`;
    if (trigger) {
        trigger.setAttribute('aria-controls', field.id || (field.id = `${input.id}-field`));
        trigger.setAttribute('aria-expanded', String(!field.hidden));
    }

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
        const value = heightProperty ? parseFloat(getComputedStyle(field).getPropertyValue(heightProperty)) : 0;
        return `${value || 40}px`;
    }

    function syncTrigger() {
        trigger?.setAttribute('aria-expanded', String(!field.hidden));
    }

    function open() {
        if (!field.hidden) { input.focus({ preventScroll: true }); return; }
        stopMotion(field);
        field.hidden = false;
        syncTrigger();
        play(field, [{ height: '0px', marginBlock: '0px', opacity: 0 }, { height: revealedHeight(), marginBlock: '8px', opacity: 1 }], { duration: MOTION_SLOW });
        input.focus({ preventScroll: true });
    }

    function close() {
        if (field.hidden) return;
        stopMotion(field);
        const height = revealedHeight();
        animateOut(field, [{ height, marginBlock: '8px', opacity: 1 }, { height: '0px', marginBlock: '0px', opacity: 0 }], () => {
            field.hidden = true;
            syncTrigger();
        }, { duration: MOTION_SLOW });
        clearTimeout(timer);
        input.value = '';
        emit('');
        trigger?.focus({ preventScroll: true });
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
        if (!(event.target instanceof Element) || !event.target.matches(typeToSearchSelector)) return;
        event.preventDefault();
        open();
        input.value += event.key;
        schedule();
    };

    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onInputKeydown);
    scope?.addEventListener('keydown', onScopeKeydown);

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
            clearTimeout(timer);
            input.removeEventListener('input', onInput);
            input.removeEventListener('keydown', onInputKeydown);
            scope?.removeEventListener('keydown', onScopeKeydown);
        },
    };
}
