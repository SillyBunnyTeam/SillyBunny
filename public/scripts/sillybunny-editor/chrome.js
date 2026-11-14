// SillyBunny: shared header and toolbar chrome for the scrolling-sheet editors.
// Owns the header order, header button wiring and tooltips, Save/Cancel/dirty
// presentation, the token readout and its phone placement, inline title
// rename, toolbar overflow into the More menu, mobile scroll-hide, and the
// draft-recovery toast. Menu contents, token counts, and any entity logic
// stay with each editor.

/* global moment */
import { openActionMenu, closeActionMenu, isActionMenuOpen } from '../sillybunny-action-menu.js';
import { t } from '../i18n.js';
import { animateIn, animateOut, MOTION_EASE_OUT_QUAD, MOTION_FAST, prefersReducedMotion } from '../sillybunny-motion.js';

/**
 * @typedef {{ label: string, icon: string, onSelect: () => void, danger?: boolean }} ActionItem
 * @typedef {{ items: ActionItem[] }} ActionSection
 */

/**
 * @typedef {object} ChromeState
 * @property {'create'|'edit'} mode
 * @property {boolean} dirty
 * @property {boolean} [saving]
 * @property {string} title
 * @property {boolean} [canCreate]  Create mode only: whether Create is allowed (default true).
 * @property {string} [saveLabel]  Replaces the Create/Save label, for an editor whose primary action is always Save.
 */

/**
 * @typedef {object} TokenCount
 * @property {string|number} total
 * @property {string|number} [permanent]  The part of the total that is always sent; shown in the header form only.
 * @property {boolean} [overBudget]  Shows the context warning on the readout.
 */

/**
 * The unsaved mark every editor header shows: an 8px accent dot, announced as "Unsaved changes".
 * @param {string} [className]  The editor's own class, kept so existing queries still find it.
 * @returns {HTMLSpanElement}
 */
export function createDirtyMark(className = '') {
    const mark = document.createElement('span');
    mark.className = `sb-editor-dirty ${className}`.trim();
    mark.setAttribute('role', 'status');
    mark.setAttribute('aria-live', 'polite');
    mark.setAttribute('aria-label', t`Unsaved changes`);
    mark.hidden = true;
    const dot = document.createElement('span');
    dot.className = 'sb-editor-dirty-dot';
    dot.setAttribute('aria-hidden', 'true');
    mark.append(dot);
    return mark;
}

/**
 * The header's token readout for an editor that has none in its markup: the value and, when `warning` is given, the
 * context-warning link the character editor carries.
 * @param {{ warning?: { href: string, title: string }|null }} [options]
 * @returns {HTMLSpanElement}
 */
export function createTokenReadout({ warning = null } = {}) {
    const readout = document.createElement('span');
    readout.className = 'sb-editor-tokens';
    readout.title = t`Token counts may be inaccurate and provided just for reference.`;
    readout.hidden = true;
    if (warning) {
        const link = document.createElement('a');
        link.className = 'sb-editor-tokens__warning';
        link.href = warning.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = warning.title;
        const glyph = document.createElement('i');
        glyph.className = 'fa-solid fa-triangle-exclamation';
        glyph.setAttribute('aria-hidden', 'true');
        link.append(glyph);
        readout.append(link);
    }
    const value = document.createElement('span');
    value.className = 'sb-editor-tokens__value';
    readout.append(value);
    return readout;
}

/**
 * Wraps a property-summary button in the row that also holds the phone token count, in place when it is mounted.
 * @param {HTMLElement|null} [summary]  Omitted for an item that has no properties but still has a count.
 * @returns {HTMLDivElement}
 */
export function createSummaryRow(summary = null) {
    const row = document.createElement('div');
    row.className = 'sb-editor-summary-row';
    if (!summary) return row;
    summary.classList.add('sb-editor-summary');
    summary.replaceWith?.(row);
    row.append(summary);
    return row;
}

