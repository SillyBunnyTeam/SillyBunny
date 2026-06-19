import { getParsedUA, isMobile } from './RossAscends-mods.js';

const isFirefox = () => /firefox/i.test(navigator.userAgent);

function addMacOSPatch() {
    const userAgent = getParsedUA();

    if (userAgent?.os?.name === 'macOS') {
        document.body.classList.add('is-macos');
    }
}

function sanitizeInlineQuotationOnCopy() {
    // STRG+C, STRG+V on firefox leads to duplicate double quotes when inline quotation elements are copied.
    // To work around this, take the selection and transform <q> to <span> before calling toString().
    document.addEventListener('copy', function (event) {
        if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
            return;
        }

        const selection = window.getSelection();
        if (!selection.anchorNode?.parentElement.closest('.mes_text')) {
            return;
        }

        const range = selection.getRangeAt(0).cloneContents();
        const tempDOM = document.createDocumentFragment();

        /**
         * Process a node, transforming <q> elements to <span> elements and preserving children.
         * @param {Node} node Input node
         * @returns {Node} Processed node
         */
        function processNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE && node.nodeName.toLowerCase() === 'q') {
                // Transform <q> to <span>, preserve children
                const span = document.createElement('span');

                [...node.childNodes].forEach(child => {
                    const processedChild = processNode(child);
                    span.appendChild(processedChild);
                });

                return span;
            } else {
                // Nested structures containing <q> elements are unlikely
                return node.cloneNode(true);
            }
        }

        [...range.childNodes].forEach(child => {
            const processedChild = processNode(child);
            tempDOM.appendChild(processedChild);
        });

        const newRange = document.createRange();
        newRange.selectNodeContents(tempDOM);

        event.preventDefault();
        event.clipboardData.setData('text/plain', newRange.toString());
    });
}

function addSafariPatch() {
    const userAgent = getParsedUA();
    console.debug('User Agent', userAgent);
    const isMobileSafari = /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isDesktopSafari = userAgent?.browser?.name === 'Safari' && userAgent?.platform?.type === 'desktop';
    const isIOS = userAgent?.os?.name === 'iOS';
    const isMacOS = userAgent?.os?.name === 'macOS';

    if (isIOS || isMobileSafari || isDesktopSafari) {
        document.body.classList.add('safari');
    }

    if (isDesktopSafari && isMacOS) {
        document.body.classList.add('safari-macos');
    }
}

function addFirefoxPatch() {
    const userAgent = getParsedUA();
    const isDesktopFirefox = userAgent?.browser?.name === 'Firefox' && userAgent?.platform?.type === 'desktop';
    const isMacFirefox = isDesktopFirefox && userAgent?.os?.name === 'macOS';

    if (isDesktopFirefox) {
        document.body.classList.add('firefox-desktop');
    }

    if (isMacFirefox) {
        document.body.classList.add('firefox-macos');
    }
}

function addChromePatch() {
    const userAgent = getParsedUA();
    const isDesktopChrome = userAgent?.browser?.name === 'Chrome' && userAgent?.platform?.type === 'desktop';
    const isMacChrome = isDesktopChrome && userAgent?.os?.name === 'macOS';

    if (isMacChrome) {
        document.body.classList.add('chrome-macos');
    }
}

function isEditableFocusTarget(element) {
    return element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement
        || (element instanceof HTMLElement && element.isContentEditable);
}

