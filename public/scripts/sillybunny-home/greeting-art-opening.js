/**
 * How long a chat that has just opened is held at the top. The hold is coupled to the load lock of the app in
 * `script.js` (`CHAT_LOAD_SCROLL_SETTLE_DELAYS_MS` and `CHAT_LOAD_BOTTOM_LOCK_EXTRA_MS`): the app scrolls a loaded chat
 * to the bottom until its latest settle delay plus the extra margin has passed, and the hold has to outlast that.
 * `sillybunny-greeting-art-opening.test.js` reads the two values from `script.js` and fails when this one is not longer.
 */
export const OPENING_HOLD_MS = 3000;

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** Any of these on the page is a person at work. */
const USER_INPUT_EVENTS = ['wheel', 'touchstart', 'pointerdown'];

const LISTENER_OPTIONS = { capture: true, passive: true };

/** @type {{ shouldHold: () => boolean } | null} */
let currentHold = null;

/**
 * Whether the scroll sink of the app (`scrollChatElementToBottom` in `script.js`) has to leave the chat where it is. It
 * is asked on every bottom pin, so the answer must stay cheap.
 *
 * The sink does not skip the question for a forced pin, because the pins of a chat load are forced too. The "Go to
 * bottom" button does not depend on the sink: `jumpScrollElementToEdge` writes `scrollTop` itself, and the scroll
 * that follows ends the hold.
 * @returns {boolean}
 */
export function shouldHoldChatAtTop() {
    return currentHold?.shouldHold() ?? false;
}

const isTypingTarget = target => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * Keeps a chat that holds only a greeting with a picture at its top while it opens, so the picture and the name row
 * are the first thing that is seen. The hold does not move the chat. It makes the app skip its own scrolls to the
 * bottom, through `shouldHoldChatAtTop`, and it puts the chat at the top once when it starts.
 *
 * An opening is the chat opening from Home, or a `CHAT_CHANGED` of a chat that is not the one already opening. It
 * can start the hold once. When a person takes over the scroll, that opening is over for the hold, and the next
 * opening is a new one.
 *
 * @param {object} options
 * @param {HTMLElement} options.chatElement
 * @param {() => boolean} options.isGreetingOnly Whether the chat is one message that gets a picture.
 * @param {Window} [options.win]
 * @param {() => number} [options.now]
 * @param {(event: Event) => boolean} [options.isPerson] Whether an event comes from a person. The app also clicks
 *     elements by script, and that must not end the hold.
 */
export function createOpeningHold({ chatElement, isGreetingOnly, win = window, now = () => win.performance.now(), isPerson = event => event.isTrusted }) {
    const doc = chatElement.ownerDocument;
    /** @type {{ id: string | undefined, takenOver: boolean, until: number } | null} */
    let opening = null;
    let holding = false;
    let holdUntil = 0;
    let expiry = 0;

    function takeOver() {
        if (opening) opening.takenOver = true;
        release();
    }

    function onUserInput(event) {
        if (isPerson(event)) takeOver();
    }

    function onKeydown(event) {
        if (isPerson(event) && SCROLL_KEYS.has(event.key) && !isTypingTarget(event.target)) takeOver();
    }

    // With the sink guarded, a chat that is off the top during the hold was moved by a person or by the browser.
    function onScroll() {
        if (chatElement.scrollTop > 0) takeOver();
    }

    function release() {
        if (!holding) return;
        holding = false;
        win.clearTimeout(expiry);
        for (const type of USER_INPUT_EVENTS) doc.removeEventListener(type, onUserInput, LISTENER_OPTIONS);
        doc.removeEventListener('keydown', onKeydown, true);
        chatElement.removeEventListener('scroll', onScroll);
    }

    function hold() {
        holdUntil = now() + OPENING_HOLD_MS;
        win.clearTimeout(expiry);
        expiry = win.setTimeout(release, OPENING_HOLD_MS);
        if (holding) return;

        holding = true;
        for (const type of USER_INPUT_EVENTS) doc.addEventListener(type, onUserInput, LISTENER_OPTIONS);
        doc.addEventListener('keydown', onKeydown, true);
        chatElement.scrollTop = 0;
        chatElement.addEventListener('scroll', onScroll);
    }

    function startOpening(id) {
        opening = { id, takenOver: false, until: now() + OPENING_HOLD_MS };
    }

    const controller = {
        /** The chat is opening from Home, which can only be a new opening. */
        beginOpening() {
            startOpening(undefined);
        },
        /**
         * `CHAT_CHANGED` fires more than once for one opening, and an opening from Home gets its id only here.
         * @param {string | undefined} chatId
         */
        chatChanged(chatId) {
            const sameOpening = opening && now() < opening.until && (opening.id === undefined || opening.id === chatId);
            if (!sameOpening) return startOpening(chatId);
            opening.id = chatId;
            opening.until = now() + OPENING_HOLD_MS;
        },
        /** The picture is in place. This starts the hold, or extends it, if the chat that is opening is worth holding. */
        offer() {
            if (!opening || now() >= opening.until || opening.takenOver) return;
            if (!isGreetingOnly() || chatElement.scrollHeight <= chatElement.clientHeight) return;
            hold();
        },
        /** Also ends a hold that no longer applies, because a hold that has ended must not start again by itself. */
        shouldHold() {
            if (!holding) return false;
            if (now() < holdUntil && isGreetingOnly()) return true;
            release();
            return false;
        },
        release,
    };
    currentHold = controller;
    return controller;
}