/**
 * Writes the text of a property-summary button and names the button `<label>: <text>`, so that its accessible name contains
 * the text that is on screen (WCAG 2.5.3, Label in Name).
 * @param {HTMLElement} summary
 * @param {string} label  What the summary opens ("Persona", "Prompt properties").
 * @param {string} text  The visible text.
 */
export function setSummaryText(summary, label, text) {
    summary.textContent = text;
    summary.setAttribute('aria-label', `${label}: ${text}`);
}

/**
 * Puts a field's control at the inline end of its label row: the group header that holds the field's heading, or the
 * label row of a text-area field (`createTextAreaField` in rows.js), which already carries its own Expand.
 * @param {HTMLElement} section  The group's `.sb-editor-section`, or the text-area field's row.
 * @param {HTMLElement} control
 * @returns {boolean} False when there is no label row.
 */
export function attachToLabelRow(section, control) {
    const row = section.querySelector(':scope > .ds-pref-group-header, :scope > .sb-editor-label-row');
    if (!row) return false;
    row.classList.add('sb-editor-label-row');
    row.append(control);
    return true;
}

/**
 * @param {object} config
 * @param {HTMLElement} config.root  Editor root; overflow candidates resolve inside it.
 * @param {HTMLElement} config.header
 * @param {HTMLElement|null} [config.toolbar]  Optional; header-only editors (list detail panes) omit it.
 * @param {HTMLElement} config.content  The scrolling sheet body.
 * @param {{ back: HTMLElement, cancel: HTMLButtonElement, save: HTMLButtonElement, title: HTMLElement,
 *     titleButton?: HTMLButtonElement|null, dirty: HTMLElement, more?: HTMLElement|null,
 *     modes?: HTMLElement[] }} config.controls
 *     `more` is the item menu; it is moved into the header when it is not there. `modes` are the Edit/Preview controls.
 *     The header is reordered to Back, title, dirty mark, token readout, Edit/Preview, item menu, Cancel, Save.
 * @param {{ element?: HTMLElement|null, row?: { host: HTMLElement, before?: Element|null }|null }|null} [config.tokens]
 *     The editor shows a token readout: `element` is its header node (one is built when absent), and `row` is where the
 *     phone form goes, as a dimmed Caption in the second row. Omit it for an editor that counts nothing.
 * @param {(event: Event) => void} config.onBack
 * @param {() => void} config.onCancel
 * @param {() => void} config.onSave
 * @param {{ getValue: () => string, commit: (value: string) => void, onFinish?: (value: string) => void }} [config.rename]
 *     Inline title rename. The title button is only enabled while the state's mode is 'edit'.
 * @param {string[]} [config.overflowCandidates]  Toolbar selectors that may collapse into More, most expendable first.
 * @param {() => ActionSection[]} [config.getActionSections]  More-menu contents, built on every open.
 * @param {string|(() => string)} [config.actionMenuTitle]  A function defers translation to menu-open time.
 * @param {string} [config.itemMenuLabel]  Tooltip and accessible name of the item menu button, named by what it holds
 *     ("Character Actions").
 * @param {() => boolean} [config.isActive]  Skips layout work while the editor is off screen.
 * @param {boolean} [config.scrollHide=true]  Hide the chrome on mobile while scrolling down.
 * @returns {{ render: (state: ChromeState) => void, setTokens: (count: TokenCount|null) => void, scheduleOverflow: () => void, reset: () => void, dispose: () => void }}
 *     Call `dispose()` before discarding chrome whose header is rebuilt (e.g. per-entry detail panes).
 */
