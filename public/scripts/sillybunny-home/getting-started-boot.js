import { characters, chat, getCurrentChatId, this_chid } from '../../script.js';
import { eventSource, event_types } from '../events.js';
import { selected_group } from '../group-chats.js';
import { fixToastrForDialogs } from '../popup.js';
import { accountStorage } from '../util/AccountStorage.js';
import { createGettingStartedState, getGettingStartedSteps, setSharedGettingStartedState } from './getting-started.js';
import { createGettingStartedSignals, isGeneratedReply, isUserMessage } from './getting-started-signals.js';
import { GETTING_STARTED_STORAGE_KEY, loadGettingStartedSnapshot, serializeGettingStartedSnapshot } from './getting-started-storage.js';
import { planCompletionToast, showCompletionToast } from './getting-started-toast.js';
import { openFromHomeTile, openGettingStarted } from './windows.js';

/**
 * Conversation mode sends no `MESSAGE_SENT` and opens no chat of the app, so it announces itself on `window`
 * (attachments.js for a message, chrome.js for a thread). Keep the names in step with the ones it dispatches.
 */
export const CONVERSATION_MESSAGE_SENT_EVENT = 'sb:conversation-user-message-sent';
export const CONVERSATION_THREAD_OPENED_EVENT = 'sb:conversation-thread-opened';

const steps = getGettingStartedSteps();
const stepIds = steps.map(step => step.id);

/** @type {ReturnType<typeof createGettingStartedState> | null} */
let state = null;
/** @type {ReturnType<typeof createGettingStartedSignals> | null} */
let signals = null;

async function closeGettingStartedWindow() {
    const { closeGettingStartedWindow: close } = await import('./getting-started-window.js');
    return close();
}

/**
 * Builds the state from the account storage, once. The account storage is ready when the settings are loaded,
 * and `firstRun` is still true then for a fresh install, so this runs on SETTINGS_LOADED_BEFORE. Onboarding ends
 * the first run before the app is ready, so no later event could tell a fresh install from an old account. A
 * value that was never stored is written at once, or a fresh install would look like an old account on its next boot.
 * @param {boolean} firstRun
 */
function createStoredState(firstRun) {
    if (state) {
        return state;
    }
    const { snapshot, isNew } = loadGettingStartedSnapshot({
        raw: accountStorage.getItem(GETTING_STARTED_STORAGE_KEY),
        stepIds,
        firstRun,
    });
    state = createGettingStartedState(stepIds, {
        snapshot,
        save: written => accountStorage.setItem(GETTING_STARTED_STORAGE_KEY, serializeGettingStartedSnapshot(written)),
    });
    setSharedGettingStartedState(state);
    if (isNew) {
        state.persist();
    }
    signals = createGettingStartedSignals({
        state,
        onStepCompleted(stepId) {
            const plan = planCompletionToast({ steps, state: /** @type {NonNullable<typeof state>} */ (state), finishedId: stepId });
            if (plan) {
                showCompletionToast(plan, {
                    closeWindow: closeGettingStartedWindow,
                    openWindow: () => openFromHomeTile('getting-started', openGettingStarted),
                    moveIntoDialog: fixToastrForDialogs,
                });
            }
        },
    });
    return state;
}

/** @returns {ReturnType<typeof createGettingStartedSignals>} */
function getSignals() {
    // A boot that never emitted SETTINGS_LOADED_BEFORE has an account with settings of its own: treat it as an old one.
    createStoredState(false);
    return /** @type {ReturnType<typeof createGettingStartedSignals>} */ (signals);
}

/** The avatar file of the open card, when one card is open. A group or no chat has none. */
function getOpenCardAvatar() {
    return selected_group ? undefined : characters[this_chid]?.avatar;
}

/**
 * Listens for what the Getting Started steps ask for. The listeners are added once when the app loads, and they
 * stay for the session: Home renders again after many actions, and a listener for each render would count twice.
 */
function bindSignals() {
    eventSource.on(event_types.SETTINGS_LOADED_BEFORE, (/** @type {{ firstRun?: boolean } | undefined} */ settings) => {
        createStoredState(Boolean(settings?.firstRun));
    });
    eventSource.on(event_types.APP_READY, () => getSignals().appReady());
    eventSource.on(event_types.ONLINE_STATUS_CHANGED, (/** @type {string} */ status) => getSignals().onlineStatusChanged(status));
    eventSource.on(event_types.PRESET_CHANGED, () => getSignals().presetChanged());
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => getSignals().libraryChanged(() => characters.map(card => card.avatar)));
    eventSource.on(event_types.CHAT_CHANGED, () => getSignals().chatOpened(getCurrentChatId(), getOpenCardAvatar()));
    eventSource.on(event_types.MESSAGE_SENT, (/** @type {number} */ messageId) => {
        if (isUserMessage(chat[messageId])) {
            getSignals().messageSent();
        }
    });
    // A reply that a model generated proves a connection that reports no status, such as a bypassed check.
    eventSource.on(event_types.MESSAGE_RECEIVED, (/** @type {number} */ messageId, /** @type {string} */ type) => {
        if (isGeneratedReply(type, chat[messageId])) {
            getSignals().replyGenerated();
        }
    });
    window.addEventListener(CONVERSATION_MESSAGE_SENT_EVENT, () => getSignals().messageSent());
    window.addEventListener(CONVERSATION_THREAD_OPENED_EVENT, (event) => {
        getSignals().conversationThreadOpened(/** @type {CustomEvent<{ avatar?: string }>} */ (event).detail?.avatar);
    });
}

bindSignals();
