const VIEWPORT_MARGIN = 5;

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function getMenuViewportBounds() {
    const viewport = window.visualViewport;
    const offsetLeft = viewport?.offsetLeft ?? 0;
    const offsetTop = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;

    return {
        left: offsetLeft + VIEWPORT_MARGIN,
        top: offsetTop + VIEWPORT_MARGIN,
        right: offsetLeft + width - VIEWPORT_MARGIN,
        bottom: offsetTop + height - VIEWPORT_MARGIN,
        width: Math.max(0, width - (VIEWPORT_MARGIN * 2)),
        height: Math.max(0, height - (VIEWPORT_MARGIN * 2)),
    };
}

export function constrainMenuSize(menu, viewport) {
    menu.style.width = 'max-content';
    menu.style.maxWidth = `${viewport.width}px`;
    menu.style.maxHeight = `${viewport.height}px`;
    menu.style.boxSizing = 'border-box';
}

export function syncMenuOverflow(menu) {
    const overflowsHorizontally = menu.scrollWidth > menu.clientWidth + 1;
    const overflowsVertically = menu.scrollHeight > menu.clientHeight + 1;

    if (!overflowsHorizontally && !overflowsVertically) {
        menu.style.overflow = 'visible';
        return;
    }

    menu.style.overflowX = overflowsHorizontally ? 'auto' : 'hidden';
    menu.style.overflowY = overflowsVertically ? 'auto' : 'hidden';
}
