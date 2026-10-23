/** Boxed-list row with an exclusive segmented choice (AdwToggleGroup: radio semantics, neutral selected fill). */
import { createSegmentedControl } from '../sillybunny-segmented-control.js';
import { createRow } from './rows.js';

let nextId = 0;

/**
 * Labels arrive translated. Segments are labels only (HIG UI Icons: a label or an icon, not both).
 * @template T
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {Array<[T, string]>} options.choices  Two or more [value, label] pairs.
 * @param {T} options.value
 * @param {string} [options.id]
 * @param {string} [options.subtitle]
 * @param {boolean} [options.fill=false]  Title above full-width segments that may wrap their labels.
 * @param {(value: T) => void} [options.onChange]
 * @returns {object}
 */
export function createToggleRow({ label, subtitle, field, id, choices, value, fill = false, onChange }) {
    if (!Array.isArray(choices) || choices.length < 2) throw new RangeError('A toggle row needs at least two choices.');
    const group = createSegmentedControl(label, choices, value, chosen => onChange?.(chosen), { compact: true, detachFromForm: true });
    group.classList.add('ds-toggle-row__group');
    if (fill) group.classList.add('ds-toggle-row__group--fill');
    const base = createRow({ label, subtitle, field, id, suffix: group, stacked: fill });
    base.row.classList.add('ds-toggle-row');
    const caption = base.row.querySelector('.ds-row-label');
    caption.id ||= `sb-toggle-row-label-${++nextId}`;
    group.setAttribute('role', 'radiogroup');
    group.removeAttribute('aria-label');
    group.setAttribute('aria-labelledby', caption.id);
    const inputs = [...group.querySelectorAll('input[type="radio"]')];
    const description = base.row.querySelector('.ds-row-subtitle');
    if (description) {
        description.id ||= `sb-toggle-row-description-${nextId}`;
        group.setAttribute('aria-describedby', description.id);
    }

    const getValue = () => {
        const index = inputs.findIndex(input => input.checked);
        return index < 0 ? null : choices[index][0];
    };
    return {
        ...base,
        group,
        getValue,
        setValue(next, { silent = true } = {}) {
            inputs.forEach((input, index) => {
                input.checked = Object.is(choices[index][0], next) || String(choices[index][0]) === String(next);
            });
            if (!silent && getValue() !== null) onChange?.(getValue());
        },
        setDisabled(disabled) {
            const insensitive = Boolean(disabled);
            inputs.forEach(input => { input.disabled = insensitive; });
            base.row.setAttribute('aria-disabled', String(insensitive));
            base.row.classList.toggle('is-insensitive', insensitive);
        },
    };
}