function applyBrowserFixes() {
    if (isFirefox()) {
        sanitizeInlineQuotationOnCopy();
    }

    if (isMobile()) {
        const viewport = window.visualViewport;
        const isIOSWebKit = /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const viewportResetSettleMs = 360;
        let viewportFixScheduled = false;
        let viewportResetScheduled = false;
        let lastViewportHeight = Math.round(viewport?.height || window.innerHeight || 0);
        let lastOffsetLeft = Math.round(viewport?.offsetLeft || 0);
        let lastSendInteractionAt = 0;
        let lastSendFocusedAt = 0;

        const updateViewportBaseline = () => {
            lastViewportHeight = Math.round(viewport?.height || window.innerHeight || 0);
            lastOffsetLeft = Math.round(viewport?.offsetLeft || 0);
        };

        const resetTransientViewportPosition = ({ restoreScroll = false } = {}) => {
            document.documentElement.style.position = '';
            document.documentElement.style.top = '';
            document.documentElement.style.left = '';
            document.documentElement.style.right = '';
            document.documentElement.style.bottom = '';
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.left = '';
            document.body.style.right = '';
            document.body.style.bottom = '';
            document.body.style.transform = '';

            if (restoreScroll && ((document.scrollingElement?.scrollTop || 0) > 0 || (document.scrollingElement?.scrollLeft || 0) > 0)) {
                window.scrollTo(0, 0);
            }
        };

        const scheduleViewportReset = ({ restoreScroll = false } = {}) => {
            if (viewportResetScheduled) {
                return;
            }

            viewportResetScheduled = true;

            requestAnimationFrame(() => {
                resetTransientViewportPosition({ restoreScroll });
                updateViewportBaseline();

                window.setTimeout(() => {
                    resetTransientViewportPosition({ restoreScroll });
                    updateViewportBaseline();
                    viewportResetScheduled = false;
                }, viewportResetSettleMs);
            });
        };

        const handleMobileViewportReset = (event) => {
            scheduleViewportReset({ restoreScroll: Boolean(event?.detail?.restoreScroll) });
        };

        const applyPositionFix = ({ force = false } = {}) => {
            updateViewportBaseline();

            if (!force && viewportResetScheduled) {
                return;
            }

            // SillyBunny: do not force the viewport fix while the mobile shell is
            // actively editing an input; that can disrupt IME composition and text fixes.
            // Avoid force-pinning the root while Android IMEs are actively
            // editing text. That can break replacement/correction targets and
            // make accepted suggestions append at the end of the field instead.
            if (!force && isEditableFocusTarget(document.activeElement)) {
                return;
            }

            if (!force && isIOSWebKit && (Date.now() - lastSendInteractionAt < 500 || Date.now() - lastSendFocusedAt < 500)) {
                updateViewportBaseline();
                return;
            }

            if (viewportFixScheduled) {
                return;
            }

            viewportFixScheduled = true;
            console.debug('[Mobile] Device viewport change detected.');
            document.documentElement.style.position = 'fixed';
            requestAnimationFrame(() => {
                resetTransientViewportPosition();
                viewportFixScheduled = false;
            });
        };

        const fixFunkyPositioning = () => {
            if (isFirefox() && isEditableFocusTarget(document.activeElement)) {
                return;
            }

            const currentViewportHeight = Math.round(viewport?.height || window.innerHeight || 0);
            const viewportDelta = Math.abs(currentViewportHeight - lastViewportHeight);
            const currentOffsetLeft = Math.round(viewport?.offsetLeft || 0);
            const offsetLeftDelta = Math.abs(currentOffsetLeft - lastOffsetLeft);

            lastViewportHeight = currentViewportHeight;
            lastOffsetLeft = currentOffsetLeft;

            // SillyBunny: detect horizontal visual-viewport drift from pinch-zoom
            // panning (Android Firefox ignores user-scalable=no). Reset scroll and
            // transient position fixes so the app re-anchors to the layout viewport.
            if (offsetLeftDelta > 4) {
                scheduleViewportReset({ restoreScroll: true });
                return;
            }

            // Ignore tiny viewport twitches from the mobile browser chrome and
            // keyboard suggestion UI. Those do not need the layout workaround.
            if (viewportDelta < 24) {
                return;
            }

            applyPositionFix();
        };

        viewport?.addEventListener('resize', fixFunkyPositioning, { passive: true });
        viewport?.addEventListener('scroll', fixFunkyPositioning, { passive: true });
        window.addEventListener('resize', fixFunkyPositioning, { passive: true });
        document.addEventListener('pointerdown', (event) => {
            if (event.target instanceof HTMLElement && event.target.closest('#send_but')) {
                lastSendInteractionAt = Date.now();
                updateViewportBaseline();
            }
        }, { passive: true, capture: true });
        const handleFocusIn = (event) => {
            updateViewportBaseline();
            if (event.target instanceof HTMLElement && event.target.closest('#send_textarea')) {
                lastSendFocusedAt = Date.now();
            }
        };

        document.addEventListener('focusin', handleFocusIn, true);
        window.addEventListener('orientationchange', () => {
            updateViewportBaseline();
            applyPositionFix({ force: true });
        }, { passive: true });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                updateViewportBaseline();
            }
        });
        document.addEventListener('focusout', scheduleViewportReset, true);
        document.addEventListener('click', (event) => {
            if (event.target instanceof HTMLElement && event.target.closest('#completion_prompt_manager_popup :is(.menu_button, .popup-button-close, [id$="_close_button"], [id$="_form_close"], [id$="_form_save"])')) {
                scheduleViewportReset();
            }
        }, true);
        document.addEventListener('transitionend', (event) => {
            if (event.target instanceof HTMLElement && event.target.id === 'completion_prompt_manager_popup') {
                scheduleViewportReset();
            }
        }, true);
        window.addEventListener('sb-mobile-viewport-reset', handleMobileViewportReset);
    }

    addMacOSPatch();
    addSafariPatch();
    addFirefoxPatch();
    addChromePatch();
}

export { isFirefox, applyBrowserFixes };
