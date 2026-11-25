// SillyBunny: keep <style> elements instead of CSSStyleSheet handles so generated focus rules can be written in one batched textContent update.
/** @type {HTMLStyleElement|null} */
let dynamicStyleElement = null;
/** @type {HTMLStyleElement|null} */
let dynamicExtensionStyleElement = null;
/** @type {Map<string, Promise<HTMLLinkElement>>} */
const asyncStylesheetPromises = new Map();
/** @type {Set<string>} */
const prefetchedAssets = new Set();

function getAbsoluteAssetUrl(href) {
    try {
        return new URL(href, document.baseURI).href;
    } catch {
        return String(href);
    }
}

function findStylesheetLink(absoluteHref, id = '') {
    if (id) {
        const existingById = document.getElementById(id);
        if (existingById instanceof HTMLLinkElement) {
            return existingById;
        }
    }

    // SillyBunny: adopt deferred style preloads instead of duplicating them
    return Array.from(document.querySelectorAll('link[rel~="stylesheet"], link[rel~="preload"][as="style"][data-sb-deferred-style]'))
        .find(link => link instanceof HTMLLinkElement && getAbsoluteAssetUrl(link.href) === absoluteHref) ?? null;
}

function waitForStylesheetLink(link, media = 'all') {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            link.removeEventListener('load', loaded);
            link.removeEventListener('error', failed);
        };
        const loaded = () => {
            // SillyBunny: share settled readiness across deferred activation and late subscribers
            link.dataset.sbStyleState = 'loaded';
            link.dataset.loaded = 'true';
            if (link.media === 'print') {
                link.media = media;
            }
            cleanup();
            resolve(link);
        };
        const failed = error => {
            link.dataset.sbStyleState = 'error';
            link.dataset.loaded = 'false';
            cleanup();
            reject(error);
        };
        if (link.dataset.sbStyleState === 'error') {
            failed(new Event('error'));
            return;
        }
        if (isStylesheetLoaded(link)) {
            loaded();
            return;
        }
        link.dataset.sbStyleState = 'loading';
        link.addEventListener('load', loaded, { once: true });
        link.addEventListener('error', failed, { once: true });
    });
}

function isStylesheetLoaded(link) {
    return Boolean(
        link.sheet
        || link.dataset.sbStyleState === 'loaded'
        || link.dataset.loaded === 'true'
        || Array.from(document.styleSheets).some(sheet => sheet.href === link.href),
    );
}

/**
 * Loads a stylesheet without making it part of the parser-blocking path.
 * The stylesheet uses a media swap so it can load without blocking first render.
 *
 * @param {string} href Stylesheet URL
 * @param {object} [options] Optional configuration
 * @param {string} [options.id] Link element id
 * @param {string} [options.media='all'] Final media query
 * @returns {Promise<HTMLLinkElement>}
 */
export function loadStylesheetAsync(href, { id = '', media = 'all' } = {}) {
    const absoluteHref = getAbsoluteAssetUrl(href);
    let existing = findStylesheetLink(absoluteHref, id);

    // SillyBunny: replace an already-failed deferred request once; a fresh failure rejects normally
    if (existing?.dataset.sbStyleState === 'error') {
        existing.remove();
        asyncStylesheetPromises.delete(absoluteHref);
        existing = null;
    }

    if (existing) {
        // SillyBunny: identify adopted links for retry cleanup and activate them before awaiting
        if (id && !existing.id) existing.id = id;
        if (existing.relList.contains('preload') && existing.hasAttribute('data-sb-deferred-style')) {
            existing.dataset.sbStyleActivated = 'true';
            existing.media = 'print';
            const loading = waitForStylesheetLink(existing, media);
            existing.rel = 'stylesheet';
            return loading;
        }
        return waitForStylesheetLink(existing, media);
    }

    if (asyncStylesheetPromises.has(absoluteHref)) {
        return asyncStylesheetPromises.get(absoluteHref);
    }

    const promise = new Promise((resolve, reject) => {
        const stylesheet = document.createElement('link');
        let settled = false;

        const finish = () => {
            if (settled) {
                return;
            }

            settled = true;
            stylesheet.dataset.sbStyleState = 'loaded';
            stylesheet.dataset.loaded = 'true';
            stylesheet.media = media;
            resolve(stylesheet);
        };

        if (id) {
            stylesheet.id = id;
        }

        stylesheet.dataset.sbStyleState = 'loading';
        stylesheet.rel = 'stylesheet';
        stylesheet.type = 'text/css';
        stylesheet.href = href;
        stylesheet.media = 'print';
        stylesheet.onload = finish;
        stylesheet.onerror = error => {
            if (settled) return;
            settled = true;
            stylesheet.dataset.sbStyleState = 'error';
            stylesheet.dataset.loaded = 'false';
            reject(error);
        };

        document.head.appendChild(stylesheet);

        if (isStylesheetLoaded(stylesheet)) {
            finish();
        }
    }).catch(error => {
        if (asyncStylesheetPromises.get(absoluteHref) === promise) asyncStylesheetPromises.delete(absoluteHref);
        throw error;
    });

    asyncStylesheetPromises.set(absoluteHref, promise);
    return promise;
}

