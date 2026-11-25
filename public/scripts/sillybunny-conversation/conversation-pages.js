import { CHROME_IDS } from './constants.js';
import { getCurrentCharAvatar } from './context.js';
import { LAYOUT_MOBILE_QUERY } from '../sillybunny-editor/breakpoints.js';

function isMobileConversationLayout() {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(LAYOUT_MOBILE_QUERY).matches;
}

/**
 * Derives the navigation page (`#sheld[data-sb-conversation-page]`) of the pages layout from the state of the list.
 * Every path that opens or closes the list calls this.
 */
export function syncConversationPage() {
    const conversationList = document.getElementById(CHROME_IDS.conversationList);
    const sheld = document.getElementById('sheld');
    if (!(sheld instanceof HTMLElement) || typeof sheld.setAttribute !== 'function') {
        return;
    }

    const listOpen = conversationList instanceof HTMLElement && conversationList.dataset.open === 'true';
    sheld.setAttribute('data-sb-conversation-page', (listOpen || !getCurrentCharAvatar()) ? 'list' : 'chat');
}

// The list and the chat share #sheld only from this width. The narrowest list is 220px, and the chat needs room for its
// header and its composer entry beside it. Narrower, the list is a page of its own, as it is in the mobile layout.
const TWO_PANE_MIN_WIDTH = 670;
let layoutObserver = null;

function layoutForSheld(sheld) {
    return isMobileConversationLayout() || sheld.offsetWidth < TWO_PANE_MIN_WIDTH ? 'pages' : 'panes';
}

/** Sets `#sheld[data-sb-conversation-layout]` to `pages` (mobile, or a #sheld too narrow for two panes) or `panes`. */
export function syncConversationLayout() {
    const sheld = document.getElementById('sheld');
    if (!(sheld instanceof HTMLElement)) {
        return;
    }
    const layout = layoutForSheld(sheld);
    if (sheld.dataset.sbConversationLayout !== layout) {
        sheld.dataset.sbConversationLayout = layout;
        syncConversationPage();
    }
}

export function observeConversationLayout(active) {
    const sheld = document.getElementById('sheld');
    if (!active) {
        layoutObserver?.disconnect();
        layoutObserver = null;
        sheld?.removeAttribute?.('data-sb-conversation-layout');
        return;
    }
    syncConversationLayout();
    if (!layoutObserver && sheld instanceof HTMLElement && typeof ResizeObserver === 'function') {
        layoutObserver = new ResizeObserver(() => syncConversationLayout());
        layoutObserver.observe(sheld);
    }
}

export function closeConversationList() {
    const conversationList = document.getElementById(CHROME_IDS.conversationList);
    if (conversationList instanceof HTMLElement) {
        conversationList.dataset.open = 'false';
    }
    syncConversationPage();
}

export function openConversationList() {
    const conversationList = document.getElementById(CHROME_IDS.conversationList);
    if (conversationList instanceof HTMLElement) {
        conversationList.dataset.open = 'true';
    }
    syncConversationPage();
}

export function toggleConversationList() {
    const conversationList = document.getElementById(CHROME_IDS.conversationList);
    if (!(conversationList instanceof HTMLElement)) {
        return;
    }

    conversationList.dataset.open = conversationList.dataset.open === 'true' ? 'false' : 'true';
    syncConversationPage();
}
