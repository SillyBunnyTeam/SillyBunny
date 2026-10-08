/**
 * SillyBunny sliding subpage stack (feat/v1.9.0-ui-overhaul, Phase 6H).
 *
 * GNOME Settings presents a section as a list of rows; picking one slides a detail page in from the
 * right edge over the list, and the back button slides it out again. This module is that stack, and
 * nothing else: it takes a list page and a detail page, animates between them, and keeps the two
 * scrollers and the focus history in order.
 *
 * Why a stack rather than the accordions it replaces: Backend and Customize panels author their
 * settings as `inline-drawer`s nested up to eleven levels deep (Extensions), four providers' blocks
 * side by side (Connections), or a preset manager taller than the panel (Prompting). Expanding one
 * pushes everything below it off-screen and there is no way back to the section that owned it, so
 * the pages read as one long scroll with no structure. A stack gives every section the full panel
 * height and a single, always-available way back.
 *
 * The markup stays where it is: a detail page moves the section's own subtree into the detail body
 * on open and returns it to its authored position on close. Ids, listeners, jQuery data, and the
 * global lookups extension code performs on these containers all keep working, because the nodes are
 * moved rather than cloned.
 *
 * The transition animates `transform` and `opacity` only, so it stays on the compositor, and it is
 * dropped entirely under `prefers-reduced-motion: reduce`.
 */

/** Marks the stack so the stylesheet can scope to it. */
const SB_SUBPAGE_ATTRIBUTE = 'data-sb-subpage';

/**
 * The authored wrapper holding the panel's sections while they are not on a page.
 *
 * It is kept in the document so the ids inside it keep resolving, but it is out of the layout, so
 * everything inside it measures zero. Anything deciding whether a section has content to show has to
 * stop reading at this boundary.
 */
const SB_SUBPAGE_STORE_CLASS = 'sb-subpage-store';

/** The distance the list recedes by when a detail page covers it, matching GNOME's push. */
const SB_SUBPAGE_LIST_SHIFT = '26%';

/** How long the slide takes, in milliseconds. Matches `--sb-subpage-duration` in the stylesheet. */
const SB_SUBPAGE_DURATION = 260;

/**
 * Whether the slide should be skipped.
 *
 * @returns {boolean}
 */
function prefersReducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * One row in a stack's list page.
 *
 * @typedef {object} SubpageRow
 * @property {string} id stable key, used by {@link SubpageStack#open}
 * @property {string} label the row's title
 * @property {string} [description] the row's second line
 * @property {string} [icon] a Font Awesome class for the row's leading glyph
 * @property {string} [value] trailing text, for a row that reports a current setting
 * @property {() => (HTMLElement|null)} [source] the section to move into the detail page on open
 * @property {() => void} [onOpen] run before the slide, to drive the control the row stands for
 * @property {() => boolean} [isAvailable] whether the row should be shown at all
 */

/**
 * A row set's identity, for telling a real refresh from the observer seeing this stack's own moves.
 *
 * @param {SubpageRow[]} rows
 * @returns {string}
 */
function signatureOf(rows) {
    return rows.map(row => row.id).join('|');
}

/**
 * A list page and a detail page that slide over one another.
 */
export class SubpageStack {
    /**
     * @param {HTMLElement} host the panel the stack is mounted in
     * @param {{title?: string, description?: string, name?: string, onContent?: (content: HTMLElement, row: SubpageRow) => void}} [options]
     */
    constructor(host, options = {}) {
        /** @type {HTMLElement} */
        this.host = host;
        /** @type {SubpageRow[]} */
        this.rows = [];
        /** @type {string} the id signature of the rows currently on the list page */
        this.signature = '';
        /** @type {Map<string, HTMLElement>} the row element per id */
        this.rowElements = new Map();
        /** @type {HTMLElement|null} the section currently moved into the detail page */
        this.moved = null;
        /** @type {{parent: Node, next: Node|null}|null} where it came from */
        this.movedFrom = null;
        /** @type {string|null} */
        this.openRowId = null;
        /** @type {HTMLElement|null} */
        this.lastTrigger = null;
        /** @type {(() => void)|null} teardown hook, set by the panel that mounts the stack */
        this.onDestroy = null;
        /** @type {((content: HTMLElement, row: SubpageRow) => void)|null} runs on each detail page */
        this.onContent = options.onContent ?? null;
        /** @type {(() => ({rows?: object[]}|null))|null} a refresh that arrived while a page was open */
        this.pendingRebuild = null;

        this.root = document.createElement('div');
        this.root.className = 'sb-subpage';
        this.root.setAttribute(SB_SUBPAGE_ATTRIBUTE, options.name ?? 'stack');

        this.list = document.createElement('div');
        this.list.className = 'sb-subpage-list';
        this.list.setAttribute('role', 'list');

        this.listHeading = document.createElement('div');
        this.listHeading.className = 'sb-subpage-list-heading';
        if (options.title) {
            this.listHeading.appendChild(this.buildHeading(options.title, options.description));
        }

        this.listBody = document.createElement('div');
        this.listBody.className = 'sb-subpage-list-body';

        this.list.append(this.listHeading, this.listBody);

        this.detail = document.createElement('div');
        this.detail.className = 'sb-subpage-detail';
        this.detail.setAttribute('aria-hidden', 'true');

        this.detailBar = document.createElement('div');
        this.detailBar.className = 'sb-subpage-detail-bar';

        this.detailTitle = document.createElement('div');
        this.detailTitle.className = 'sb-subpage-detail-title';

        this.detailDescription = document.createElement('small');
        this.detailDescription.className = 'sb-subpage-detail-description';

        this.backButton = document.createElement('button');
        this.backButton.type = 'button';
        this.backButton.className = 'sb-subpage-back';
        this.backButton.innerHTML = '<i class="fa-solid fa-chevron-left" aria-hidden="true"></i>';
        this.backButton.addEventListener('click', () => this.close());

        const detailHeading = document.createElement('div');
        detailHeading.className = 'sb-subpage-detail-heading';
        detailHeading.append(this.detailTitle, this.detailDescription);

        this.detailBar.append(this.backButton, detailHeading);

        this.detailBody = document.createElement('div');
        this.detailBody.className = 'sb-subpage-detail-body';

        this.detail.append(this.detailBar, this.detailBody);

        this.root.append(this.list, this.detail);
        this.host.append(this.root);

        this.onKeyDown = event => {
            if (event.key === 'Escape' && this.isOpen()) {
                event.stopPropagation();
                this.close();
            }
        };
        this.root.addEventListener('keydown', this.onKeyDown);
    }

    /**
     * Builds a two-line heading, the shape every SillyBunny section already uses.
     *
     * @param {string} title
     * @param {string} [description]
     * @returns {HTMLElement}
     */
    buildHeading(title, description) {
        const heading = document.createElement('div');
        heading.className = 'sb-subpage-heading';

        const titleElement = document.createElement('span');
        titleElement.className = 'sb-subpage-heading-title';
        titleElement.textContent = title;
        heading.appendChild(titleElement);

        if (description) {
            const descriptionElement = document.createElement('small');
            descriptionElement.className = 'sb-subpage-heading-description';
            descriptionElement.textContent = description;
            heading.appendChild(descriptionElement);
        }

        return heading;
    }

    /**
     * Replaces the list page's rows.
     *
     * @param {SubpageRow[]} rows
     */
    setRows(rows) {
        this.rows = rows;
        this.signature = signatureOf(rows);
        this.rowElements.clear();
        this.listBody.replaceChildren();

        for (const row of rows) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sb-subpage-row';
            button.setAttribute('role', 'listitem');
            button.dataset.sbSubpageRow = row.id;

            // Descriptions this pass invented are placeholders, marked so the wording pass can list
            // exactly the rows still waiting on human copy instead of reading every panel by hand.
            if (row.placeholder) {
                button.dataset.sbCopyPlaceholder = '';
            }

            if (row.icon) {
                const icon = document.createElement('i');
                icon.className = `sb-subpage-row-icon ${row.icon}`;
                icon.setAttribute('aria-hidden', 'true');
                button.appendChild(icon);
            }

            button.appendChild(this.buildHeading(row.label, row.description));

            const trailing = document.createElement('span');
            trailing.className = 'sb-subpage-row-trailing';

            if (row.value) {
                const value = document.createElement('span');
                value.className = 'sb-subpage-row-value';
                value.textContent = row.value;
                trailing.appendChild(value);
            }

            const chevron = document.createElement('i');
            chevron.className = 'sb-subpage-row-chevron fa-solid fa-chevron-right';
            chevron.setAttribute('aria-hidden', 'true');
            trailing.appendChild(chevron);

            button.appendChild(trailing);
            button.addEventListener('click', () => this.open(row.id));

            this.rowElements.set(row.id, button);
            this.listBody.appendChild(button);
        }

        this.sync();
    }

    /**
     * Shows or hides rows whose section is not currently present.
     *
     * Extensions mount into their containers after the panel is built, so the list is refreshed
     * rather than built once. A row with no `isAvailable` is always shown.
     */
    sync() {
        for (const row of this.rows) {
            const element = this.rowElements.get(row.id);
            if (!element) {
                continue;
            }
            const available = row.isAvailable ? row.isAvailable() : true;
            element.hidden = !available;
        }
    }

    /**
     * Rebuilds the list from a fresh descriptor read.
     *
     * Extensions discovers its rows from the DOM as its containers mount, so the list is refreshed
     * rather than captured once. A refresh that would find the same rows is not a rebuild: the
     * observer sees the moves this stack makes itself, and rebuilding on those would close the page a
     * user just opened. A refresh that does differ is held until the page is put away and re-read
     * then, because a read taken now would miss the section the detail page is holding.
     *
     * @param {{rows?: object[]}|null|(() => ({rows?: object[]}|null))} built rows, or a re-read
     */
    rebuild(built) {
        const read = typeof built === 'function' ? built : () => built;
        const rows = read()?.rows;
        if (!rows?.length) {
            return;
        }

        // Availability is read from the panel rather than from the row set: upstream shows and hides
        // the sections by API, so the same rows can gain and lose content while the list is on screen
        // and the signature never changes.
        this.sync();

        if (signatureOf(rows) === this.signature) {
            return;
        }

        if (this.isOpen()) {
            this.pendingRebuild = read;
            return;
        }

        this.setRows(rows);
    }

    /**
     * Records a teardown hook run by {@link SubpageStack#destroy}.
     *
     * @param {() => void} hook
     */
    observeWith(hook) {
        const previous = this.onDestroy;
        this.onDestroy = () => {
            previous?.();
            hook();
        };
    }

    /**
     * @returns {boolean}
     */
    isOpen() {
        return this.openRowId !== null;
    }

    /**
     * Slides the detail page in over the list.
     *
     * @param {string} rowId
     */
    open(rowId) {
        const row = this.rows.find(candidate => candidate.id === rowId);
        if (!row) {
            return;
        }

        if (this.isOpen() && this.openRowId !== rowId) {
            this.close({ restoreFocus: false, instant: true });
        }

        this.lastTrigger = this.rowElements.get(rowId) ?? null;
        this.openRowId = rowId;

        // A row can stand for a control rather than a section: picking a provider has to move the
        // picker too, or the page a user reads is not the page upstream believes is active. The hook
        // runs before the slide so the detail page's content is already the right one when it lands.
        row.onOpen?.();

        this.detailTitle.textContent = row.label;
        this.detailDescription.textContent = row.description ?? '';
        this.detailDescription.hidden = !row.description;

        const source = row.source?.() ?? null;
        if (source instanceof HTMLElement) {
            // Remember where it sat, so closing puts it back in the same place rather than at the
            // end of its parent: the settings order pass and upstream code both care about order.
            this.movedFrom = { parent: source.parentNode, next: source.nextSibling };
            this.moved = source;
            this.detailBody.appendChild(source);
            source.classList.add('sb-subpage-detail-content');

            // The section is presented by whoever mounts the stack, and it is only in its final
            // place now: a panel defaulting to another provider sits in a subtree upstream hid, and
            // what its headings mean depends on what is above them in the document.
            this.onContent?.(source, row);
        }

        this.root.classList.add('sb-subpage--open');
        this.list.setAttribute('aria-hidden', 'true');
        this.detail.setAttribute('aria-hidden', 'false');

        if (!prefersReducedMotion()) {
            this.detail.classList.remove('sb-subpage-detail--instant');
        } else {
            this.detail.classList.add('sb-subpage-detail--instant');
        }

        // The detail bar scrolls with its own content, so opening starts at the top every time.
        this.detail.scrollTop = 0;
        this.backButton.focus({ preventScroll: true });
    }

    /**
     * Slides the detail page back out and returns any moved section to its authored place.
     *
     * @param {{restoreFocus?: boolean, instant?: boolean}} [options]
     */
    close(options = {}) {
        if (!this.isOpen()) {
            return;
        }

        if (this.moved && this.movedFrom) {
            const { parent, next } = this.movedFrom;
            this.moved.classList.remove('sb-subpage-detail-content');
            if (next && next.parentNode === parent) {
                parent.insertBefore(this.moved, next);
            } else if (parent) {
                parent.appendChild(this.moved);
            }
            this.moved = null;
            this.movedFrom = null;
        }

        this.detailBody.replaceChildren();

        this.openRowId = null;
        this.root.classList.remove('sb-subpage--open');
        this.list.setAttribute('aria-hidden', 'false');
        this.detail.setAttribute('aria-hidden', 'true');

        if (options.instant) {
            this.detail.classList.add('sb-subpage-detail--instant');
        }

        const trigger = this.lastTrigger;
        this.lastTrigger = null;
        if (options.restoreFocus !== false && trigger?.isConnected) {
            trigger.focus({ preventScroll: true });
        }

        // A refresh that arrived while this page was open: the section is back in place now, so the
        // list can be re-read and rebuilt without pulling it out from under anything.
        const pending = this.pendingRebuild;
        this.pendingRebuild = null;
        const rows = pending?.()?.rows;
        if (rows?.length) {
            this.setRows(rows);
        }
    }

    /**
     * Removes the stack and restores anything it moved, so a panel can be torn down cleanly.
     */
    destroy() {
        this.close({ restoreFocus: false, instant: true });
        this.onDestroy?.();
        this.onDestroy = null;        this.root.removeEventListener('keydown', this.onKeyDown);
        this.root.remove();
    }
}

/**
 * Builds a stack inside a panel.
 *
 * @param {HTMLElement} host
 * @param {{title?: string, description?: string, name?: string}} [options]
 * @returns {SubpageStack}
 */
export function createSubpageStack(host, options = {}) {
    return new SubpageStack(host, options);
}

export { SB_SUBPAGE_ATTRIBUTE, SB_SUBPAGE_DURATION, SB_SUBPAGE_LIST_SHIFT, SB_SUBPAGE_STORE_CLASS };