/**
 * Queues a low-priority preload/prefetch hint for future assets.
 *
 * @param {string} href Asset URL
 * @param {object} [options] Optional configuration
 * @param {string} [options.as='fetch'] Fetch destination
 * @param {'prefetch'|'preload'|'modulepreload'} [options.rel='prefetch'] Link relation
 * @param {string} [options.type] MIME type
 * @returns {HTMLLinkElement|null}
 */
export function prefetchAsset(href, { as = 'fetch', rel = 'prefetch', type = '' } = {}) {
    const absoluteHref = getAbsoluteAssetUrl(href);
    const key = `${rel}:${as}:${absoluteHref}`;

    if (prefetchedAssets.has(key)) {
        return null;
    }

    prefetchedAssets.add(key);

    const existing = Array.from(document.querySelectorAll(`link[rel="${rel}"]`))
        .find(link => link instanceof HTMLLinkElement && getAbsoluteAssetUrl(link.href) === absoluteHref);

    if (existing instanceof HTMLLinkElement) {
        return existing;
    }

    const link = document.createElement('link');
    link.rel = rel;
    link.href = href;

    if (rel !== 'modulepreload') {
        link.as = as;
    }

    if (type) {
        link.type = type;
    }

    document.head.appendChild(link);
    return link;
}

window.SillyBunnyAssets = Object.assign(window.SillyBunnyAssets ?? {}, {
    loadStylesheetAsync,
    prefetchAsset,
});

// SillyBunny: batch :focus-visible rule mirrors into one idle-time flush per burst of stylesheet loads, skipping icon/webfont sheets.
const DYNAMIC_STYLE_ELEMENT_IDS = new Set(['dynamic-styles', 'dynamic-extension-styles']);
// SillyBunny: icon and webfont sheets carry thousands of rules and no :hover, so walking them only costs startup time.
const HOVER_FREE_STYLESHEET_PATTERN = /(?:^|\/)webfonts\/|fontawesome|(?:^|\/)(?:solid|brands|regular)(?:\.min)?\.css/i;

/** @type {Set<CSSStyleSheet>} */
const pendingStyleSheets = new Set();
/** @type {WeakSet<CSSStyleSheet>} */
const processedStyleSheets = new WeakSet();
/** @type {{ main: string[], extension: string[] }} */
const generatedFocusRules = { main: [], extension: [] };
let flushHandle = null;
let flushHandleIsIdle = false;
let initialScanPending = false;

function getStyleSheetSourceHref(styleSheet) {
    // SillyBunny: prefer original source path when a flattened/hashed asset link records data-sb-source-href.
    return styleSheet?.ownerNode?.dataset?.sbSourceHref || styleSheet?.href || '';
}

function isHoverFreeStyleSheet(styleSheet) {
    const href = getStyleSheetSourceHref(styleSheet);
    return Boolean(href) && HOVER_FREE_STYLESHEET_PATTERN.test(href);
}

function isOwnDynamicStyleNode(node) {
    return node instanceof HTMLStyleElement && DYNAMIC_STYLE_ELEMENT_IDS.has(node.id);
}

function cancelScheduledFlush() {
    if (flushHandle === null) return;
    if (flushHandleIsIdle && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(flushHandle);
    } else {
        clearTimeout(flushHandle);
    }
    flushHandle = null;
}

