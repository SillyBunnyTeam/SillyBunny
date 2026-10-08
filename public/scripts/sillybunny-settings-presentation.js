/**
 * SillyBunny settings presentation normalizer (feat/v1.9.0-ui-overhaul, Phase 6G).
 *
 * Backend and Customize mix two kinds of markup:
 *
 * - Sections a SillyBunny panel or the settings order pass authors: `section.sb-settings-category`
 *   holding a two-line heading (a title and a description) above one boxed list. Messages, most of
 *   Appearance, and the Advanced Formatting categories are this shape and already read as
 *   libadwaita.
 * - Sections authored by upstream or by an extension: a bare `h3`/`h4`, or a heading nested in a
 *   baseline row, followed by loose `flex-container` rows with no pill around any of it. That is
 *   Connections, and pieces of Appearance and Interface, which is why those tabs read as flat text
 *   with settings spilling down the page.
 *
 * This pass brings the second shape up to the first: a bare heading becomes a two-line heading, gains
 * a description line if it has none, and the rows that belong to it are gathered into one
 * `.ds-pref-group` pill.
 *
 * Four rules keep the pass safe on markup it does not own:
 *
 * - A `form` is opaque. Upstream builds one per provider and fills it with `h4` field labels, so
 *   nothing inside a form is a section and nothing inside a form is touched. A detail page is the
 *   exception and has its own entry point: it holds one rendered provider form, and that form is
 *   the page's boxed list.
 * - A heading that follows another heading's rows is a field label, not a section. Upstream nests
 *   provider blocks inside a provider section, and the `h4`s in them name fields.
 * - A container that holds sections is not a row. Advanced Formatting is one heading above a drawer
 *   of sections, so its body is left alone and each section is normalized on its own turn.
 * - A panel that designs itself is not passed to this module at all. The sampling panel and the
 *   agents dashboard have layouts of their own, and the four panels converted to sliding subpages
 *   build their own headers, so the caller skips them.
 *
 * Nothing is cloned and nothing moves between sections, so ids, listeners, jQuery data, and the
 * extension lookups that reach into these containers all keep working. The pass is idempotent: a
 * section it has normalized has a pill body and a description, so a second run finds nothing to do.
 */

/**
 * Placeholder description, used where a section has no copy of its own.
 *
 * Every one of these needs human-written text. `data-sb-copy-placeholder` marks them so the wording
 * pass can find them, and the return value lists them per tab.
 */
const SB_PLACEHOLDER_DESCRIPTION = 'lorum ipsum';

/** A two-line heading a SillyBunny panel already authored. */
const SB_MODERN_HEADER_SELECTOR = '.sb-settings-flat-header, .sb-settings-category-header';

/** A bare heading that may name a section. */
const SB_LEGACY_HEADING_SELECTOR = 'h3, h4, .standoutHeader';

/** Any heading, modern or bare. */
const SB_HEADING_ANY_SELECTOR = `${SB_MODERN_HEADER_SELECTOR}, ${SB_LEGACY_HEADING_SELECTOR}`;

/**
 * Sections that name themselves.
 *
 * These are targets in their own right wherever they appear: they carry their own header and body, so
 * the pass never has to guess where their rows start.
 */
const SB_SECTION_SELECTOR = '.sb-settings-flat-section, .sb-settings-category, .sb-settings-subdrawer';

/** A baseline bar that carries a heading beside its own buttons. */
const SB_BAR_SELECTOR = '.flex-container.alignItemsBaseline';

/** A pill. A heading inside one names a block within the pill, not a section. */
const SB_PILL_SELECTOR = '.ds-pref-group';

/** Subtrees this pass never restructures. */
const SB_SKIP_SELECTOR = 'form, [data-sb-presentation="manual"]';

/** Hidden markup has nothing to present. */
const SB_HIDDEN_SELECTOR = '[hidden], .hidden, .displayNone';

/** Controls that make an element a settings row rather than decoration. */
const SB_CONTROL_SELECTOR = 'input, select, textarea, button, .menu_button, toolcool-color-picker';

/**
 * Where a bare heading sits inside a section.
 *
 * Upstream is inconsistent: most sections put the heading first, but a "section bar" shape wraps it
 * in a baseline row beside its own controls, as the Connection Profile header does.
 */
