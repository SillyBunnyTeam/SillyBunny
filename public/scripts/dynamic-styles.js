/** @type {CSSStyleSheet} */
let dynamicStyleSheet = null;
/** @type {CSSStyleSheet} */
let dynamicExtensionStyleSheet = null;
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

    // SillyBunny: adopt deferred style preloads instead of duplicating them — see docs/ui-migration.md
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
            // SillyBunny: share settled readiness across deferred activation and late subscribers — see docs/ui-migration.md
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

    // SillyBunny: replace an already-failed deferred request once; a fresh failure rejects normally — see docs/ui-migration.md
    if (existing?.dataset.sbStyleState === 'error') {
        existing.remove();
        asyncStylesheetPromises.delete(absoluteHref);
        existing = null;
    }

    if (existing) {
        // SillyBunny: identify adopted links for retry cleanup and activate them before awaiting — see docs/ui-migration.md
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

/**
 * An observer that will check if any new stylesheets are added to the head
 * @type {MutationObserver}
 */
const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
        if (mutation.type !== 'childList') return;

        mutation.addedNodes.forEach(node => {
            if (node instanceof HTMLLinkElement && node.tagName === 'LINK' && node.rel === 'stylesheet') {
                node.addEventListener('load', () => {
                    try {
                        applyDynamicFocusStyles(node.sheet);
                    } catch (e) {
                        console.warn('Failed to process new stylesheet:', e);
                    }
                });
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
 * @param {object} [options] - Optional configuration options
 * @param {boolean} [options.fromExtension=false] - Indicates if the styles are from an extension
 */
function applyDynamicFocusStyles(styleSheet, { fromExtension = false } = {}) {
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
        return;
    }

    processRules(rules, []);

    /** @type {CSSStyleSheet} */
    let targetStyleSheet = null;

    // Now finally create the dynamic focus rules
    hoverRules.forEach(({ baseSelector, selector, styleText, wrappers }) => {
        if (!focusRules.has(`${baseSelector}|${wrapperSignature(wrappers)}`)) {
            // Only initialize the dynamic stylesheet if needed
            targetStyleSheet ??= getDynamicStyleSheet({ fromExtension });

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

            try {
                targetStyleSheet.insertRule(focusRule, targetStyleSheet.cssRules.length);
            } catch {
                // insertRule rejects :has() and other complex selectors — these are
                // cosmetic :focus-visible mirrors of :hover rules, safe to skip
            }
        }
    });
}

/**
 * Retrieves the stylesheet that should be used for dynamic rules
 *
 * @param {object} options - The options object
 * @param {boolean} [options.fromExtension=false] - Indicates whether the rules are coming from extensions
 * @return {CSSStyleSheet} The dynamic stylesheet
 */
function getDynamicStyleSheet({ fromExtension = false } = {}) {
    if (fromExtension) {
        if (!dynamicExtensionStyleSheet) {
            const styleSheetElement = document.createElement('style');
            styleSheetElement.setAttribute('id', 'dynamic-extension-styles');
            document.head.appendChild(styleSheetElement);
            dynamicExtensionStyleSheet = styleSheetElement.sheet;
        }
        return dynamicExtensionStyleSheet;
    } else {
        if (!dynamicStyleSheet) {
            const styleSheetElement = document.createElement('style');
            styleSheetElement.setAttribute('id', 'dynamic-styles');
            document.head.appendChild(styleSheetElement);
            dynamicStyleSheet = styleSheetElement.sheet;
        }
        return dynamicStyleSheet;
    }
}

/**
 * Initializes dynamic styles for ST
 */
export function initDynamicStyles() {
    // Start observing the head for any new added stylesheets
    observer.observe(document.head, {
        childList: true,
        subtree: true,
    });

    // Process all stylesheets on initial load
    Array.from(document.styleSheets).forEach(sheet => {
        try {
            applyDynamicFocusStyles(sheet, { fromExtension: sheet.href?.toLowerCase().includes('scripts/extensions') == true });
        } catch (e) {
            console.warn('Failed to process stylesheet on initial load:', e);
        }
    });
}