/**
 * Coalesces stylesheet scans into one idle-time pass, so a burst of lazily loaded sheets
 * (e.g. while switching Settings tabs) costs one style write instead of one per sheet.
 */
function scheduleFlush() {
    if (flushHandle !== null) return;
    if (typeof window.requestIdleCallback === 'function') {
        flushHandleIsIdle = true;
        flushHandle = window.requestIdleCallback(() => {
            flushHandle = null;
            flushPendingStyleSheets();
        }, { timeout: 2000 });
    } else {
        flushHandleIsIdle = false;
        flushHandle = setTimeout(() => {
            flushHandle = null;
            flushPendingStyleSheets();
        }, 200);
    }
}

function queueStyleSheet(styleSheet) {
    if (!styleSheet || processedStyleSheets.has(styleSheet)) return;
    pendingStyleSheets.add(styleSheet);
    scheduleFlush();
}

function isExtensionStyleSheet(styleSheet) {
    return getStyleSheetSourceHref(styleSheet).toLowerCase().includes('scripts/extensions');
}

function flushPendingStyleSheets() {
    cancelScheduledFlush();

    if (initialScanPending) {
        initialScanPending = false;
        document.removeEventListener('keydown', onFirstKeyboardNavigation, true);
        for (const sheet of Array.from(document.styleSheets)) {
            if (sheet.ownerNode && isOwnDynamicStyleNode(sheet.ownerNode)) continue;
            if (!processedStyleSheets.has(sheet)) pendingStyleSheets.add(sheet);
        }
    }

    if (pendingStyleSheets.size === 0) return;

    const sheets = Array.from(pendingStyleSheets);
    pendingStyleSheets.clear();
    let mainChanged = false;
    let extensionChanged = false;

    for (const sheet of sheets) {
        if (processedStyleSheets.has(sheet)) continue;
        processedStyleSheets.add(sheet);
        if (isHoverFreeStyleSheet(sheet)) continue;

        const fromExtension = isExtensionStyleSheet(sheet);
        try {
            const rules = applyDynamicFocusStyles(sheet);
            if (rules.length === 0) continue;
            generatedFocusRules[fromExtension ? 'extension' : 'main'].push(...rules);
            if (fromExtension) extensionChanged = true;
            else mainChanged = true;
        } catch (e) {
            console.warn('Failed to process stylesheet:', e);
        }
    }

    if (mainChanged) writeDynamicStyleSheet({ fromExtension: false });
    if (extensionChanged) writeDynamicStyleSheet({ fromExtension: true });
}

/**
 * An observer that will check if any new stylesheets are added to the head
 * @type {MutationObserver}
 */
const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
        if (mutation.type !== 'childList') return;
        // SillyBunny: our own generated <style> rewrites must never trigger another scan; queue added links for one batched flush.
        if (isOwnDynamicStyleNode(mutation.target)) return;

        mutation.addedNodes.forEach(node => {
            if (isOwnDynamicStyleNode(node)) return;
            if (node instanceof HTMLLinkElement && node.tagName === 'LINK' && node.rel === 'stylesheet') {
                node.addEventListener('load', () => queueStyleSheet(node.sheet), { once: true });
                // Cached sheets can already have parsed rules; the processed-set dedupes any later load event.
                if (node.sheet && (node.dataset.loaded === 'true' || (getReadableCssRules(node.sheet)?.length ?? 0) > 0)) {
                    queueStyleSheet(node.sheet);
                }
            }
        });
    });
});

function isIgnorableCssRuleAccessError(error) {
    if (!(error instanceof Error)) {
        return false;
    }

    return error.name === 'SecurityError'
        || error.name === 'NotAllowedError'
        || /cssrules/i.test(String(error.message));
}

function getReadableCssRules(styleSheet) {
    if (!styleSheet) {
        return null;
    }

    try {
        return styleSheet.cssRules;
    } catch (error) {
        if (isIgnorableCssRuleAccessError(error)) {
            return null;
        }

        throw error;
    }
}

