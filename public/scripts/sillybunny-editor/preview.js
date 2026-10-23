// SillyBunny: shared Edit/Preview toggle machinery for explicit-save editors.
// Finds existing toggle placeholders, mounts segmented controls, preserves
// source height when switching to preview, resets to Edit on session open.

import { createSegmentedControl, setSegmentedControlValue } from '../sillybunny-segmented-control.js';
import { t } from '../i18n.js';
import { animateHeightFrom, animateIn, MOTION_EASE_OUT_QUAD, MOTION_FAST, stopMotion } from '../sillybunny-motion.js';

/**
 * Mount Edit/Preview toggles in the given root.
 * @param {HTMLElement} root  Editor panel root
 * @param {(textarea: HTMLTextAreaElement, pane: HTMLElement) => void} renderPreview  Render preview HTML
 * @returns {{ reset: () => void, dispose: () => void }}
 */
export function mountEditorPreviews(root, renderPreview) {
    const pairs = [];

    /**
     * Find all placeholders and mount segmented controls.
     */
    function mount() {
        root.querySelectorAll('.sb-preview-toggle[data-sb-preview-for]').forEach(placeholder => {
            const textareaId = /** @type {HTMLElement} */ (placeholder).dataset.sbPreviewFor;
            const textarea = /** @type {HTMLTextAreaElement|null} */ (root.querySelector(`#${CSS.escape(textareaId)}`));
            const pane = /** @type {HTMLElement|null} */ (root.querySelector(`.sb-preview-pane[data-sb-preview-pane="${textareaId}"]`));
            if (!textarea || !pane) return;

            const segment = createSegmentedControl(
                t`Edit / Preview`,
                [[false, t`Edit`], [true, t`Preview`]],
                false,
                showPreview => setFieldPreview(textarea, pane, showPreview),
                { compact: true, detachFromForm: true },
            );
            segment.dataset.sbSegmentFor = textareaId;
            placeholder.replaceWith(segment);

            $(textarea).on('input.sb-preview', () => {
                if (!pane.hidden) renderPreview(textarea, pane);
            });

            pairs.push({ segment, textarea, pane });
        });
    }

    /**
     * Toggle between Edit and Preview modes for one textarea/pane pair.
     */
    function setFieldPreview(textarea, pane, showPreview) {
        const wrapper = textarea.closest('.ds-field');
        const previousHeight = wrapper?.getBoundingClientRect().height;
        const current = showPreview ? textarea : pane;
        const next = showPreview ? pane : textarea;
        if (showPreview) {
            // Measure before hiding the source so the replacement keeps its resized height.
            pane.style.height = `${textarea.getBoundingClientRect().height}px`;
            renderPreview(textarea, pane);
        }
        // Already in the requested mode (e.g. reset on load): nothing to fade.
        if (current.hidden && !next.hidden) return;
        // The panes stack in flow, so the outgoing one leaves at once; fading both would
        // briefly double the field's height. The incoming pane carries the crossfade.
        stopMotion(current);
        current.hidden = true;
        next.hidden = false;
        animateIn(next, [{ opacity: 0 }, { opacity: 1 }], {
            duration: MOTION_FAST,
            easing: MOTION_EASE_OUT_QUAD,
        });
        if (wrapper && Number.isFinite(previousHeight)) {
            animateHeightFrom(wrapper, previousHeight, { duration: MOTION_FAST });
        }
    }

    /**
     * Reset all toggles to Edit mode.
     */
    function reset() {
        for (const { segment, textarea, pane } of pairs) {
            setSegmentedControlValue(segment, false);
            stopMotion(textarea);
            stopMotion(pane);
            pane.hidden = true;
            textarea.hidden = false;
        }
    }

    /**
     * Unmount and clean up.
     */
    function dispose() {
        for (const { textarea } of pairs) {
            $(textarea).off('.sb-preview');
        }
        pairs.length = 0;
    }

    mount();

    return { reset, dispose };
}