export function mountEditorChrome(config) {
    const {
        root,
        header,
        toolbar = null,
        content,
        controls,
        tokens: tokenConfig = null,
        onBack,
        onCancel,
        onSave,
        rename = null,
        overflowCandidates = [],
        getActionSections = () => [],
        actionMenuTitle = '',
        itemMenuLabel = '',
        isActive = () => true,
        scrollHide = true,
    } = config;

    const abort = new AbortController();
    const { signal } = abort;
    const chromeParts = [header, toolbar].filter(Boolean);

    // Tooltip extensions move title elsewhere; action names must survive that move.
    for (const control of root.querySelectorAll('.sb-editor-icon-button, .editor_maximize, .sb-editor-tokens__warning')) {
        if (!control.hasAttribute('aria-label')) {
            const title = control.getAttribute('title') ?? control.getAttribute('data-sttt--title');
            if (title) control.setAttribute('aria-label', title.split('\n')[0]);
        }
        for (const glyph of control.querySelectorAll('.fa-solid')) glyph.setAttribute('aria-hidden', 'true');
    }
    for (const link of root.querySelectorAll('.ds-field-header > .notes-link')) {
        const label = link.parentElement.querySelector('label');
        if (label) link.setAttribute('aria-label', label.textContent.trim());
        for (const glyph of link.children) glyph.setAttribute('aria-hidden', 'true');
    }
    for (const button of root.querySelectorAll('[data-sb-avatar-input]')) {
        button.addEventListener('click', () => document.getElementById(button.dataset.sbAvatarInput)?.click(), { signal });
    }

    // Back's tooltip is libadwaita's back button fallback; Back keeps each editor's own accessible name.
    if (controls.back) controls.back.title = t`Back`;
    if (controls.more && itemMenuLabel) {
        controls.more.title = itemMenuLabel;
        controls.more.setAttribute('aria-label', itemMenuLabel);
    }
    controls.cancel.title = t`Cancel`;

    const readout = tokenConfig ? (tokenConfig.element ?? createTokenReadout()) : null;
    const readoutValue = readout?.querySelector('.sb-editor-tokens__value') ?? null;
    const readoutWarning = readout?.querySelector('.sb-editor-tokens__warning') ?? null;
    /** The phone form of the readout: the short count, with the full count in its accessible name. */
    let rowReadout = null;
    let rowValue = null;
    let rowWarning = null;
    if (readout && tokenConfig?.row?.host) {
        rowReadout = document.createElement('span');
        rowReadout.className = 'sb-editor-tokens sb-editor-tokens--row';
        rowReadout.title = readout.title;
        rowReadout.setAttribute('role', 'group');
        rowReadout.hidden = true;
        if (readoutWarning) {
            rowWarning = /** @type {HTMLElement} */ (readoutWarning.cloneNode(true));
            rowWarning.removeAttribute('id');
            rowReadout.append(rowWarning);
        }
        rowValue = document.createElement('span');
        rowValue.className = 'sb-editor-tokens__value';
        rowValue.setAttribute('aria-hidden', 'true');
        rowReadout.append(rowValue);
        tokenConfig.row.host.insertBefore(rowReadout, tokenConfig.row.before ?? null);
    }

    // The header order lives here: Back, title, unsaved mark, token readout, Edit/Preview, item menu, Cancel, Save.
    if (controls.more && !header.contains(controls.more)) header.append(controls.more);
    if (readout && !header.contains(readout)) header.append(readout);
    const headerChild = (node) => {
        let child = node ?? null;
        while (child && child.parentElement !== header) child = child.parentElement;
        return child;
    };
    for (const node of [controls.back, controls.titleButton ?? controls.title, controls.dirty, readout, ...(controls.modes ?? []), controls.more, controls.cancel, controls.save]) {
        const child = headerChild(node);
        if (child) header.append(child);
    }

    /** @type {Array<{ label: string, icon: string, element: HTMLElement }>} */
    let collapsed = [];
    /** @type {ChromeState|null} */
    let lastState = null;

    controls.back.addEventListener('click', onBack, { signal });
    controls.cancel.addEventListener('click', () => onCancel(), { signal });
    controls.save.addEventListener('click', () => onSave(), { signal });
    if (rename && controls.titleButton) {
        controls.titleButton.addEventListener('click', startRename, { signal });
    }

    controls.more?.addEventListener('click', () => {
        if (controls.more.getAttribute('aria-expanded') === 'true') {
            closeActionMenu({ restoreFocus: true });
            return;
        }
        openMoreMenu();
    }, { signal });

    // ------------------------------------------------------------------
    // State presentation
    // ------------------------------------------------------------------

    /** @param {ChromeState} state */
    function render(state) {
        lastState = state;
        const isCreate = state.mode === 'create';

        controls.title.textContent = state.title;
        if (controls.titleButton) {
            // Renaming a draft is meaningless until it exists.
            const canRename = Boolean(rename) && !isCreate;
            controls.titleButton.disabled = !canRename;
            controls.titleButton.classList.toggle('is-static', !canRename);
        }

        controls.save.textContent = state.saveLabel ?? (isCreate ? t`Create` : t`Save`);
        controls.save.title = controls.save.textContent;
        controls.save.disabled = Boolean(state.saving)
            || (isCreate ? state.canCreate === false : !state.dirty);
        controls.cancel.disabled = !state.dirty;

        const wasHidden = controls.dirty.hidden;
        if (!state.dirty) {
            if (wasHidden) return;
            if (prefersReducedMotion()) {
                controls.dirty.hidden = true;
                return;
            }
            animateOut(controls.dirty, [{ opacity: 1 }, { opacity: 0 }], () => {
                controls.dirty.hidden = true;
            }, { duration: MOTION_FAST, easing: MOTION_EASE_OUT_QUAD });
            return;
        }

        controls.dirty.hidden = false;
        if (wasHidden) {
            if (prefersReducedMotion()) return;
            animateIn(controls.dirty,
                [{ opacity: 0, transform: 'scale(0.7)' }, { opacity: 1, transform: 'none' }],
                { duration: MOTION_FAST, easing: MOTION_EASE_OUT_QUAD },
            );
        }
    }

    /**
     * Shows the item's token count in the header readout and, when the editor gave a second-row host, in its phone
     * form. CSS decides which one is visible. The count can change the toolbar's width, so the overflow pass reruns.
     * @param {TokenCount|null} count  `null`, or an empty total, hides the readout.
     */
    function setTokens(count) {
        if (!readout) return;
        const total = count ? String(count.total ?? '').trim() : '';
        const visible = total !== '';
        readout.hidden = !visible;
        if (rowReadout) rowReadout.hidden = !visible;
        if (visible) {
            const permanent = String(count.permanent ?? '').trim();
            const brief = `${total} ${t`Tokens`}`;
            const full = permanent ? `${brief} (${permanent} ${t`Permanent`})` : brief;
            const overBudget = Boolean(count.overBudget);
            if (readoutValue) readoutValue.textContent = full;
            if (rowValue) rowValue.textContent = brief;
            rowReadout?.setAttribute('aria-label', full);
            for (const node of [readout, rowReadout]) node?.classList.toggle('is-over-budget', overBudget);
            for (const link of [readoutWarning, rowWarning]) if (link instanceof HTMLElement) link.style.display = overBudget ? '' : 'none';
        }
        if (toolbar) scheduleOverflow();
    }

    // ------------------------------------------------------------------
    // Inline rename
    // ------------------------------------------------------------------

    /**
     * Swaps the title button for a text input. Enter or blur commits, Escape
     * cancels. The editor's commit writes the name field, so the rename is a
     * normal unsaved edit like any other.
     */
    function startRename(event) {
        event.preventDefault();
        const titleButton = controls.titleButton;
        if (!rename || !titleButton || titleButton.disabled) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = rename.getValue();
        input.id = `${titleButton.id.replace(/_button$/, '')}_input`;
        input.className = 'sb-editor-title-input';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', t`Rename`);

        // Swapping the input out of the DOM fires blur, so Enter/Escape would
        // otherwise commit a second time and Escape would end up saving.
        let finished = false;
        const finish = (commit, restoreFocus) => {
            if (finished) return;
            finished = true;
            const value = input.value.trim();
            if (commit && value && value !== rename.getValue()) rename.commit(value);
            const finalValue = rename.getValue();
            rename.onFinish?.(finalValue);
            input.replaceWith(titleButton);
            if (lastState) render({ ...lastState, title: finalValue || lastState.title });
            if (restoreFocus) titleButton.focus();
        };

        input.addEventListener('blur', () => finish(true, false));
        input.addEventListener('keydown', (e) => {
            if (e.isComposing) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                finish(true, true);
            } else if (e.key === 'Escape') {
                // Keep the editor's own Escape-to-close from also handling this key.
                e.preventDefault();
                e.stopPropagation();
                finish(false, true);
            }
        });

        titleButton.replaceWith(input);
        input.focus();
        input.select();
    }

    // ------------------------------------------------------------------
    // Toolbar overflow
    // ------------------------------------------------------------------

    /**
     * The toolbar is nowrap with overflow hidden, so without this the trailing
     * buttons (More included) are clipped off a narrow panel. Collapsed buttons
     * are hidden by class only, keeping any inline display the editor set, and
     * the menu forwards a click to them, so no handler or ID moves.
     */
    function applyOverflow() {
        if (!toolbar) return;
        const elements = overflowCandidates
            .map(selector => root.querySelector(selector))
            .filter(element => element instanceof HTMLElement);

        for (const element of elements) element.classList.remove('sb-editor-toolbar-collapsed');
        collapsed = [];

        if (toolbar.scrollWidth <= toolbar.clientWidth + 1) return;

        for (const element of /** @type {HTMLElement[]} */ (elements)) {
            // A hidden button (create mode hides several) takes no width.
            if (element.getBoundingClientRect().width === 0) continue;

            // Tooltips can carry a second line of usage hints; the menu takes the first.
            const tooltip = element.getAttribute('title') ?? element.getAttribute('data-sttt--title');
            const label = tooltip?.split('\n')[0]?.trim() || element.getAttribute('aria-label') || '';
            const glyph = Array.from(element.classList).find(cls => cls.startsWith('fa-') && cls !== 'fa-solid') ?? 'fa-circle-dot';

            element.classList.add('sb-editor-toolbar-collapsed');
            collapsed.push({ label, icon: `fa-solid ${glyph}`, element });

            if (toolbar.scrollWidth <= toolbar.clientWidth + 1) break;
        }
    }

    let overflowScheduled = false;
    /** Measures real widths, so it waits for the browser to lay the panel out. */
    function scheduleOverflow() {
        if (overflowScheduled) return;
        overflowScheduled = true;
        requestAnimationFrame(() => {
            overflowScheduled = false;
            if (!signal.aborted && isActive()) applyOverflow();
        });
    }

    /** @type {ResizeObserver|null} */
    let resizeObserver = null;
    // Header-only chrome has nothing to collapse.
    if (toolbar && typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(scheduleOverflow);
        resizeObserver.observe(root);
    } else if (toolbar) {
        window.addEventListener('resize', scheduleOverflow, { signal });
    }

    function openMoreMenu() {
        if (!controls.more) return;
        const overflow = collapsed.map(({ label, icon, element }) => ({
            label,
            icon,
            onSelect: () => element.click(),
        }));
        const sections = [{ items: overflow }, ...getActionSections()]
            .filter(section => section.items.length > 0);

        openActionMenu({
            trigger: controls.more,
            title: typeof actionMenuTitle === 'function' ? actionMenuTitle() : actionMenuTitle,
            sections,
            onClose: () => controls.more.setAttribute('aria-expanded', 'false'),
        });
        controls.more.setAttribute('aria-expanded', 'true');
    }

    // ------------------------------------------------------------------
    // Mobile scroll-hide
    // ------------------------------------------------------------------

    const mobile = window.matchMedia('(pointer: coarse), (max-width: 620px)');
    let lastScrollY = content.scrollTop;
    let distance = 0;
    let ticking = false;
    let settleUntil = 0;

    const setChromeHidden = (hidden) => {
        const changed = header.classList.contains('sb-editor-chrome-hidden') !== hidden;
        for (const part of chromeParts) part.classList.toggle('sb-editor-chrome-hidden', hidden);
        // Collapsing at the bottom can clamp scrollTop on every frame of the
        // 200ms transition; don't read that as a user scroll the other way.
        if (changed) settleUntil = performance.now() + 250;
        lastScrollY = content.scrollTop;
        distance = 0;
    };
    const showChrome = () => setChromeHidden(false);

    mobile.addEventListener('change', showChrome);
    for (const part of chromeParts) part.addEventListener('focusin', showChrome, { signal });

    if (scrollHide) content.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
            ticking = false;
            const currentY = Math.max(0, content.scrollTop);
            const delta = currentY - lastScrollY;
            lastScrollY = currentY;

            if (currentY > content.scrollHeight - content.clientHeight) return;
            if (!mobile.matches || currentY <= 60) {
                setChromeHidden(false);
                return;
            }
            if (!delta || performance.now() < settleUntil) return;
            distance = Math.sign(delta) === Math.sign(distance) ? distance + delta : delta;
            if (Math.abs(distance) < 8) return;
            if (isActionMenuOpen() || chromeParts.some(part => part.querySelector(':focus-visible'))) return;
            setChromeHidden(distance > 0);
        });
    }, { passive: true, signal });

    function dispose() {
        // The More menu is body-mounted; its actions would outlive this header.
        if (controls.more && isActionMenuOpen(controls.more)) closeActionMenu({ animate: false, restoreFocus: false });
        abort.abort();
        mobile.removeEventListener('change', showChrome);
        resizeObserver?.disconnect();
        resizeObserver = null;
        rowReadout?.remove();
    }

    return {
        render,
        setTokens,
        scheduleOverflow,
        /**
         * Reveal the header and toolbar; call when a session opens.
         * @param {{ scrollToTop?: boolean }} [options] Start a different entity at the top of the shared sheet.
         */
        reset({ scrollToTop = false } = {}) {
            if (scrollToTop) content.scrollTop = 0;
            showChrome();
        },
        dispose,
    };
}

