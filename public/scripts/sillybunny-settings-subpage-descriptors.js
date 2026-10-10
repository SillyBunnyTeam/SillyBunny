/**
 * SillyBunny subpage descriptors (feat/v1.9.0-ui-overhaul, Phase 6H).
 *
 * `sillybunny-settings-subpage.js` is the stack; this is the part that knows what each panel's rows
 * are. The panels it covers -- Extensions and Prompting -- were the last ones still built out of
 * accordions, so each one is described here as a list of rows and the section each row opens. Agents
 * is presented as a dashboard by its own extension and keeps that layout.
 *
 * Connections is not here. Its backend picker is the axis every one of its settings hangs off, so
 * behind a row it made the only way to change backend an action that wrote global API state, and the
 * page it needed on screen was the picker itself. It is built by hand instead, in
 * `sillybunny-connections-panel.js`.
 *
 * The descriptions are the copy of the page. Sections authored upstream have none, so those are
 * `lorum ipsum` placeholders for the wording pass, marked with `data-sb-copy-placeholder` so the
 * list can be produced with a query rather than by reading the panel.
 */

/** Marks a description that still needs human wording. */
export const SB_SUBPAGE_PLACEHOLDER_ATTRIBUTE = 'data-sb-copy-placeholder';

/** The same placeholder text the settings normalizer uses, so one pass can find both. */
const SB_SUBPAGE_PLACEHOLDER = 'lorum ipsum';

/**
 * Builds the row list for the Extensions panel.
 *
 * The panel hands each extension an `extension_container` and lets it build whatever it likes
 * inside. The list is therefore discovered rather than authored: one row per container that holds
 * something, labelled from the drawer toggle the extension itself built. Containers mount after the
 * panel is built and some mount long after, so the caller refreshes this list on a mutation.
 *
 * @param {HTMLElement} panel
 * @returns {object|null}
 */
export function buildExtensionsSubpage(panel) {
    const body = panel.querySelector('#rm_extensions_block .extensions_block');
    if (!(body instanceof HTMLElement)) {
        return null;
    }

    return {
        rows: collectExtensionRows(body),
        observe: body,
    };
}

/**
 * Collects one row per non-empty extension container.
 *
 * Extensions build their own title, and they do it in two different shapes: most wrap their settings
 * in a drawer the container holds, while a few put the drawer class on the container itself. Both
 * have to be read, because the container's whole text is not a label -- it is the label plus every
 * setting inside it.
 *
 * @param {HTMLElement} body
 * @returns {object[]}
 */
function collectExtensionRows(body) {
    const containers = body.querySelectorAll('#extensions_settings > *, #extensions_settings2 > *');
    const rows = [];

    for (const container of containers) {
        if (!(container instanceof HTMLElement) || isContainerEmpty(container)) {
            continue;
        }

        const label = readExtensionLabel(container);
        if (!label) {
            continue;
        }

        rows.push({
            id: container.id || `extension-${rows.length}`,
            label,
            description: SB_SUBPAGE_PLACEHOLDER,
            placeholder: true,
            icon: 'fa-puzzle-piece',
            source: () => container,
            isAvailable: () => !isContainerEmpty(container),
        });
    }

    return rows;
}

/**
 * Reads the title an extension gave its own container.
 *
 * The title is the text of the drawer's toggle, and specifically of the element the extension used
 * to say its name -- the rest of the toggle is icon glyphs and, in some cases, a help marker the
 * extension appends. Falls back to the toggle's own text when the extension used none of the usual
 * elements, and returns an empty string rather than a paragraph when there is no drawer at all.
 *
 * @param {HTMLElement} container
 * @returns {string}
 */
function readExtensionLabel(container) {
    const drawer = container.classList.contains('inline-drawer')
        ? container
        : container.querySelector('.inline-drawer');
    const toggle = drawer?.querySelector(':scope > .inline-drawer-toggle, :scope > .inline-drawer-header');
    if (!(toggle instanceof HTMLElement)) {
        return '';
    }

    const title = toggle.querySelector(':scope > b, :scope > h3, :scope > h4, :scope > span');
    const source = title instanceof HTMLElement ? title : toggle;

    return readOwnText(source);
}

/**
 * The text an element shows under its own name.
 *
 * A title often carries a help marker -- an anchor wrapping a `?` glyph -- that documents the card
 * rather than naming it. Reading it into the label puts a stray character after the name that the
 * page then repeats in every list row, so links are left out.
 *
 * @param {HTMLElement} element
 * @returns {string}
 */
function readOwnText(element) {
    let text = '';
    for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.nodeValue ?? '';
            continue;
        }
        if (node instanceof HTMLElement && !node.closest('a')) {
            text += node.textContent ?? '';
        }
    }

    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Whether an extension container holds nothing worth a row.
 *
 * `:empty` is not enough: several containers hold whitespace text nodes, and the browser's own
 * `:empty` rule in `extensions-panel.css` only catches the ones with no children at all.
 *
 * @param {HTMLElement} container
 * @returns {boolean}
 */
function isContainerEmpty(container) {
    if (container.childElementCount === 0) {
        return true;
    }
    return container.textContent.replace(/\s+/g, '').length === 0
        && container.querySelector('input, select, textarea, img, canvas, button') === null;
}

/**
 * The descriptor lookup by tab id.
 *
 * @type {Record<string, (panel: HTMLElement) => (object|null)>}
 */
export const SB_SUBPAGE_BUILDERS = Object.freeze({
    extensions: buildExtensionsSubpage,
});

export { SB_SUBPAGE_PLACEHOLDER };