function canGenerateDynamicFocusSelector(selector) {
    const hoverIndex = selector.indexOf(':hover');

    if (hoverIndex === -1) {
        return false;
    }

    return selector.lastIndexOf('::', hoverIndex) === -1;
}

/**
 * Generates dynamic focus styles based on the given stylesheet, taking its hover styles as reference
 *
 * @param {CSSStyleSheet} styleSheet - The stylesheet to process
 * @returns {string[]} Generated `:focus-visible` rule texts, for the caller to write in one batch
 */
function applyDynamicFocusStyles(styleSheet) {
    /** @typedef {{ type: 'media'|'supports'|'container', conditionText: string }} WrapperCond */
    /** @type {{baseSelector: string, selector: string, styleText: string, wrappers: WrapperCond[]}[]} */
    const hoverRules = [];
    /** @type {Set<string>} */
    const focusRules = new Set();

    const PLACEHOLDER = ':__PLACEHOLDER__';

    /**
     * Builds a stable signature string for a chain of wrapper conditions so we can distinguish
     * identical selectors under different contexts (e.g., different @media queries)
     * @param {WrapperCond[]} wrappers
     * @returns {string}
     */
    function wrapperSignature(wrappers) {
        return wrappers.map(w => `${w.type}:${w.conditionText}`).join(';');
    }

    /**
     * Processes the CSS rules and separates selectors for hover and focus
     * @param {CSSRuleList} rules - The CSS rules to process
     * @param {WrapperCond[]} wrappers - Current chain of wrapper conditions (@media/@supports/etc.)
     */
    function processRules(rules, wrappers = []) {
        Array.from(rules).forEach(rule => {
            if (rule instanceof CSSImportRule) {
                // Make sure that @import rules are processed recursively
                // If the @import has media conditions, treat them as wrappers as well
                /** @type {WrapperCond[]} */
                const extra = (rule.media && rule.media.mediaText) ? [{ type: 'media', conditionText: rule.media.mediaText }] : [];
                processImportedStylesheet(rule.styleSheet, [...wrappers, ...extra]);
            } else if (rule instanceof CSSStyleRule) {
                // Separate multiple selectors on a rule
                const selectors = rule.selectorText.split(',').map(s => s.trim());

                // We collect all hover and focus rules to be able to later decide which hover rules don't have a matching focus rule
                selectors.forEach(selector => {
                    const isHover = selector.includes(':hover'), isFocus = selector.includes(':focus');
                    if (isHover && isFocus) {
                        // We currently do nothing here. Rules containing both hover and focus are very specific and should never be automatically touched
                    } else if (isHover) {
                        if (!canGenerateDynamicFocusSelector(selector)) {
                            return;
                        }

                        const baseSelector = selector.replace(/:hover/g, PLACEHOLDER).trim();
                        hoverRules.push({ baseSelector, selector, styleText: rule.style.cssText, wrappers: [...wrappers] });
                    } else if (isFocus) {
                        // We need to make sure that we remember all existing :focus, :focus-within and :focus-visible rules
                        const baseSelector = selector.replace(/:focus(-within|-visible)?/g, PLACEHOLDER).trim();
                        focusRules.add(`${baseSelector}|${wrapperSignature(wrappers)}`);
                    }
                });
            } else if (rule instanceof CSSMediaRule) {
                // Recursively process nested @media rules
                processRules(rule.cssRules, [...wrappers, { type: 'media', conditionText: rule.conditionText }]);
            } else if (rule instanceof CSSSupportsRule) {
                // Recursively process nested @supports rules
                processRules(rule.cssRules, [...wrappers, { type: 'supports', conditionText: rule.conditionText }]);
            } else if (typeof window.CSSContainerRule === 'function' && rule instanceof window.CSSContainerRule) {
                // Recursively process nested @container rules (if supported by the browser)
                // Note: conditionText contains the query like "(min-width: 300px)" or "style(color)"
                // Using 'container' as the type ensures uniqueness separate from @media/@supports
                processRules(rule.cssRules, [...wrappers, { type: 'container', conditionText: rule.conditionText }]);
            }
        });
    }

    /**
     * Processes the CSS rules of an imported stylesheet recursively
     * @param {CSSStyleSheet} sheet - The imported stylesheet to process
     * @param {WrapperCond[]} wrappers - Wrapper conditions inherited from (at)import media
     */
    function processImportedStylesheet(sheet, wrappers = []) {
        const rules = getReadableCssRules(sheet);
        if (rules) {
            processRules(rules, wrappers);
        }
    }

    const rules = getReadableCssRules(styleSheet);
    if (!rules) {
        return [];
    }

    processRules(rules, []);

    /** @type {string[]} */
    const generated = [];

    // Now finally create the dynamic focus rules
    hoverRules.forEach(({ baseSelector, selector, styleText, wrappers }) => {
        if (!focusRules.has(`${baseSelector}|${wrapperSignature(wrappers)}`)) {
            // The closest keyboard-equivalent to :hover styling is utilizing the :focus-visible rule from modern browsers.
            // It let's the browser decide whether a focus highlighting is expected and makes sense.
            // So we take all :hover rules that don't have a manually defined focus rule yet, and create their
            // :focus-visible counterpart, which will make the styling work the same for keyboard and mouse.
            // If something like :focus-within or a more specific selector like `.blah:has(:focus-visible)` for elements inside,
            // it should be manually defined in CSS.
            const focusSelector = selector.replace(/:hover/g, ':focus-visible');

            // Skip pseudo-elements (::before, ::after, ::-webkit-scrollbar, etc.)
            // as they cannot have :focus-visible appended (invalid CSS syntax)
            if (focusSelector.includes('::')) {
                return;
            }
            let focusRule = `${focusSelector} { ${styleText} }`;

            // Wrap the generated rule into the same @media/@supports/@container chain (if any)
            if (wrappers.length > 0) {
                // Build nested blocks from outermost to innermost
                // Example: @media (x) { @supports (y) { <rule> } }
                focusRule = wrappers.reduceRight((inner, w) => {
                    if (w.type === 'media') return `@media ${w.conditionText} { ${inner} }`;
                    if (w.type === 'supports') return `@supports ${w.conditionText} { ${inner} }`;
                    if (w.type === 'container') return `@container ${w.conditionText} { ${inner} }`;
                    return inner;
                }, focusRule);
            }

            // Written as one stylesheet text later; the CSS parser drops a rule it cannot
            // parse on its own, as insertRule used to reject it, without affecting the rest.
            generated.push(focusRule);
        }
    });

    return generated;
}

