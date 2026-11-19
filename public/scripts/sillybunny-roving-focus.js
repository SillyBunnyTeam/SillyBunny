const NEXT_KEYS = Object.freeze({ horizontal: 'ArrowRight', vertical: 'ArrowDown' });
const PREVIOUS_KEYS = Object.freeze({ horizontal: 'ArrowLeft', vertical: 'ArrowUp' });

/**
 * Gives a group of related controls one Tab stop. The current item has `tabindex="0"` and the others `-1`; the arrow keys of the
 * group's axis, Home and End move focus between the items and wrap at the ends. Moving only focuses unless `onMove` selects.
 *
 * An item that the page hides (`hidden`, or `display: none` on the item itself) is skipped. The stops follow the group on their
 * own: a MutationObserver re-reads the items when they are added, hidden or selected.
 *
 * @param {HTMLElement} container The element that holds the items.
 * @param {object} options
 * @param {string} options.itemSelector Selects the items inside `container`.
 * @param {'horizontal'|'vertical'} [options.orientation] The axis of the arrow keys.
 * @param {(item: HTMLElement) => boolean} [options.isSelected] Whether an item is the selected one. It holds the Tab stop when focus is elsewhere.
 * @param {(item: HTMLElement) => void} [options.onMove] Runs after focus moved with a key; a group that selects on arrow keys selects here.
 * @returns {{ sync: () => void, destroy: () => void }}
 */
export function bindRovingFocus(container, { itemSelector, orientation = 'horizontal', isSelected = () => false, onMove = null }) {
    const items = () => [...container.querySelectorAll(itemSelector)].filter(item => item instanceof HTMLElement && !item.hidden && getComputedStyle(item).display !== 'none');

    function setCurrent(current) {
        for (const item of container.querySelectorAll(itemSelector)) {
            const value = item === current ? '0' : '-1';
            if (item.getAttribute('tabindex') !== value) item.setAttribute('tabindex', value);
        }
    }

    function sync() {
        const available = items();
        const focused = available.find(item => item === document.activeElement);
        setCurrent(focused ?? available.find(isSelected) ?? available[0] ?? null);
    }

    function onKeydown(event) {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const from = event.target instanceof Element ? event.target.closest(itemSelector) : null;
        if (!from || !container.contains(from)) return;
        const available = items();
        const index = available.indexOf(from);
        if (index < 0) return;
        let target = null;
        if (event.key === NEXT_KEYS[orientation]) target = available[(index + 1) % available.length];
        else if (event.key === PREVIOUS_KEYS[orientation]) target = available[(index - 1 + available.length) % available.length];
        else if (event.key === 'Home') target = available[0];
        else if (event.key === 'End') target = available.at(-1);
        if (!target) return;
        event.preventDefault();
        setCurrent(target);
        target.focus({ preventScroll: false });
        if (target !== from) onMove?.(target);
    }

    function onFocusin(event) {
        const item = event.target instanceof Element ? event.target.closest(itemSelector) : null;
        if (item && container.contains(item)) setCurrent(item);
    }

    container.addEventListener('keydown', onKeydown);
    container.addEventListener('focusin', onFocusin);
    const observer = new MutationObserver(sync);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-selected', 'aria-pressed'] });
    sync();

    return {
        sync,
        destroy() {
            observer.disconnect();
            container.removeEventListener('keydown', onKeydown);
            container.removeEventListener('focusin', onFocusin);
        },
    };
}
