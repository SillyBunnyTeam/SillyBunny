const TONES = Object.freeze(['success', 'neutral']);

/**
 * A small rounded label that states a condition. The text is always there, so the condition never rests on the colour
 * and the icon alone: `success` adds a check as well, `neutral` is the text on a quiet tint.
 * @param {object} options
 * @param {string} options.label The text of the chip.
 * @param {'success' | 'neutral'} options.tone
 * @returns {HTMLSpanElement}
 */
export function createStatusChip({ label, tone }) {
    if (!TONES.includes(tone)) {
        throw new TypeError(`Unknown status chip tone: ${String(tone)}`);
    }

    const chip = document.createElement('span');
    chip.className = 'sbStatusChip';
    chip.dataset.sbTone = tone;
    if (tone === 'success') {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-check';
        icon.setAttribute('aria-hidden', 'true');
        chip.append(icon);
    }
    chip.append(label);
    return chip;
}
