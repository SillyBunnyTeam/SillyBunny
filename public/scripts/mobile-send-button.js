const IOS_SYNTHETIC_CLICK_SUPPRESS_MS = 2500;
const IOS_STABLE_COMPOSER_VIEWPORT_MAJOR = 26;

/**
 * Detects iOS Safari/WebKit surfaces, including iPadOS desktop-mode Safari.
 * @param {Navigator} [navigatorRef] Navigator-like object
 * @returns {boolean}
 */
export function isIOSWebKitPlatform(navigatorRef = globalThis.navigator) {
    if (!navigatorRef) {
        return false;
    }

    const platform = String(navigatorRef.platform || '');
    return /iPad|iPhone|iPod/.test(platform) || (platform === 'MacIntel' && Number(navigatorRef.maxTouchPoints) > 1);
}

/**
 * Detects known iOS versions that need the legacy composer keyboard inset.
 * Unknown versions retain the modern stable viewport behavior.
 * @param {Navigator} [navigatorRef] Navigator-like object
 * @returns {boolean}
 */
export function isLegacyIOSWebKitPlatform(navigatorRef = globalThis.navigator) {
    if (!isIOSWebKitPlatform(navigatorRef)) {
        return false;
    }

    const match = String(navigatorRef.userAgent || '').match(/\bCPU(?: iPhone)? OS (\d+)(?:[_\s]|$)/i);
    const majorVersion = Number(match?.[1]);
    return Number.isInteger(majorVersion) && majorVersion < IOS_STABLE_COMPOSER_VIEWPORT_MAJOR;
}

/**
 * Checks whether a touch ended inside the given element.
 * @param {Event|JQuery.Event} event Touch event
 * @param {Element} element Element that started the touch
 * @param {Document} [documentRef] Document-like object
 * @returns {boolean}
 */
export function touchEndedInsideElement(event, element, documentRef = globalThis.document) {
    const originalEvent = event?.originalEvent || event;
    const touch = originalEvent?.changedTouches?.[0];

    if (!touch || !element || typeof element.contains !== 'function') {
        return true;
    }

    const target = documentRef?.elementFromPoint?.(touch.clientX, touch.clientY);
    return Boolean(target && (target === element || element.contains(target)));
}

/**
 * Adds a touch-first iOS send handler. Mobile Safari can delay a normal click on
 * a focused textarea-adjacent div until after keyboard/viewport settling.
 * @param {Element} sendButton Send button element
 * @param {(event: Event) => Promise<void>|void} sendAction Send callback
 * @param {object} [options] Options for tests and platform overrides
 * @param {boolean|(() => boolean)} [options.isIOS] Whether to enable the fast touch path
 * @param {number} [options.suppressClickMs] Synthetic click suppression window
 * @param {() => number} [options.now] Clock function
 * @param {Document} [options.documentRef] Document-like object
 * @returns {() => void} Cleanup function
 */
export function bindIOSFastTapSendButton(sendButton, sendAction, {
    isIOS = isIOSWebKitPlatform,
    suppressClickMs = IOS_SYNTHETIC_CLICK_SUPPRESS_MS,
    now = () => Date.now(),
    documentRef = globalThis.document,
} = {}) {
    if (!sendButton || typeof sendButton.addEventListener !== 'function') {
        return () => {};
    }

    let touchStarted = false;
    let suppressClickUntil = 0;

    const shouldUseFastTap = () => typeof isIOS === 'function' ? Boolean(isIOS()) : Boolean(isIOS);
    const suppressNextClick = () => {
        suppressClickUntil = now() + suppressClickMs;
    };
    const consumeEvent = (event) => {
        event.preventDefault();
        event.stopPropagation();
    };
    const runSendAction = (event) => {
        Promise.resolve(sendAction(event)).catch(error => setTimeout(() => {
            throw error;
        }, 0));
    };

    const onTouchStart = (event) => {
        if (!shouldUseFastTap()) {
            return;
        }

        touchStarted = true;
        suppressNextClick();
        consumeEvent(event);
    };

    const onTouchCancel = (event) => {
        if (!touchStarted || !shouldUseFastTap()) {
            return;
        }

        touchStarted = false;
        suppressNextClick();
        consumeEvent(event);
    };

    const onTouchEnd = (event) => {
        if (!touchStarted || !shouldUseFastTap()) {
            return;
        }

        touchStarted = false;
        suppressNextClick();
        consumeEvent(event);

        if (touchEndedInsideElement(event, sendButton, documentRef)) {
            runSendAction(event);
        }
    };

    const onClick = (event) => {
        if (shouldUseFastTap() && now() < suppressClickUntil) {
            consumeEvent(event);
            return;
        }

        runSendAction(event);
    };

    sendButton.addEventListener('touchstart', onTouchStart, { passive: false });
    sendButton.addEventListener('touchcancel', onTouchCancel, { passive: false });
    sendButton.addEventListener('touchend', onTouchEnd, { passive: false });
    sendButton.addEventListener('click', onClick);

    return () => {
        sendButton.removeEventListener('touchstart', onTouchStart);
        sendButton.removeEventListener('touchcancel', onTouchCancel);
        sendButton.removeEventListener('touchend', onTouchEnd);
        sendButton.removeEventListener('click', onClick);
    };
}
