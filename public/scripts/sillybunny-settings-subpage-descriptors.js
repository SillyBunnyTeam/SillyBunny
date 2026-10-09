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

import { SB_SUBPAGE_STORE_CLASS } from './sillybunny-settings-subpage.js';

/** Marks a description that still needs human wording. */
export const SB_SUBPAGE_PLACEHOLDER_ATTRIBUTE = 'data-sb-copy-placeholder';

/** The same placeholder text the settings normalizer uses, so one pass can find both. */
const SB_SUBPAGE_PLACEHOLDER = 'lorum ipsum';

/**
 * Builds the row list for the Prompting panel.
 *
 * The panel is three column blocks: the preset manager, the generation settings, and the advanced
 * configuration. Each is one page. Samplers are not one of them, because the Sampling tab presents
 * those controls itself and moves them into its own cards.
 *
 * @param {HTMLElement} panel
 * @returns {object|null}
 */
export function buildPromptingSubpage(panel) {
    const root = panel.querySelector('#ai_response_configuration');
    if (!(root instanceof HTMLElement)) {
        return null;
    }

    const specs = [
        ['presets', '#respective-presets-block', 'Presets', 'Preset prompts, prompt manager, and the chat preset picker.'],
        ['generation', '#common-gen-settings-block', 'Generation Settings', SB_SUBPAGE_PLACEHOLDER],
        ['advanced', '#advanced-ai-config-block', 'Advanced Configuration', SB_SUBPAGE_PLACEHOLDER],
    ];

    const rows = [];
    for (const [id, selector, label, description] of specs) {
        const block = root.querySelector(selector);
        if (!(block instanceof HTMLElement)) {
            continue;
        }
        rows.push({
            id,
            label,
            description,
            placeholder: description === SB_SUBPAGE_PLACEHOLDER,
            source: () => block,
            // A block upstream has hidden for the active API has nothing to show, so its row hides
            // with it rather than opening an empty page. Measuring the block is not enough on its
            // own: it is laid out every moment the panel is on screen and reads at its full height
            // while another tab is shown, so the controls inside are what says whether there is
            // anything to open.
            isAvailable: () => hasVisibleContent(block),
        });
    }

    return { rows };
}

/**
 * Whether a block still has anything to show.
 *
 * Two things empty a Prompting block without removing it: upstream hides the whole block for APIs
 * that do not use it, and the Sampling panel moves the sampler controls it presents into cards of
 * its own, leaving the block that used to hold them present but bare. A row pointing at either would
 * open a blank page, so a block counts as available only when something inside it renders.
 *
 * Nothing inside the store can be measured: that wrapper is kept in the document for its ids but is
 * out of the layout, so every rect within it reads zero, and so does its own display. The read
 * therefore walks each control's ancestors for a hidden one and stops at the store, leaving the
 * panel's own visibility -- which only says whether the tab is on screen -- out of the answer.
 *
 * @param {HTMLElement} block
 * @returns {boolean}
 */
function hasVisibleContent(block) {
    if (isHiddenWithinPanel(block)) {
        return false;
    }

    for (const control of block.querySelectorAll('input, select, textarea, button')) {
        if (control.closest('[data-sb-sampling-control]')) {
            continue;
        }

        if (block.getBoundingClientRect().height > 0 && control.getBoundingClientRect().height > 0) {
            return true;
        }

        if (!isHiddenWithinPanel(control)) {
            return true;
        }
    }

    return false;
}

/**
 * Whether an element or one of its ancestors within the panel has been hidden.
 *
 * The walk stops at the store's direct children. Those are the elements the wrapper itself hides, and
 * they are not part of the page a user ever sees, so reading them would report every block as hidden.
 * What it looks at is the markup below them, where the display rules are upstream's own.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
function isHiddenWithinPanel(element) {
    for (let node = element; node instanceof HTMLElement; node = node.parentElement) {
        if (node.parentElement?.classList.contains(SB_SUBPAGE_STORE_CLASS)) {
            return false;
        }

        if (getComputedStyle(node).display === 'none') {
            return true;
        }
    }

    return false;
}

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
    prompting: buildPromptingSubpage,
    extensions: buildExtensionsSubpage,
});

export { SB_SUBPAGE_PLACEHOLDER };