const SB_HEADING_IN_SECTION_SELECTOR = [
    `:scope > ${SB_LEGACY_HEADING_SELECTOR}`,
    `:scope > ${SB_BAR_SELECTOR} > :is(${SB_LEGACY_HEADING_SELECTOR})`,
].join(', ');

/**
 * Headings a section may be wrapped in, deepest match first.
 *
 * A modern heading wraps its text in a column, so the `small` beside the title is a description and
 * must not be read as part of the name; the title element is therefore resolved to the innermost node
 * that holds the name. The `.flex-container` entries cover the authored three-node shape
 * (`header > .flex-container > b` plus its `small`), which is what Prompting and Advanced Formatting
 * build.
 */
const SB_TITLE_SELECTORS = Object.freeze([
    '.sb-settings-category-heading > .sb-settings-category-title',
    '.sb-settings-category-heading > :is(h3, h4)',
    '.sb-settings-category-heading > .flex-container > b',
    '.sb-settings-category-heading > .flex-container > strong',
    '.sb-settings-flat-header > .flex-container > b > span',
    '.sb-settings-flat-header > .flex-container > b',
    '.sb-settings-flat-header > .flex-container > strong',
    '.sb-settings-flat-header > b > span',
    '.sb-settings-flat-header > b',
    '.sb-settings-flat-header > strong',
    ':scope > span',
    ':scope > b',
    ':scope > strong',
]);

/** Things a section title is never taken from: description lines and the controls beside them. */
const SB_TITLE_EXCLUDE_SELECTOR = 'small, .menu_button, button, select, input, textarea, label';

/**
 * Whether a subtree is one this pass must not restructure.
 *
 * @param {HTMLElement} node
 * @returns {boolean}
 */
function isSkipped(node) {
    return node.matches(SB_SKIP_SELECTOR)
        || node.closest(SB_SKIP_SELECTOR) !== null
        || node.matches(SB_HIDDEN_SELECTOR)
        || node.closest(SB_HIDDEN_SELECTOR) !== null;
}

/**
 * Whether a node is a heading, or a bar that carries one.
 *
 * @param {HTMLElement} node
 * @returns {boolean}
 */
function isHeadingCarrier(node) {
    if (node.matches(SB_HEADING_ANY_SELECTOR)) {
        return true;
    }
    return node.matches(SB_BAR_SELECTOR) && node.querySelector(SB_LEGACY_HEADING_SELECTOR) !== null;
}

/**
 * The display text of a title element.
 *
 * @param {HTMLElement} element
 * @returns {string}
 */
function getTitleText(element) {
    return element.textContent.replace(/\s+/g, ' ').trim();
}

/**
 * The element whose text names the section.
 *
 * A description line lives beside the title in the same column, so it is excluded explicitly: the
 * section name must never be read as `Title` plus its own sub-text.
 *
 * @param {HTMLElement} heading
 * @returns {HTMLElement}
 */
function getTitleElement(heading) {
    for (const selector of SB_TITLE_SELECTORS) {
        const found = heading.querySelector(selector);
        if (!(found instanceof HTMLElement)) {
            continue;
        }
        // A `small` is always the description, and a control's text is never a section name; both
        // would otherwise be read back as the title of a section that only has a description.
        if (found.closest(SB_TITLE_EXCLUDE_SELECTOR) !== null || getTitleText(found) === '') {
            continue;
        }
        return found;
    }
    return heading;
}

/**
 * Whether a section's own heading is the one given.
 *
 * @param {HTMLElement} section
 * @param {HTMLElement} heading
 * @returns {boolean}
 */
function isSectionHeading(section, heading) {
    return section === heading
        || section.querySelector(`:scope > ${SB_HEADING_ANY_SELECTOR}`) === heading;
}

/**
 * The heading of a bare section, or null when it has none.
 *
 * @param {HTMLElement} section
 * @returns {HTMLElement|null}
 */
function findHeading(section) {
    return section.querySelector(SB_HEADING_IN_SECTION_SELECTOR);
}

/**
 * The element that owns the rows below a heading.
 *
 * A bare heading in a baseline row keeps its controls beside it in that row and its rows after it,
 * so the walk starts from the row; every other heading's rows are its own siblings.
 *
 * @param {HTMLElement} heading
 * @returns {HTMLElement|null}
 */
function getRowOwner(heading) {
    const parent = heading.parentElement;
    if (!(parent instanceof HTMLElement)) {
        return null;
    }

    const bar = parent.closest(SB_BAR_SELECTOR);
    if (bar instanceof HTMLElement && bar.parentElement instanceof HTMLElement) {
        return bar.parentElement;
    }

    return parent;
}

