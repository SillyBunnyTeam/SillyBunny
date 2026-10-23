import { t } from '../i18n.js';
import { closeActionMenu } from '../sillybunny-action-menu.js';
import { closePicker } from './picker.js';
import { createSwitchRow, releaseRowIds } from './rows.js';
import { OVERLAY_SHEET_QUERY } from './breakpoints.js';
import { MODAL_ATTRIBUTE, releaseOverlayLayers } from './overlay-host.js';
import { bindHeaderLayout, bindKeyboardInset, bindSheetGestures } from './dialog.js';

/*
 * Frames upstream `Popup` dialogs in the shared Alert, Dialog and Window tiers (DESIGN.md Dialogs;
 * docs/dialogs.md). popup.js calls framePopup() from its constructor and the returned hooks from
 * show() and #hide(). Every public Popup element keeps its class and reference: .popup-content stays
 * in .popup-body, all responses stay in .popup-controls, and results are unchanged.
 * This module must not import popup.js.
 */

// POPUP_TYPE values (popup.js), duplicated to avoid an import cycle.
const TYPE_TEXT = 1;
const TYPE_INPUT = 3;
const TYPE_DISPLAY = 4;
const TYPE_CROP = 5;
const RESULT_CANCELLED = null;

const TIERS = new Set(['alert', 'dialog', 'window']);
const HEADING_SELECTOR = 'h2, h3, .popup-header';
const MEDIA_SELECTOR = 'img, svg, video, canvas, iframe, input, select, textarea, button';
let nextId = 0;

function isShown(node) {
    return node instanceof HTMLElement && node.style.display !== 'none' && !node.hidden;
}

function ensureId(node, prefix) {
    if (!node.id) node.id = `${prefix}-${++nextId}`;
    return node.id;
}

/** The first heading in `content`, when nothing visible comes before it. */
export function findLeadingHeading(content) {
    const candidate = content.querySelector(HEADING_SELECTOR);
    if (!candidate) return null;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && node !== candidate; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return null;
        if (node.nodeType === Node.ELEMENT_NODE && !node.contains(candidate) && node.matches(MEDIA_SELECTOR)) return null;
    }
    return candidate;
}

/**
 * Promotion rule (DESIGN.md Dialogs): an Alert becomes a Dialog when its content holds more than
 * one boolean control or any other control besides the main input and custom inputs, when it is an
 * INPUT with more than three rows, or when its content is taller than half the viewport.
 */
export function shouldPromoteAlert(popup) {
    const { content, inputControls } = popup;
    const booleans = content.querySelectorAll('input[type="checkbox"]').length
        + (inputControls?.querySelectorAll('input[type="checkbox"]').length ?? 0);
    if (booleans > 1) return true;
    if (content.querySelector('select, textarea, input:not([type="checkbox"], [type="hidden"], [type="button"], [type="submit"]), button, .menu_button, [role="button"]')) return true;
    if (popup.type === TYPE_INPUT && Number(popup.mainInput?.rows) > 3) return true;
    return content.scrollHeight > window.innerHeight * 0.5;
}

/**
 * Tier for a popup, or null when it keeps its own frame (crop, transparent, image zoom, swipe picker).
 * @param {object} popup
 * @param {'alert'|'dialog'|'window'|null} [explicit]
 */
export function resolvePopupTier(popup, explicit = null) {
    // DISPLAY has no responses, so it needs the header's Close even with an explicit Alert tier.
    if (TIERS.has(explicit)) return explicit === 'alert' && popup.type === TYPE_DISPLAY ? 'dialog' : explicit;
    const { dlg, content } = popup;
    if (popup.type === TYPE_CROP) return null;
    if (dlg.matches('.transparent_dialogue_popup, .swipe_picker_popup') || content.querySelector('.img_enlarged_container')) return null;
    if (dlg.classList.contains('large_dialogue_popup')) return 'window';
    if (dlg.matches('.wide_dialogue_popup, .wider_dialogue_popup')) return 'dialog';
    if (popup.type === TYPE_DISPLAY) return 'dialog';
    return shouldPromoteAlert(popup) ? 'dialog' : 'alert';
}

