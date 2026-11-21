export const HOME_STATE_CHANGED_EVENT = 'sb:home-state-changed';

const HOME_ATTRIBUTE = 'data-sb-home';
const CONVERSATION_MODE_ATTRIBUTE = 'data-sb-conversation-mode';

const state = {
    chat: null,
    sheld: null,
    observer: null,
    active: false,
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

function writeHomeAttribute() {
    if (!state.sheld) {
        return;
    }

    if (state.active) {
        state.sheld.setAttribute(HOME_ATTRIBUTE, 'on');
    } else {
        state.sheld.removeAttribute(HOME_ATTRIBUTE);
    }
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