/** @type {JQuery|null} */
let recoveryToast = null;
let recoveryToastOwner = null;

/**
 * The draft-recovery toast both editors show when a session opens over a
 * stored backup that differs from the saved entity.
 * @param {{ ts: number }} draft
 * @param {{ restore: () => void, discard: () => void }} actions
 * @param {string|null} [owner] Entity-scoped owner for selective dismissal.
 */
export function showDraftRecoveryToast(draft, actions, owner = null) {
    if (recoveryToast) toastr.clear(recoveryToast, { force: true });

    const when = typeof moment !== 'undefined' ? moment(draft.ts).fromNow() : new Date(draft.ts).toLocaleTimeString();
    const body = `<div>${t`Unsaved changes were made ${when}`}</div>
        <div class="sb-draft-toast__actions">
            <button type="button" id="sb_draft_restore_btn" class="menu_button">${t`Restore`}</button>
            <button type="button" id="sb_draft_discard_btn" class="menu_button">${t`Discard`}</button>
        </div>`;

    const toast = toastr.info(body, '', {
        timeOut: 0,
        extendedTimeOut: 0,
        closeButton: true,
        escapeHtml: false,
        onHidden: () => {
            if (recoveryToast !== toast) return;
            recoveryToast = null;
            recoveryToastOwner = null;
        },
    });
    recoveryToast = toast;
    recoveryToastOwner = owner;

    const dismiss = () => toastr.clear(toast, { force: true });
    toast.find('#sb_draft_restore_btn').on('click', () => {
        actions.restore();
        dismiss();
    });
    toast.find('#sb_draft_discard_btn').on('click', () => {
        actions.discard();
        dismiss();
    });
}

/** Dismisses the recovery toast, optionally only when its entity owner matches. */
export function dismissDraftRecoveryToast(owner = null) {
    if (owner !== null && recoveryToastOwner !== owner) return;
    if (recoveryToast) toastr.clear(recoveryToast, { force: true });
    recoveryToast = null;
    recoveryToastOwner = null;
}