/** Turns custom-input checkboxes into switch rows that adopt the input (its id feeds inputResults). */
function convertCustomInputs(popup, grouped, cleanups) {
    const labels = [...popup.inputControls.querySelectorAll(':scope > label.checkbox_label')];
    if (!labels.length) return;
    const rows = labels.map(label => {
        const input = label.querySelector('input[type="checkbox"]');
        if (!input) return null;
        const caption = label.querySelector('span');
        const hint = [...label.querySelectorAll('[title]')].find(node => node !== input)?.getAttribute('title') ?? '';
        const result = createSwitchRow({ label: '', subtitle: hint || undefined, field: input.id, input });
        cleanups.push(() => result.destroy());
        if (caption) result.row.querySelector('.ds-row-label').replaceChildren(caption);
        label.replaceWith(result.row);
        return result.row;
    }).filter(Boolean);
    if (grouped && rows.length) {
        const group = document.createElement('div');
        group.className = 'ds-pref-group';
        rows[0].before(group);
        group.append(...rows);
    }
}

/**
 * An Alert's single boolean option (for example "Also delete the chat files") becomes a switch row in
 * the extra-child slot below the body, as AdwAlertDialog's extra child. The input is adopted, so
 * callers that read it by id keep working; its caption element moves with its i18n key.
 */
function adoptBooleanLabel(label, cleanups) {
    if (label.closest('form, .ds-row, .ds-pref-group, [role="row"], [data-sb-custom-form]')) return null;
    const inputs = label.querySelectorAll('input, select, textarea, button, a[href], [role="button"]');
    if (inputs.length !== 1 || !inputs[0].matches('input[type="checkbox"]') || inputs[0].parentElement !== label) return null;
    const [input] = inputs;
    const hint = label.getAttribute('title') ?? '';
    const caption = [...label.childNodes].filter(node => node !== input);
    const result = createSwitchRow({ label: '', subtitle: hint || undefined, field: input.id || 'popup-option', input });
    result.row.querySelector('.ds-row-label').replaceChildren(...caption);
    // Keep the label itself too: callers may bind input/change listeners to it rather than the input.
    label.classList.add(...result.row.classList);
    for (const attribute of result.row.attributes) {
        if (attribute.name !== 'class') label.setAttribute(attribute.name, attribute.value);
    }
    label.replaceChildren(...result.row.childNodes);
    cleanups.push(() => {
        result.destroy();
        // The factory row is empty now; the preserved label owns the adopted control IDs.
        releaseRowIds(label);
    });
    return label;
}

function adoptAlertOption(popup, cleanups) {
    const labels = popup.content.querySelectorAll('label.checkbox_label');
    if (labels.length !== 1) return;
    const row = adoptBooleanLabel(labels[0], cleanups);
    if (!row) return;
    const extra = document.createElement('div');
    extra.className = 'sb-dialog__extra';
    extra.append(row);
    popup.content.after(extra);
}

function layoutAlertResponses(controls, sheet) {
    controls.classList.remove('is-stacked');
    if (sheet) {
        controls.classList.add('is-stacked');
        return;
    }
    const buttons = [...controls.children].filter(isShown);
    if (buttons.length < 2) return;
    controls.classList.add('is-measuring');
    const widest = Math.max(0, ...buttons.map(button => button.getBoundingClientRect().width));
    const style = getComputedStyle(controls);
    const gap = parseFloat(style.columnGap) || 0;
    const available = controls.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    controls.classList.remove('is-measuring');
    if (widest * buttons.length + gap * (buttons.length - 1) > available + 1) controls.classList.add('is-stacked');
}

/** The Dialog or Window surface under `dlg`, if it is one (for page presentation). */
function findParentSurface(dlg) {
    const below = [...document.querySelectorAll('dialog[open]:not([closing])')].filter(node => node !== dlg).at(-1);
    if (!below) return null;
    if (below.matches('.sb-dialog-host:not([data-tier="alert"])')) return below.querySelector(':scope > .sb-dialog');
    if (below.matches('dialog.popup.sb-dialog:is(.sb-dialog--dialog, .sb-dialog--window)')) return below;
    return null;
}

/**
 * @param {object} popup A Popup instance (popup.js).
 * @param {{ tier?: 'alert'|'dialog'|'window'|null, title?: string|null, allowEscapeClose?: boolean }} [options]
 * @returns {{ opened: () => void, closing: () => void, dispose: () => void }}
 */
