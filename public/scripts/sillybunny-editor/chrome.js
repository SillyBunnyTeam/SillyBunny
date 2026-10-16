// SillyBunny: shared header and toolbar chrome for the scrolling-sheet editors.
// Owns header button wiring, Save/Cancel/dirty presentation, inline title
// rename, toolbar overflow into the More menu, mobile scroll-hide, and the
// draft-recovery toast. Menu contents, token readouts, and any entity logic
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
 */

/**
 * @param {object} config
 * @param {HTMLElement} config.root  Editor root; overflow candidates resolve inside it.
 * @param {HTMLElement} config.header
 * @param {HTMLElement} config.toolbar
 * @param {HTMLElement} config.content  The scrolling sheet body.
 * @param {{ back: HTMLElement, cancel: HTMLButtonElement, save: HTMLButtonElement, title: HTMLElement,
 *     titleButton?: HTMLButtonElement|null, dirty: HTMLElement, more: HTMLElement }} config.controls
 * @param {(event: Event) => void} config.onBack
 * @param {() => void} config.onCancel
 * @param {() => void} config.onSave
 * @param {{ getValue: () => string, commit: (value: string) => void, onFinish?: (value: string) => void }} [config.rename]
 *     Inline title rename. The title button is only enabled while the state's mode is 'edit'.
 * @param {string[]} [config.overflowCandidates]  Toolbar selectors that may collapse into More, most expendable first.
 * @param {() => ActionSection[]} config.getActionSections  More-menu contents, built on every open.
 * @param {string|(() => string)} config.actionMenuTitle  A function defers translation to menu-open time.
 * @param {() => boolean} [config.isActive]  Skips layout work while the editor is off screen.
 */
export function mountEditorChrome(config) {
    const {
        root,
        header,
        toolbar,
        content,
        controls,
        onBack,
        onCancel,
        onSave,
        rename = null,
        overflowCandidates = [],
        getActionSections,
        actionMenuTitle,
        isActive = () => true,
    } = config;

    /** @type {Array<{ label: string, icon: string, element: HTMLElement }>} */
    let collapsed = [];
    /** @type {ChromeState|null} */
    let lastState = null;

    controls.back.addEventListener('click', onBack);
    controls.cancel.addEventListener('click', () => onCancel());
    controls.save.addEventListener('click', () => onSave());
    if (rename && controls.titleButton) {
        controls.titleButton.addEventListener('click', startRename);
    }

    controls.more.addEventListener('click', () => {
        if (controls.more.getAttribute('aria-expanded') === 'true') {
            closeActionMenu({ restoreFocus: true });
            return;
        }
        openMoreMenu();
    });

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

        controls.save.textContent = isCreate ? t`Create` : t`Save`;
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
            // DESIGN.md: state reveals are a fade with a small scale, no movement.
            if (prefersReducedMotion()) return;
            animateIn(controls.dirty,
                [{ opacity: 0, transform: 'scale(0.7)' }, { opacity: 1, transform: 'none' }],
                { duration: MOTION_FAST, easing: MOTION_EASE_OUT_QUAD },
            );
        }
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
            if (isActive()) applyOverflow();
        });
    }

    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(scheduleOverflow).observe(root);
    } else {
        window.addEventListener('resize', scheduleOverflow);
    }

    function openMoreMenu() {
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
        header.classList.toggle('sb-editor-chrome-hidden', hidden);
        toolbar.classList.toggle('sb-editor-chrome-hidden', hidden);
        // Collapsing at the bottom can clamp scrollTop on every frame of the
        // 200ms transition; don't read that as a user scroll the other way.
        if (changed) settleUntil = performance.now() + 250;
        lastScrollY = content.scrollTop;
        distance = 0;
    };
    const showChrome = () => setChromeHidden(false);

    mobile.addEventListener('change', showChrome);
    header.addEventListener('focusin', showChrome);
    toolbar.addEventListener('focusin', showChrome);

    content.addEventListener('scroll', () => {
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
            if (isActionMenuOpen() || header.querySelector(':focus-visible') || toolbar.querySelector(':focus-visible')) return;
            setChromeHidden(distance > 0);
        });
    }, { passive: true });

    return {
        render,
        scheduleOverflow,
        /** Reveal the header and toolbar; call when a session opens. */
        reset: showChrome,
    };
}

/** @type {JQuery|null} */
let recoveryToast = null;

/**
 * The draft-recovery toast both editors show when a session opens over a
 * stored backup that differs from the saved entity.
 * @param {{ ts: number }} draft
 * @param {{ restore: () => void, discard: () => void }} actions
 */
export function showDraftRecoveryToast(draft, actions) {
    if (recoveryToast) toastr.clear(recoveryToast, { force: true });

    const when = typeof moment !== 'undefined' ? moment(draft.ts).fromNow() : new Date(draft.ts).toLocaleTimeString();
    // <!-- HUMAN: replace toast body text -->
    const body = `<div>lorum ipsum ${when}</div>
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
            if (recoveryToast === toast) recoveryToast = null;
        },
    });
    recoveryToast = toast;

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

/** Dismiss the recovery toast, for example when its session closes. */
export function dismissDraftRecoveryToast() {
    if (recoveryToast) toastr.clear(recoveryToast, { force: true });
    recoveryToast = null;
}
