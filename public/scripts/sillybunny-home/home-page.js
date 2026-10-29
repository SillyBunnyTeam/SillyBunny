import { play, SPRING_NAVIGATION } from '../sillybunny-motion.js';

const PAGE_OFFSET = '48px';
const LAYOUT_OFFSET = '-16px';
const OPEN_PAGE_SELECTOR = '#chat > .welcomePanel[data-sb-home-page]';
/** Anything shown that takes Escape before a Home page does. Closed menus stay in the document, so only a menu with a box counts. */
const ESCAPE_OWNER_SELECTOR = 'dialog[open], [role="menu"]';

/** @type {(() => unknown) | null} */
let taskAfterClose = null;

/**
 * Whether the Home panel in the document shows a page. A render that replaces the panel would drop the
 * page, its scroll position and its focus, so callers check this first.
 * @returns {boolean}
 */
export function isHomePageOpen() {
    return document.querySelector(OPEN_PAGE_SELECTOR) !== null;
}

/**
 * Keeps one task for the moment the open page has closed. A newer task replaces an older one, because the
 * task is a render and only the latest request matters.
 * @param {() => unknown} task
 */
export function runAfterHomePageCloses(task) {
    taskAfterClose = task;
}

function runTaskAfterClose() {
    const task = taskAfterClose;
    taskAfterClose = null;
    if (task) {
        Promise.resolve().then(task).catch(error => console.error('Home task after a page closed failed:', error));
    }
}

/**
 * Lets a Home panel show one page in place of its sections, one level deep. The page is not a route and
 * leaves the display mode alone. Under reduced motion the swap is instant.
 * @param {HTMLElement} panel The `.welcomePanel` root.
 */
export function createHomePageHost(panel) {
    /** @type {{ page: HTMLElement, opener: HTMLElement, scrollTop: number } | null} */
    let entry = null;

    function getLayout() {
        return /** @type {HTMLElement} */ (panel.querySelector('.sbHomeLayout'));
    }

    function focusOpener(opener) {
        opener.focus({ preventScroll: true });
        if (document.activeElement !== opener) {
            /** @type {HTMLElement | null} */ (panel.querySelector('.sbHomeMenuButton'))?.focus({ preventScroll: true });
        }
    }

    /**
     * The listener sits on the document, so Escape works after a click on the margin around the page, where
     * focus is on the body. It leaves the key to anything that has focus elsewhere: menus mark the key as
     * handled, and a dialog or the settings page holds focus outside the chat.
     */
    function onKeydown(event) {
        if (!panel.isConnected) {
            document.removeEventListener('keydown', onKeydown);
            return;
        }
        if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
            return;
        }
        const target = event.target;
        const focusIsInHome = target === document.body
            || target === document.documentElement
            || (target instanceof Node && Boolean(panel.closest('#chat')?.contains(target)));
        const otherOwnerOpen = document.documentElement.dataset.sbSettingsOpen !== undefined
            || Array.from(document.querySelectorAll(ESCAPE_OWNER_SELECTOR)).some(owner => owner.getClientRects().length > 0);
        if (!focusIsInHome || otherOwnerOpen) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        pop();
    }

    /**
     * @param {HTMLElement} page Has a `[data-sb-page-back]` control, which takes focus.
     * @param {HTMLElement} opener The control that opened the page. Focus returns to it.
     */
    function push(page, opener) {
        if (entry) {
            return;
        }
        const layout = getLayout();
        const chat = panel.closest('#chat');
        entry = { page, opener, scrollTop: chat?.scrollTop ?? 0 };

        panel.dataset.sbHomePage = 'open';
        layout.inert = true;
        panel.append(page);
        // The page starts at the top of the panel, so a scrolled Home would put it out of sight.
        if (chat) {
            chat.scrollTop = 0;
        }
        document.addEventListener('keydown', onKeydown);
        /** @type {HTMLElement} */ (page.querySelector('[data-sb-page-back]') ?? page).focus({ preventScroll: true });

        play(page, [
            { opacity: 0, transform: `translateX(${PAGE_OFFSET})` },
            { opacity: 1, transform: 'none' },
        ], { ...SPRING_NAVIGATION });
        // onFinish runs only when the fade completes, so a Back during the push never hides the layout again.
        play(layout, [
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: `translateX(${LAYOUT_OFFSET})` },
        ], { ...SPRING_NAVIGATION, onFinish: () => { layout.hidden = true; } });
    }

    function pop() {
        if (!entry) {
            return;
        }
        const { page, opener, scrollTop } = entry;
        const layout = getLayout();
        entry = null;
        document.removeEventListener('keydown', onKeydown);

        layout.hidden = false;
        layout.inert = false;
        const chat = panel.closest('#chat');
        if (chat) {
            chat.scrollTop = scrollTop;
        }
        focusOpener(opener);

        play(layout, [
            { opacity: 0, transform: `translateX(${LAYOUT_OFFSET})` },
            { opacity: 1, transform: 'none' },
        ], { ...SPRING_NAVIGATION });
        play(page, [
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: `translateX(${PAGE_OFFSET})` },
        ], {
            ...SPRING_NAVIGATION,
            fill: 'forwards',
            inert: true,
            onEnd: () => {
                page.remove();
                if (!entry) {
                    delete panel.dataset.sbHomePage;
                    runTaskAfterClose();
                }
            },
        });
    }

    return { push, pop, isOpen: () => entry !== null };
}