export function framePopup(popup, { tier = null, title = null, allowEscapeClose = true } = {}) {
    const { dlg } = popup;
    const cleanups = [];
    let parentSurface = null;
    let framed = false;

    function buildAlert() {
        const { body, content, buttonControls, closeButton } = popup;
        dlg.setAttribute('role', 'alertdialog');
        let heading = findLeadingHeading(content);
        if (title) {
            heading = document.createElement('h2');
            heading.textContent = title;
            body.prepend(heading);
        }
        if (heading) {
            heading.classList.add('sb-dialog__heading');
            dlg.setAttribute('aria-labelledby', ensureId(heading, 'sb-popup-heading'));
        }
        dlg.setAttribute('aria-describedby', ensureId(content, 'sb-popup-body'));
        adoptAlertOption(popup, cleanups);
        convertCustomInputs(popup, false, cleanups);
        body.after(buttonControls);
        closeButton.style.display = 'none';
    }

    function buildHeaderFrame() {
        const { content, buttonControls, okButton, cancelButton, closeButton } = popup;
        const header = document.createElement('header');
        header.className = 'sb-dialog__header';
        const titles = document.createElement('div');
        titles.className = 'sb-dialog__titles';
        header.append(titles);
        let heading = null;
        if (title) {
            heading = document.createElement('h2');
            heading.textContent = title;
        } else {
            heading = findLeadingHeading(content);
        }
        if (heading) {
            heading.classList.add('sb-dialog__title');
            titles.append(heading);
            dlg.setAttribute('aria-labelledby', ensureId(heading, 'sb-popup-title'));
        }
        convertCustomInputs(popup, true, cleanups);
        if (dlg.classList.contains('sb-dialog--dialog')) {
            for (const label of content.querySelectorAll('label.checkbox_label')) adoptBooleanLabel(label, cleanups);
        }

        // Extra responses (P-1): Cancel at the header start, the affirmative at the end, the rest below.
        const extras = [...buttonControls.querySelectorAll(':scope > .popup-button-custom')];
        let bar = null;
        if (extras.length) {
            bar = document.createElement('div');
            bar.className = 'sb-dialog__bottom-bar';
            extras[0].before(bar);
            bar.append(...extras);
        }

        const responses = [okButton, cancelButton].filter(isShown);
        const okOnly = popup.type === TYPE_TEXT && responses.length === 1 && responses[0] === okButton && !extras.length;
        header.append(buttonControls, closeButton);
        if (popup.type === TYPE_DISPLAY || okOnly || (!responses.length && !extras.length)) {
            closeButton.style.display = '';
            closeButton.classList.add('sb-dialog__close');
            closeButton.classList.replace('fa-circle-xmark', 'fa-xmark');
            if (okOnly) {
                // P-2: OK hides; the header Close returns OK's result so callers that check for it keep working.
                okButton.style.display = 'none';
                const forward = event => {
                    if (!(event.target instanceof Node) || !closeButton.contains(event.target)) return;
                    event.stopPropagation();
                    event.preventDefault();
                    okButton.click();
                };
                dlg.addEventListener('click', forward, true);
                cleanups.push(() => dlg.removeEventListener('click', forward, true));
            }
        } else {
            closeButton.style.display = 'none';
        }
        dlg.prepend(header);
        const contentScroller = dlg.querySelector('.popup-content');
        const syncHeaderShade = () => header.toggleAttribute('data-scrolled', contentScroller?.scrollTop > 0);
        contentScroller?.addEventListener('scroll', syncHeaderShade, { passive: true });
        cleanups.push(() => contentScroller?.removeEventListener('scroll', syncHeaderShade));
        cleanups.push(bindHeaderLayout(header));
        if (bar) {
            // The footer stays inside buttonControls for extension queries and custom autofocus.
            // Reserve its measured height so it never covers the body's scrolling content.
            const syncBar = () => dlg.style.setProperty('--sb-popup-response-height', `${bar.offsetHeight}px`);
            syncBar();
            const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncBar);
            observer?.observe(bar);
            cleanups.push(() => observer?.disconnect());
        }
    }

    function presentAsPage() {
        parentSurface = findParentSurface(dlg);
        if (!parentSurface) return;
        dlg.classList.add('sb-dialog--page');
        const wasInert = parentSurface.inert;
        parentSurface.inert = true;
        const place = () => {
            const rect = parentSurface.getBoundingClientRect();
            for (const [name, value] of Object.entries({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })) {
                dlg.style.setProperty(`--sb-page-${name}`, `${Math.round(value)}px`);
            }
        };
        place();
        parentSurface.setAttribute('data-sb-covered', '');
        window.addEventListener('resize', place, { passive: true });
        cleanups.push(() => {
            window.removeEventListener('resize', place);
            parentSurface?.removeAttribute('data-sb-covered');
            if (parentSurface) parentSurface.inert = wasInert;
        });
        const close = popup.closeButton;
        if (close.style.display !== 'none') {
            // P-4: an immediate-apply page shows Back at the start instead of Close.
            close.classList.replace('fa-xmark', 'fa-arrow-left');
            close.title = t`Back`;
            close.setAttribute('aria-label', close.title);
            close.classList.add('sb-dialog__back');
        }
    }

    function opened() {
        const resolved = resolvePopupTier(popup, tier);
        if (!resolved) return;
        framed = true;
        dlg.classList.add('sb-dialog', `sb-dialog--${resolved}`);
        // SillyBunny: document windows (maximized editors, notes, inspectors, debugger output)
        // use a View body instead of a Window body.
        if (resolved === 'window' && dlg.querySelector('.sb-document')) {
            dlg.classList.add('sb-dialog--view');
        }
        dlg.setAttribute(MODAL_ATTRIBUTE, '');
        if (resolved === 'alert') buildAlert();
        else buildHeaderFrame();
        const handle = document.createElement('div');
        handle.className = 'sb-dialog__handle';
        handle.setAttribute('aria-hidden', 'true');
        dlg.append(handle);

        const query = window.matchMedia?.(OVERLAY_SHEET_QUERY) ?? { matches: false, addEventListener() {}, removeEventListener() {} };
        const isSheet = () => query.matches && !dlg.classList.contains('sb-dialog--page');
        const sync = () => {
            dlg.dataset.presentation = isSheet() ? 'sheet' : 'floating';
            if (resolved === 'alert') layoutAlertResponses(popup.buttonControls, isSheet());
        };
        if (resolved !== 'alert') presentAsPage();
        sync();
        let backdropPress = null;
        const isBackdropEvent = event => {
            if (event.target !== dlg || dlg.dataset.presentation !== 'floating' || dlg.classList.contains('sb-dialog--page') || !allowEscapeClose) return false;
            const rect = dlg.getBoundingClientRect();
            return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
        };
        const onBackdropDown = event => {
            backdropPress = event.isPrimary && event.button === 0 && isBackdropEvent(event)
                ? { pointerId: event.pointerId, released: false } : null;
        };
        const onBackdropUp = event => {
            if (!backdropPress) return;
            if (event.pointerId !== backdropPress.pointerId || event.button !== 0 || !isBackdropEvent(event)) {
                backdropPress = null;
                return;
            }
            backdropPress.released = true;
        };
        const onBackdropCancel = () => { backdropPress = null; };
        const onBackdropClick = event => {
            const press = backdropPress;
            backdropPress = null;
            if (!press?.released || event.button !== 0 || !isBackdropEvent(event)) return;
            // Older WebKit emits MouseEvent clicks without a pointerId.
            if ('pointerId' in event && event.pointerId !== press.pointerId) return;
            // Reuse Popup's cancel listener so its result and onClosing veto remain authoritative.
            dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
        };
        dlg.addEventListener('pointerdown', onBackdropDown);
        dlg.addEventListener('pointerup', onBackdropUp);
        dlg.addEventListener('pointercancel', onBackdropCancel);
        dlg.addEventListener('click', onBackdropClick);
        cleanups.push(() => {
            dlg.removeEventListener('pointerdown', onBackdropDown);
            dlg.removeEventListener('pointerup', onBackdropUp);
            dlg.removeEventListener('pointercancel', onBackdropCancel);
            dlg.removeEventListener('click', onBackdropClick);
        });
        query.addEventListener('change', sync);
        window.addEventListener('resize', sync, { passive: true });
        cleanups.push(() => {
            query.removeEventListener('change', sync);
            window.removeEventListener('resize', sync);
        });

        cleanups.push(bindSheetGestures({
            surface: dlg,
            targets: [dlg],
            startSelector: '.sb-dialog__handle, .sb-dialog__header, .sb-dialog__heading',
            isActive: isSheet,
            requestClose: offset => {
                if (!allowEscapeClose) return false;
                dlg.style.setProperty('--sb-dialog-drag-offset', `${offset}px`);
                return Promise.resolve(popup.complete(RESULT_CANCELLED)).then(value => {
                    if (value !== undefined) return true;
                    dlg.style.removeProperty('--sb-dialog-drag-offset');
                    return false;
                });
            },
        }));
        cleanups.push(bindKeyboardInset(dlg));
        // Moving controls into the header/body can change the native autofocus target. Re-apply the
        // Popup contract after framing so destructive Alerts focus Cancel and INPUTs focus their field.
        popup.setAutoFocus?.();
    }

    function closing() {
        if (!framed) return;
        if (dlg.querySelector('[data-sb-overlay-layer]')) {
            closeActionMenu({ animate: false });
            closePicker({ animate: false, restoreFocus: false });
        }
        releaseOverlayLayers(dlg);
    }

    function dispose() {
        parentSurface?.removeAttribute('data-sb-covered');
        for (const cleanup of cleanups.splice(0)) cleanup();
    }

    return { opened, closing, dispose };
}