/**
 * Writes every generated rule for one target in a single text update, so the browser
 * parses and invalidates styles once per flush instead of once per inserted rule.
 *
 * @param {object} options - The options object
 * @param {boolean} [options.fromExtension=false] - Indicates whether the rules are coming from extensions
 */
// SillyBunny: write all generated focus rules in one textContent pass instead of per-rule insertRule().
function writeDynamicStyleSheet({ fromExtension = false } = {}) {
    const id = fromExtension ? 'dynamic-extension-styles' : 'dynamic-styles';
    let styleSheetElement = fromExtension ? dynamicExtensionStyleElement : dynamicStyleElement;

    if (!styleSheetElement || !styleSheetElement.isConnected) {
        styleSheetElement = document.createElement('style');
        styleSheetElement.setAttribute('id', id);
        document.head.appendChild(styleSheetElement);
        if (fromExtension) dynamicExtensionStyleElement = styleSheetElement;
        else dynamicStyleElement = styleSheetElement;
    }

    styleSheetElement.textContent = generatedFocusRules[fromExtension ? 'extension' : 'main'].join('\n');
}

function onFirstKeyboardNavigation(event) {
    if (event.key !== 'Tab') return;
    document.removeEventListener('keydown', onFirstKeyboardNavigation, true);
    // Keyboard users need the focus mirrors now, not at the next idle period.
    flushPendingStyleSheets();
}

/**
 * Initializes dynamic styles for ST
 */
export function initDynamicStyles() {
    // SillyBunny: only observe direct children of <head> so <style> textContent writes never wake the observer.
    observer.observe(document.head, {
        childList: true,
        subtree: false,
    });

    // SillyBunny: the initial scan walks every loaded rule, so it waits for idle time
    // (or the first Tab press) instead of blocking startup.
    initialScanPending = true;
    document.addEventListener('keydown', onFirstKeyboardNavigation, true);
    scheduleFlush();
}
