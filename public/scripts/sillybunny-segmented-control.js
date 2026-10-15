/**
 * Shared libadwaita-style segmented control (linked toggle buttons), built on
 * the theme's .sb-boolean-radio-group so radios give native arrow-key grouping.
 */

let groupCounter = 0;

/**
 * @template T
 * @param {string} groupLabel Accessible label for the group
 * @param {Array<[T, string]>} choices [value, label] pairs
 * @param {T} initialValue
 * @param {(value: T) => void} onChange
 * @param {{ compact?: boolean, detachFromForm?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function createSegmentedControl(groupLabel, choices, initialValue, onChange, options = {}) {
    const { compact = true, detachFromForm = false } = options;
    const group = document.createElement('div');
    group.className = 'sb-boolean-radio-group';
    if (compact) group.classList.add('sb-segmented-control--compact');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', groupLabel);

    const name = `sb-segmented-${++groupCounter}`;

    for (const [value, label] of choices) {
        const option = document.createElement('label');
        option.className = 'sb-boolean-radio-option';

        const input = document.createElement('input');
        input.type = 'radio';
        input.name = name;
        input.value = String(value);
        input.checked = String(value) === String(initialValue);
        // A present-but-empty form attribute leaves the control with no form
        // owner, so a UI-only toggle inside a <form> stays out of FormData.
        if (detachFromForm) input.setAttribute('form', '');
        input.addEventListener('change', () => {
            if (input.checked) onChange(value);
        });

        const text = document.createElement('span');
        text.textContent = label;

        option.append(input, text);
        group.append(option);
    }

    return group;
}

/**
 * Select the option whose value matches without firing onChange.
 * @param {HTMLElement} group
 * @param {unknown} value
 */
export function setSegmentedControlValue(group, value) {
    group.querySelectorAll('input[type="radio"]').forEach(input => {
        /** @type {HTMLInputElement} */ (input).checked = /** @type {HTMLInputElement} */ (input).value === String(value);
    });
}
