/*
 * Styles of the Page Transition Shade (DESIGN.md Elevation), which only a sliding page carries: a static edge shadow
 * and a dim layer whose opacity alone animates (dialog.js, slidePage). The layer is a viewport tall so it covers a
 * taller covered page; the pages node clips it.
 *
 * The rules live here and not in sillybunny-theme.css because that sheet blocks the first paint and counts against the
 * frontend budget. A slide always runs after this module, so no page paints without them.
 */
const SLIDE_SHADE_CSS = `
.sb-dialog__page.is-sliding {
    box-shadow: 0 0 56px var(--sb-dialog-backdrop);
}

/* The page is position: static while it slides in, so its animated transform is what makes it this layer's containing
   block. Do not add position: relative to the page: it ties with .is-leaving on specificity and would win by source order. */
.sb-dialog__page.is-sliding::before {
    content: '';
    position: absolute;
    inset-block-start: 0;
    inset-inline-end: 100%;
    inline-size: 100%;
    block-size: 100dvh;
    background: var(--sb-dialog-backdrop);
    opacity: 0;
    pointer-events: none;
}
`;

const FALLBACK_ATTRIBUTE = 'data-sb-slide-shade';

/** @type {WeakMap<Document, CSSStyleSheet | HTMLStyleElement>} */
const installed = new WeakMap();

function isStillInstalled(doc, installedStyle) {
    if (!installedStyle) return false;
    return installedStyle instanceof doc.defaultView.HTMLStyleElement
        ? installedStyle.isConnected
        : doc.adoptedStyleSheets.includes(installedStyle);
}

function adoptSheet(doc) {
    const { CSSStyleSheet: Sheet } = doc.defaultView;
    if (typeof Sheet !== 'function' || doc.adoptedStyleSheets === undefined) return null;
    try {
        const sheet = new Sheet();
        sheet.replaceSync(SLIDE_SHADE_CSS);
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
        return sheet;
    } catch {
        return null;
    }
}

function appendStyleElement(doc) {
    const style = doc.createElement('style');
    style.setAttribute(FALLBACK_ATTRIBUTE, '');
    style.textContent = SLIDE_SHADE_CSS;
    doc.head.append(style);
    return style;
}

/**
 * Adds the shade rules to the document once. Adding them changes the document's styles, which restyles it, so the
 * call that matters runs when this module loads and any later call only checks that the rules are still there.
 * @param {Document} [doc]
 */
export function installSlideShade(doc = document) {
    if (isStillInstalled(doc, installed.get(doc))) return;
    installed.set(doc, adoptSheet(doc) ?? appendStyleElement(doc));
}

if (typeof document !== 'undefined') installSlideShade();
