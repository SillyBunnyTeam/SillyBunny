export const HOME_STATE_CHANGED_EVENT = 'sb:home-state-changed';

const HOME_ATTRIBUTE = 'data-sb-home';
// The shell has this attribute only while it goes from the Home width to the chat width, so that this change animates and a
// window resize never does. The limit ends it when the width does not change, and so no transition ends.
const LEAVING_ATTRIBUTE = 'data-sb-home-leaving';
const LEAVING_LIMIT_MS = 500;
const CONVERSATION_MODE_ATTRIBUTE = 'data-sb-conversation-mode';

const state = {
    chat: null,
    sheld: null,
    observer: null,
    active: false,
    leavingTimer: 0,
};

function hasWelcomePanel(chat) {
    return chat?.querySelector(':scope > .welcomePanel') != null;
}

function isConversationModeOn(sheld) {
    return sheld?.getAttribute(CONVERSATION_MODE_ATTRIBUTE) === 'on';
}

function deriveHomeActive() {
    const chat = state.chat ?? document.getElementById('chat');
    const sheld = state.sheld ?? document.getElementById('sheld');
    return hasWelcomePanel(chat) && !isConversationModeOn(sheld);
}

function stopLeaving(sheld) {
    window.clearTimeout(state.leavingTimer);
    state.leavingTimer = 0;
    sheld?.removeEventListener('transitionend', onLeavingTransitionEnd);
    sheld?.removeAttribute(LEAVING_ATTRIBUTE);
}

function onLeavingTransitionEnd(event) {
    if (event.target === event.currentTarget && event.propertyName === 'width') {
        stopLeaving(event.currentTarget);
    }
}

function startLeaving(sheld) {
    stopLeaving(sheld);
    sheld.setAttribute(LEAVING_ATTRIBUTE, '');
    sheld.addEventListener('transitionend', onLeavingTransitionEnd);
    state.leavingTimer = window.setTimeout(() => stopLeaving(sheld), LEAVING_LIMIT_MS);
}

function writeHomeAttribute() {
    if (!state.sheld) {
        return;
    }

    if (state.active) {
        stopLeaving(state.sheld);
        state.sheld.setAttribute(HOME_ATTRIBUTE, 'on');
        return;
    }

    // The mark and the end of Home are written in one turn, so the style that follows has both.
    if (state.sheld.hasAttribute(HOME_ATTRIBUTE)) {
        startLeaving(state.sheld);
    }
    state.sheld.removeAttribute(HOME_ATTRIBUTE);
}

function syncHomeState() {
    const active = deriveHomeActive();
    const changed = active !== state.active;
    state.active = active;
    writeHomeAttribute();

    if (changed) {
        document.dispatchEvent(new CustomEvent(HOME_STATE_CHANGED_EVENT, { detail: { active } }));
    }
}

function releaseElements() {
    state.observer?.disconnect();
    state.observer = null;
    stopLeaving(state.sheld);
    state.sheld?.removeAttribute(HOME_ATTRIBUTE);
}

/**
 * Starts deriving the Home state from `#chat` and `#sheld`. Home is active when `#chat` has a
 * `.welcomePanel` child and Conversation mode is off. Calling it again with the same elements
 * does nothing; with new elements it moves the observation to them.
 * @param {{ chat?: HTMLElement | null, sheld?: HTMLElement | null }} [elements]
 */
export function initHomeState({
    chat = document.getElementById('chat'),
    sheld = document.getElementById('sheld'),
} = {}) {
    if (state.observer && state.chat === chat && state.sheld === sheld) {
        return;
    }

    releaseElements();
    state.chat = chat;
    state.sheld = sheld;

    state.observer = new MutationObserver(syncHomeState);
    if (chat) {
        state.observer.observe(chat, { childList: true });
    }
    if (sheld) {
        state.observer.observe(sheld, { attributes: true, attributeFilter: [CONVERSATION_MODE_ATTRIBUTE] });
    }

    syncHomeState();
}

/**
 * Reads the DOM directly, so it is right in the same turn as a change that the attribute and the
 * event only report after the observer runs.
 * @returns {boolean}
 */
export function isHomeActive() {
    return deriveHomeActive();
}
