import { t } from '../i18n.js';
import { ASSISTANT_AVATARS, isBundledCard, pickCharacterVariant } from './bundled-cards.js';

/**
 * The statuses of the connection that name a connection the app has not confirmed: a key that is saved but not
 * tested, an address that does not parse, and a status check that was skipped. They are the strings that
 * `openai.js` and `textgen-settings.js` pass to `setOnlineStatus`, translated the same way, so they are compared at
 * run time. A connection with one of these has not finished step 1; its first generated reply does.
 * @returns {string[]}
 */
export function getUnconfirmedConnectionStatuses() {
    return [
        t`Key saved; press "Test Message" to verify.`,
        t`Invalid endpoint URL. Requests may fail.`,
        t`Invalid Azure endpoint URL. Requests may fail.`,
        t`Status check bypassed`,
    ];
}

/**
 * Whether the status says the backend answered. `no_connection` and the unconfirmed statuses do not.
 * @param {string | null | undefined} status
 */
export function isConfirmedConnection(status) {
    return Boolean(status) && status !== 'no_connection' && !getUnconfirmedConnectionStatuses().includes(/** @type {string} */ (status));
}

/**
 * Whether a message of the chat is one the user wrote. The slash commands `/sys` and `/comment` add system
 * messages and emit the same `MESSAGE_SENT`.
 * @param {{ is_user?: boolean, is_system?: boolean } | null | undefined} message
 */
export function isUserMessage(message) {
    return Boolean(message?.is_user) && !message?.is_system;
}

/** The `MESSAGE_RECEIVED` types of messages that the app, a command or an extension writes, and no chat model generated. */
const WRITTEN_REPLY_TYPES = Object.freeze(['first_message', 'command', 'extension']);

/**
 * Whether a message that was received is a reply the model generated. The greeting (`first_message`), the
 * slash commands (`command`) and extensions such as image generation (`extension`) emit the same event without
 * a chat model, so a user with no connection would see a false Connect. A swipe through greetings that exist already
 * emits `MESSAGE_SWIPED` only, and a swipe that generates emits type `swipe`.
 * @param {string | undefined} type The second argument of `MESSAGE_RECEIVED`.
 * @param {{ is_user?: boolean, is_system?: boolean } | null | undefined} message
 */
export function isGeneratedReply(type, message) {
    return Boolean(message) && !message?.is_user && !message?.is_system && !WRITTEN_REPLY_TYPES.includes(/** @type {string} */ (type));
}

/**
 * Whether the user touched the page a moment ago. A preset that the app applies by itself, from a connection
 * profile or a settings load, arrives without a gesture. A browser that does not report user activation counts
 * every preset after the app is ready.
 * @returns {boolean}
 */
function hasRecentUserActivation() {
    const activation = globalThis.navigator?.userActivation;
    return activation ? activation.isActive : true;
}

/**
 * Turns what the app reports into the steps of Getting Started. It decides; it does not listen. The boot code
 * passes it the app's events, which keeps these rules testable without the app.
 *
 * Every signal records its step, also while Getting Started is hidden, so the counts are right when the user
 * shows it later. A signal announces the finished step (`onStepCompleted`) only when the user's own action
 * finished it: the app is ready, the step was neither done nor skipped before, and, for the preset, the user
 * touched the page. A skipped step that gets its signal becomes done without an announcement, because the user
 * chose not to be guided through it.
 * @param {object} options
 * @param {ReturnType<typeof import('./getting-started.js').createGettingStartedState>} options.state
 * @param {(stepId: string) => void} [options.onStepCompleted]
 * @param {typeof ASSISTANT_AVATARS} [options.assistantAvatars]
 * @param {() => boolean} [options.hasUserActivation]
 */
export function createGettingStartedSignals({ state, onStepCompleted = () => {}, assistantAvatars = ASSISTANT_AVATARS, hasUserActivation = hasRecentUserActivation }) {
    let ready = false;

    /**
     * @param {string} stepId
     * @param {{ variant?: string }} [details]
     */
    function complete(stepId, details) {
        const wasSkipped = state.isSkipped(stepId);
        const changed = state.markDone(stepId, details);
        if (changed && ready && !wasSkipped) {
            onStepCompleted(stepId);
        }
    }

    return {
        /** The app has started. Signals before it record progress and announce nothing. */
        appReady() {
            ready = true;
        },
        /** @param {string} status The `online_status` of the app. */
        onlineStatusChanged(status) {
            if (isConfirmedConnection(status)) {
                complete('connect');
            }
        },
        /**
         * A model generated a reply, which is the proof of a connection that reports no status of its own.
         */
        replyGenerated() {
            complete('connect');
        },
        /**
         * The user applied a preset. A preset that the app applies by itself, before it is ready or without a
         * gesture of the user, does not count.
         */
        presetChanged() {
            if (ready && hasUserActivation()) {
                complete('preset');
            }
        },
        /**
         * The library shows these cards. A card that does not ship with SillyBunny is one the user got.
         * @param {() => readonly string[]} readAvatars Read only while the step is open, because this runs on every page of the library.
         */
        libraryChanged(readAvatars) {
            if (state.isDone('character')) {
                return;
            }
            if (readAvatars().some(avatar => !isBundledCard(avatar, assistantAvatars))) {
                complete('character', { variant: 'other' });
            }
        },
        /**
         * A chat opened, with any card, the assistants included. Leaving to Home reports no chat.
         * @param {string | undefined} chatId
         * @param {string | undefined} avatar The avatar file of the open card, if a single card is open.
         */
        chatOpened(chatId, avatar) {
            if (chatId) {
                complete('character', { variant: pickCharacterVariant(avatar, assistantAvatars) });
            }
        },
        /**
         * A Conversation thread opened with a character. Conversation opens no chat of the app, so it reports itself.
         * @param {string | undefined} avatar
         */
        conversationThreadOpened(avatar) {
            complete('character', { variant: pickCharacterVariant(avatar, assistantAvatars) });
        },
        /** The user sent a message, in either mode. */
        messageSent() {
            complete('chat');
        },
    };
}