/**
 * The section a heading names, whether or not it is one already.
 *
 * @param {HTMLElement} heading
 * @returns {HTMLElement|null}
 */
function resolveSection(heading) {
    const authored = heading.closest(SB_SECTION_SELECTOR);
    if (authored instanceof HTMLElement && isSectionHeading(authored, heading)) {
        return authored;
    }
    return getRowOwner(heading);
}

/**
 * Whether a heading that is not a section's own names a field or a block instead.
 *
 * Upstream nests provider blocks inside a provider section and puts an `h4` on each field, and a
 * heading inside a pill names a block of that pill. Both follow a real section heading, and both are
 * labels rather than sections.
 *
 * @param {HTMLElement} heading
 * @param {HTMLElement} owner
 * @returns {boolean}
 */
function isFieldLabel(heading, owner) {
    if (owner.closest(SB_PILL_SELECTOR) !== null) {
        return true;
    }

    // A heading that follows another one's rows belongs to that one's body.
    for (let node = owner.parentElement; node; node = node.parentElement) {
        if (node.matches(SB_SECTION_SELECTOR) || isSectionHeading(node, heading)) {
            break;
        }
        const headingAbove = node.querySelector(`:scope > ${SB_LEGACY_HEADING_SELECTOR}, :scope > ${SB_BAR_SELECTOR} > h3, :scope > ${SB_BAR_SELECTOR} > h4`);
        if (headingAbove instanceof HTMLElement
            && (headingAbove.compareDocumentPosition(owner) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
            return true;
        }
    }

    return false;
}

/**
 * Whether an element reads as a settings row worth boxing.
 *
 * A heading is not a row, and neither is anything that holds sections of its own: a nested section
 * carries its own header and pill and is normalized on its own turn.
 *
 * @param {HTMLElement} node
 * @returns {boolean}
 */
function isRow(node) {
    if (isHeadingCarrier(node) || node.matches('script, style') || isSkipped(node)) {
        return false;
    }
    if (node.matches(SB_SECTION_SELECTOR)) {
        return false;
    }
    if (node.querySelector(`:scope > ${SB_SECTION_SELECTOR}`) !== null) {
        return false;
    }
    return node.matches(SB_CONTROL_SELECTOR) || node.querySelector(SB_CONTROL_SELECTOR) !== null;
}

/**
 * The rows between `start` and the next heading, or the next nested section.
 *
 * @param {HTMLElement} start the element to start after
 * @returns {HTMLElement[]}
 */
function collectRows(start) {
    const rows = [];
    for (let node = start.nextElementSibling; node; node = node.nextElementSibling) {
        if (isHeadingCarrier(node) || node.matches(SB_SECTION_SELECTOR)) {
            break;
        }
        if (isRow(node)) {
            rows.push(node);
        }
    }
    return rows;
}

/**
 * The wrapping ancestors between `node` and `stop`, nearest first.
 *
 * @param {HTMLElement} node
 * @param {HTMLElement} stop
 * @returns {HTMLElement[]}
 */
function collectWrappers(node, stop) {
    const wrappers = [];
    for (let current = node.parentElement; current && current !== stop; current = current.parentElement) {
        wrappers.push(current);
    }
    return wrappers;
}

/**
 * The two-line heading column of a section, built around `heading` when the section has none.
 *
 * The markup matches what a SillyBunny panel builds, so a normalized section and an authored one are
 * the same shape and share one set of styles.
 *
 * The header takes the heading's own slot rather than going to the top of the section. A bare `h3`
 * part-way down a panel titles the rows below it, so moving it would reorder the panel; and a heading
 * inside a baseline bar sits there so the bar's own buttons stay on its right, so the header goes
 * into that bar in place of the heading and the buttons keep their position.
 *
 * @param {HTMLElement} section the element that will hold the header
 * @param {HTMLElement} heading
 * @returns {HTMLElement|null} the column that holds the title and description
 */
function buildHeadingColumn(section, heading) {
    const title = getTitleElement(heading);
    if (getTitleText(title) === '') {
        return null;
    }

    const wrappers = collectWrappers(title, section);
    if (wrappers.length === 0) {
        return null;
    }

    const barIndex = wrappers.findIndex(wrapper => wrapper.matches(SB_BAR_SELECTOR));
    const slot = barIndex > 0 ? wrappers[barIndex - 1] : wrappers[wrappers.length - 1];

    const header = document.createElement('div');
    header.className = 'sb-settings-flat-header sb-settings-category-header';

    const column = document.createElement('div');
    column.className = 'flex-container flexFlowColumn sb-settings-category-heading';
    header.appendChild(column);

    slot.parentElement?.insertBefore(header, slot);

    title.classList.add('sb-settings-category-title');
    column.appendChild(title);

    // A wrapper that held nothing but the title is gone once the title moves; the baseline bar is
    // kept even when it empties, because it is the row the section's buttons live in.
    for (const wrapper of wrappers) {
        if (wrapper.childElementCount === 0 && getTitleText(wrapper) === '' && !wrapper.matches(SB_BAR_SELECTOR)) {
            wrapper.remove();
        }
    }

    return column;
}

/**
 * The description line of a section header, if it already has one.
 *
 * Upstream writes the description in one of two places, and both are searched because the authored
 * three-node header (`header > .flex-container > b + small`) nests it a level deeper than the
 * two-node heading column a SillyBunny panel builds.
 *
 * @param {HTMLElement} header
 * @returns {HTMLElement|null}
 */
function findDescription(header) {
    for (const candidate of header.querySelectorAll('small')) {
        // Copy inside a control (a button's caption, a label's note) is not the section description.
        if (candidate.parentElement?.closest(SB_TITLE_EXCLUDE_SELECTOR) !== null) {
            continue;
        }
        if (candidate.textContent.trim() !== '') {
            return candidate;
        }
    }
    return null;
}

/**
 * The element a description line belongs in: the heading column of a modern header, or the container
 * holding the title when a header was authored as a bare `<b>`/`<span>` inside one.
 *
 * @param {HTMLElement} header
 * @param {HTMLElement} title
 * @returns {HTMLElement}
 */
function getDescriptionHost(header, title) {
    const column = header.querySelector(':scope > .sb-settings-category-heading');
    if (column instanceof HTMLElement) {
        return column;
    }

    const holder = title.parentElement;
    if (holder instanceof HTMLElement && header.contains(holder) && holder !== header) {
        return holder;
    }

    return header;
}

/**
 * Ensures a section has a description line, adding the placeholder when it has none.
 *
 * @param {HTMLElement} section the element the header belongs to
 * @param {HTMLElement} heading the section's heading
 * @returns {string|null} the title that needs copy, or null when it already has a description
 */
function ensureDescription(section, heading) {
    const modern = section.matches(SB_MODERN_HEADER_SELECTOR)
        ? section
        : section.querySelector(`:scope > ${SB_MODERN_HEADER_SELECTOR}`);
    const header = modern ?? buildHeadingColumn(section, heading);
    if (!(header instanceof HTMLElement) || findDescription(header) !== null) {
        return null;
    }

    // The copy is attributed to the header the description lands in, not to the heading that was
    // looked up: a section may be found through a wrapper that has a heading of its own.
    const title = getTitleElement(header);
    const description = document.createElement('small');
    description.textContent = SB_PLACEHOLDER_DESCRIPTION;
    description.dataset.sbCopyPlaceholder = 'true';
    getDescriptionHost(header, title).appendChild(description);

    return getTitleText(title) || null;
}

/**
 * Gathers the rows below a heading into one pill.
 *
 * A single `flex-container` body becomes the pill itself, so a group that already lays its own rows
 * out keeps that layout; a run of loose rows is collected into a new pill so the pill's own row
 * separators apply.
 *
 * @param {HTMLElement} owner the element holding the heading's rows
 * @param {HTMLElement[]} rows the rows to box, in document order
 * @returns {number} how many rows ended up boxed
 */
function boxRows(owner, rows) {
    if (rows.length === 0) {
        return 0;
    }

    if (rows.length === 1 && rows[0].classList.contains(SB_PILL_SELECTOR.slice(1))) {
        return 0;
    }

    let body;
    if (rows.length === 1 && rows[0].classList.contains('flex-container')) {
        body = rows[0];
    } else {
        body = document.createElement('div');
        owner.insertBefore(body, rows[0]);
        for (const row of rows) {
            body.appendChild(row);
        }
    }

    body.classList.add('ds-pref-group', 'sb-settings-category-body');
    return rows.length;
}

/**
 * Normalizes one section, returning what changed.
 *
 * @param {HTMLElement} section
 * @param {HTMLElement} heading
 * @param {string} tabName
 * @returns {{pills: number, placeholder: string|null}}
 */
function normalizeSection(section, heading, tabName) {
    const owner = getRowOwner(heading);
    if (!(owner instanceof HTMLElement)) {
        return { pills: 0, placeholder: null };
    }

    const title = getTitleText(getTitleElement(heading));
    if (title === '' || title === SB_PLACEHOLDER_DESCRIPTION) {
        return { pills: 0, placeholder: null };
    }

    // The rows are read before anything is built, because placing the heading column reparents the
    // title and would invalidate an anchor captured from its old wrapper.
    const anchor = heading.parentElement === owner ? heading : /** @type {HTMLElement} */ (heading.parentElement);
    const rows = collectRows(anchor);

    const missingCopy = ensureDescription(section, heading);
    return {
        pills: boxRows(owner, rows),
        placeholder: missingCopy === null ? null : `${tabName} › ${missingCopy}`,
    };
}

/**
 * Normalizes every section of one settings panel.
 *
 * @param {HTMLElement|null|undefined} scope the tab's panel or container
 * @param {{name?: string}} [options] `name` labels the tab in the placeholder report
 * @returns {{pills: number, placeholders: string[]}} what the pass changed
 */
export function normalizeSettingsPresentation(scope, options = {}) {
    const report = { pills: 0, placeholders: [] };

    if (!(scope instanceof HTMLElement) || isSkipped(scope)) {
        return report;
    }

    const tabName = options.name ?? 'settings';
    const seen = new Set();

    for (const heading of scope.querySelectorAll(SB_HEADING_ANY_SELECTOR)) {
        if (isSkipped(heading)) {
            continue;
        }

        // A heading inside a two-line header is that header's own title. It is reached again on
        // later runs and through the section's header either way, and treating it as a section of
        // its own would wrap the header in a second header.
        if (heading.parentElement?.closest(SB_MODERN_HEADER_SELECTOR) !== null) {
            continue;
        }

        const section = resolveSection(heading);
        if (!(section instanceof HTMLElement) || isSkipped(section) || seen.has(section)) {
            continue;
        }

        // A section that sits inside a pill is a block of that pill, not a section of the panel:
        // the flatten pass leaves nested drawers in place as flat sections, and Messages has one per
        // sub-drawer inside its category bodies. Boxing it would put a pill inside a pill.
        if (section.parentElement?.closest(SB_PILL_SELECTOR) !== null) {
            continue;
        }

        // A section this pass did not author must have the heading as its own first heading, and the
        // heading must not be a field label inside another section.
        if (!section.matches(SB_SECTION_SELECTOR)) {
            if (findHeading(section) !== heading || isFieldLabel(heading, section)) {
                continue;
            }
        }

        seen.add(section);
        const { pills, placeholder } = normalizeSection(section, heading, tabName);
        report.pills += pills;
        if (placeholder !== null) {
            report.placeholders.push(placeholder);
        }
    }

    return report;
}

/**
 * Opens the drawer a detail page names, so the page shows settings rather than a closed card.
 *
 * A detail page opened from a row that named a drawer is that drawer's page: the row carries the
 * card's own title, read from its toggle, and the page draws the card's content directly. The match
 * is what distinguishes the card from an expander inside it -- Advanced Formatting holds a Logit Bias
 * editor and a CFG block, and those stay closed the way the panel had them.
 *
 * When nothing in the section matches, the section is not a card and nothing is opened. An extension
 * that builds its settings without a drawer keeps whatever it drew.
 *
 * @param {HTMLElement} scope the moved section
 * @param {string|undefined} label the label of the row that opened it
 * @returns {HTMLElement|null} the card body the page now shows
 */
function openNamedDrawer(scope, label) {
    const wanted = label?.replace(/\s+/g, ' ').trim();
    if (!wanted) {
        return null;
    }

    for (const drawer of scope.querySelectorAll('.inline-drawer')) {
        const title = readDrawerTitle(drawer);
        if (title !== wanted) {
            continue;
        }
        const toggle = drawer.querySelector(':scope > .inline-drawer-toggle, :scope > .inline-drawer-header');
        const content = drawer.querySelector(':scope > .inline-drawer-content');
        if (toggle instanceof HTMLElement) {
            toggle.hidden = true;
        }
        // Opened the way a click leaves it, inline style and all: the settings shell styles a card
        // body by matching that inline display, so forcing it from CSS would draw the body without
        // the styles the rest of the page's cards get.
        if (content instanceof HTMLElement) {
            content.style.display = 'block';
        }
        drawer.dataset.sbDetailOpened = 'true';
        return content instanceof HTMLElement ? content : null;
    }

    return null;
}

/**
 * Whether a hidden child is the rest of the group its shown sibling belongs to.
 *
 * Tab panels are drawn as siblings that share a class and are revealed one at a time, so the hidden
 * ones belong with the shown one and have to travel into the same pill: otherwise the panel a user
 * switches to falls out of the box that holds the one they started on. A container that is simply
 * hidden -- another API's block, a section upstream emptied -- shares no class with the shown row and
 * is skipped, which is what keeps it out of the group.
 *
 * @param {Element} shown the group's last visible child
 * @param {Element} hidden the child being considered
 * @returns {boolean}
 */
function sharesShape(shown, hidden) {
    if (shown.tagName !== hidden.tagName || shown.classList.length === 0) {
        return false;
    }

    return [...shown.classList].some(name => hidden.classList.contains(name));
}

/**
 * Boxes one opened card body's rows, so an extension's page reads like the Messages tab.
 *
 * An extension writes its card as a list of rows -- a checkbox label, a labelled select, a slider --
 * with no headings between them, which is exactly the shape the row pass boxes when a section has
 * one. There is no heading here to say where a group ends, so the card is one group, except where the
 * extension drew its own divider: an `hr` is the extension saying a group ended, and boxing across it
 * would merge two things it kept apart. A group of one is still a group -- Quick Reply keeps three
 * set lists apart with rules, and each of those lists is a preference pill.
 *
 * Rows are the top level only. A nested block the extension built for itself keeps its own layout.
 *
 * @param {HTMLElement|null} body
 * @returns {number} how many rows were boxed
 */
function boxCardBody(body) {
    if (!(body instanceof HTMLElement) || body.closest(SB_PILL_SELECTOR) !== null) {
        return 0;
    }

    const groups = [];
    let current = [];
    for (const child of body.children) {
        if (child.matches('hr, script, style')) {
            if (current.length > 0) {
                groups.push(current);
            }
            current = [];
            continue;
        }
        if (child.getBoundingClientRect().height === 0) {
            // A hidden branch beside a shown one is usually the rest of a tab set: Extensions and the
            // OpenAI presets both draw their panels as siblings and reveal one at a time. Skipping
            // those would leave the panel a user switches to outside the pill that holds the one they
            // started on, so a hidden sibling of the same shape joins the group rather than breaking
            // it. Anything else hidden is genuinely absent and skipped.
            const previous = current.at(-1);
            if (previous && sharesShape(previous, child)) {
                current.push(child);
            }
            continue;
        }
        // A row the pass above already pilled is a group of its own, and wrapping it again would put
        // a pill inside a pill. Splitting here also keeps the rows around it in their own pill.
        if (child.classList.contains(SB_PILL_SELECTOR.slice(1))) {
            if (current.length > 0) {
                groups.push(current);
            }
            current = [];
            continue;
        }
        current.push(child);
    }
    if (current.length > 0) {
        groups.push(current);
    }

    let boxed = 0;
    for (const group of groups) {
        boxed += boxRows(body, group);
    }

    // The extension's rules sat between rows that are now pills of their own, and a pill boundary
    // already reads as a break. Left in place they would draw a second line in the same gap.
    if (boxed > 0) {
        for (const rule of body.querySelectorAll(':scope > hr')) {
            rule.hidden = true;
        }
    }

    return boxed;
}

/**
 * The title a drawer's toggle displays, read the way the row builder read it.
 *
 * The two have to agree, because the row's label is what the detail page matches against. A help
 * marker the toggle carries is not part of the name, so the text of a link is left out.
 *
 * @param {HTMLElement} drawer
 * @returns {string}
 */
function readDrawerTitle(drawer) {
    const toggle = drawer.querySelector(':scope > .inline-drawer-toggle, :scope > .inline-drawer-header');
    const title = toggle?.querySelector(':scope > b, :scope > h3, :scope > h4, :scope > span') ?? toggle;
    if (!(title instanceof HTMLElement)) {
        return '';
    }

    let text = '';
    for (const node of title.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.nodeValue ?? '';
            continue;
        }
        if (node instanceof HTMLElement && node.closest('a') === null) {
            text += node.textContent ?? '';
        }
    }

    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Boxes the rows of a page the pass above read nothing in.
 *
 * The Presets page is the case that needs this: it is a preset picker, a tab pair, and the panels
 * behind them, with no heading anywhere to say where a group starts or ends -- the blocks a user
 * reads are named by a picker rather than by a title. So the rows are grouped the way the Extensions
 * pages group theirs, one pill at a time, and a divider the page drew still ends a group.
 *
 * The wrappers are descended first, because a block laid out per API keeps exactly one of them on
 * screen, and the rows a page shows are inside that one rather than beside it.
 *
 * @param {HTMLElement} scope the moved section
 * @returns {number} how many rows were boxed
 */
function boxDetailRows(scope) {
    let container = scope;
    for (let depth = 0; depth < 8; depth++) {
        const visible = [...container.children].filter(child => child.getBoundingClientRect().height > 0);
        if (visible.length !== 1 || visible[0].matches('script, style, hr')) {
            break;
        }
        container = visible[0];
    }

    return boxCardBody(container);
}

/**
 * Whether anything in a container would occupy space.
 *
 * A container's upload form is `display: none` inputs and nothing else, and pilling it would draw an
 * empty box under the row that names the page. Measured rather than inspected, so a form whose rows
 * an extension fills in later is not mistaken for an empty one.
 *
 * @param {HTMLElement} container
 * @returns {boolean}
 */
function hasVisibleRow(container) {
    for (const child of container.children) {
        if (child.getBoundingClientRect().height > 0) {
            return true;
        }
    }
    return false;
}

/**
 * Presents one moved detail page.
 *
 * A detail page is a single section in its own page, which changes what counts as a row: the plain
 * pass reads the provider blocks a Connections page holds side by side, but a detail page holds one
 * of them, filled out by one `form` the pass leaves opaque. So the run above is applied to what it
 * can read, and then the rendered form is pilled on its own -- at `h4` boundaries, because a
 * provider's `h4`s name its fields rather than sections of a settings page.
 *
 * What a form's heading means only resolves here, since upstream nests provider blocks inside a
 * provider section and the ancestors that make those `h4`s field labels are gone once the block has
 * moved. Nothing is restructured that the form did not already hold; the pill goes on the form
 * itself, so its own layout is unchanged.
 *
 * Idempotent: the form is found by its lack of a pill, not by a marker.
 *
 * @param {HTMLElement|null|undefined} scope the moved section
 * @param {{name?: string, rowLabel?: string}} [options] `name` labels the tab in the placeholder
 *   report; `rowLabel` is the row that opened it, which names the card inside
 * @returns {{pills: number, placeholders: string[]}} what the pass changed
 */
export function normalizeSettingsDetail(scope, options = {}) {
    const report = normalizeSettingsPresentation(scope, options);
    if (!(scope instanceof HTMLElement)) {
        return report;
    }

    const card = openNamedDrawer(scope, options.rowLabel);
    if (card !== null) {
        report.pills += boxCardBody(card);
    } else {
        report.pills += boxDetailRows(scope);
    }

    for (const form of scope.querySelectorAll('form')) {
        // The form itself is the pill; what must not be pilled is a form that is hidden, belongs to
        // a panel that presents itself, already sits inside a pill, or holds nothing a reader can
        // see -- a container's upload form is three hidden inputs and no row.
        if (form.matches(SB_HIDDEN_SELECTOR) || form.classList.contains('hidden') || form.classList.contains('displayNone')) {
            continue;
        }
        if (form.closest('[data-sb-presentation="manual"]') !== null || form.closest(SB_HIDDEN_SELECTOR) !== null) {
            continue;
        }
        if (form.classList.contains(SB_PILL_SELECTOR.slice(1))) {
            continue;
        }
        if (form.parentElement?.closest(SB_PILL_SELECTOR) !== null) {
            continue;
        }
        if (form.querySelector(SB_CONTROL_SELECTOR) === null && form.childElementCount < 2) {
            continue;
        }
        if (!hasVisibleRow(form)) {
            continue;
        }

        form.classList.add('ds-pref-group', 'sb-settings-category-body');
        report.pills += form.childElementCount;
    }

    return report;
}
